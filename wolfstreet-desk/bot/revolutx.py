"""Client per la REST API di Revolut X (spot crypto).

Firma Ed25519 su:  timestamp(ms) + METODO + /api/1.0/path + query(senza ?) + body(JSON minificato)
Fonte: revolut-engineering/revolut-x-api (revolut-x-api-for-llm.md), verificata ottobre 2026.

Regole di sicurezza del client:
- un ordine NON viene mai ritentato in automatico (retries=0): il client_order_id lo genera
  e lo salva chi chiama, PRIMA dell'invio, così un ordine incerto si ritrova e non si duplica;
- dopo l'invio, un 404 su GET /orders/{id} è normale per qualche secondo: si riprova e poi
  si cerca l'ordine per client_order_id in /orders/active e /orders/historical.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from decimal import ROUND_DOWN, Decimal
from urllib.parse import quote

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE_URL = os.getenv("REVOLUTX_API_URL", "https://revx.revolut.com")
CANDLES_PER_REQUEST = 100  # la documentazione limita (until - since) / interval a 100 candele
FINAL_STATES = ("filled", "cancelled", "canceled", "rejected", "replaced")


class RevolutXError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


def load_private_key(raw: str) -> Ed25519PrivateKey:
    """Accetta una chiave PEM (PKCS8) oppure il seed di 32 byte in base64."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("Chiave privata Revolut X mancante (secret REVX_PRIVATE_KEY).")
    # I secret incollati dal telefono a volte perdono gli a-capo: li ricostruiamo.
    if "BEGIN" in raw:
        body = raw.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "")
        body = "".join(body.split())
        lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
        key = serialization.load_pem_private_key(
            f"-----BEGIN PRIVATE KEY-----\n{lines}\n-----END PRIVATE KEY-----\n".encode(), password=None)
    else:
        seed = base64.b64decode(raw)
        if len(seed) != 32:
            raise ValueError("Il seed base64 deve essere di 32 byte.")
        key = Ed25519PrivateKey.from_private_bytes(seed)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("La chiave privata non è Ed25519.")
    return key


def sign(key: Ed25519PrivateKey, timestamp: str, method: str, path: str, query: str = "", body: str = "") -> str:
    message = f"{timestamp}{method.upper()}{path}{query}{body}"
    return base64.b64encode(key.sign(message.encode("utf-8"))).decode()


def to_dash(symbol: str) -> str:
    return symbol.replace("/", "-").upper()


def floor_step(value, step: str) -> str:
    v, s = Decimal(str(value)), Decimal(step)
    return format(((v / s).to_integral_value(rounding=ROUND_DOWN) * s).quantize(s), "f")


def key_fingerprint(api_key: str) -> str:
    """Impronta corta della API key: serve a capire se la chiave è cambiata dopo l'armamento LIVE."""
    return hashlib.sha256((api_key or "").strip().encode()).hexdigest()[:12]


def order_status(o: dict | None) -> str:
    return str((o or {}).get("status") or (o or {}).get("state") or "").lower()


class RevolutX:
    def __init__(self, api_key: str, private_key: str, base_url: str = BASE_URL, timeout: int = 20):
        if not (api_key or "").strip():
            raise ValueError("API key Revolut X mancante (secret REVX_API_KEY).")
        self.api_key = api_key.strip()
        self.key = load_private_key(private_key)
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.s = requests.Session()
        self.sleep = time.sleep  # sostituibile nei test

    @property
    def fingerprint(self) -> str:
        return key_fingerprint(self.api_key)

    # ------------------------------------------------------------------ core
    def _request(self, method: str, path: str, params: dict | None = None, body: dict | None = None, retries: int = 3):
        items = sorted((k, str(v)) for k, v in (params or {}).items() if v is not None)
        query = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in items)
        body_str = json.dumps(body, separators=(",", ":")) if body is not None else ""
        full_path = f"/api/1.0{path}"
        url = f"{self.base}{full_path}" + (f"?{query}" if query else "")
        last = None
        for attempt in range(retries + 1):
            ts = str(int(time.time() * 1000))
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Revx-API-Key": self.api_key,
                "X-Revx-Timestamp": ts,
                "X-Revx-Signature": sign(self.key, ts, method, full_path, query, body_str),
            }
            try:
                r = self.s.request(method, url, data=body_str or None, headers=headers, timeout=self.timeout)
            except requests.RequestException as e:
                last = RevolutXError(0, type(e).__name__)
                if attempt < retries:
                    self.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                last = RevolutXError(r.status_code, (r.text or "")[:200])
                if attempt < retries:
                    wait = float(r.headers.get("Retry-After", 1000)) / 1000 if r.status_code == 429 else 1.5 * (attempt + 1)
                    self.sleep(min(wait, 10))
                continue
            if not r.ok:
                try:
                    msg = r.json().get("message") or r.text
                except Exception:
                    msg = r.text
                raise RevolutXError(r.status_code, str(msg)[:300])
            return r.json() if r.content else None
        raise last or RevolutXError(0, "richiesta fallita")

    @staticmethod
    def _data(payload):
        return payload.get("data", payload) if isinstance(payload, dict) else payload

    # ------------------------------------------------------------ account
    def balances(self) -> dict[str, dict]:
        return {b["currency"]: b for b in self._data(self._request("GET", "/balances")) or []}

    def pairs(self) -> dict:
        return self._data(self._request("GET", "/configuration/pairs")) or {}

    # -------------------------------------------------------- market data
    def tickers(self, symbols: list[str]) -> dict[str, dict]:
        data = self._request("GET", "/tickers", {"symbols": ",".join(to_dash(s) for s in symbols)})
        return {to_dash(t["symbol"]): t for t in self._data(data) or []}

    def candles(self, symbol: str, interval: int = 240, count: int = 300, until_ms: int | None = None) -> list[dict]:
        """Ultime `count` candele. L'API ne restituisce al massimo 100 per richiesta:
        si leggono finestre consecutive all'indietro e si uniscono."""
        until = until_ms or int(time.time() * 1000)
        step = CANDLES_PER_REQUEST * interval * 60_000
        out: dict[int, dict] = {}
        for _ in range((count + CANDLES_PER_REQUEST - 1) // CANDLES_PER_REQUEST):
            since = until - step
            rows = self._data(self._request("GET", f"/candles/{to_dash(symbol)}",
                                            {"interval": interval, "since": since, "until": until})) or []
            for c in rows:
                out[int(c["start"])] = c
            if not rows:
                break
            until = since
        return [out[k] for k in sorted(out)]

    # ----------------------------------------------------------------- orders
    def market_order(self, symbol: str, side: str, client_order_id: str, *,
                     quote_size: str | None = None, base_size: str | None = None) -> dict:
        if not client_order_id:
            raise ValueError("client_order_id obbligatorio: va generato e salvato prima dell'invio")
        if bool(quote_size) == bool(base_size):
            raise ValueError("serve esattamente uno tra quote_size e base_size")
        body = {
            "client_order_id": client_order_id,
            "symbol": to_dash(symbol),
            "side": side.lower(),
            "order_configuration": {"market": {"quote_size": quote_size} if quote_size else {"base_size": base_size}},
        }
        return self._data(self._request("POST", "/orders", body=body, retries=0)) or {}

    def get_order(self, venue_order_id: str) -> dict:
        return self._data(self._request("GET", f"/orders/{venue_order_id}")) or {}

    def cancel_order(self, venue_order_id: str) -> None:
        self._request("DELETE", f"/orders/{venue_order_id}", retries=0)

    def find_order(self, client_order_id: str, symbol: str, since_ms: int) -> dict | None:
        """Cerca un ordine per client_order_id tra attivi e storici (finestra massima 1 settimana)."""
        sym = to_dash(symbol)
        for path, params in (
            ("/orders/active", {"symbols": sym}),
            ("/orders/historical", {"symbols": sym, "start_date": max(0, since_ms - 60_000),
                                    "end_date": min(since_ms + 7 * 86_400_000 - 1, int(time.time() * 1000) + 60_000)}),
        ):
            cursor = None
            for _ in range(10):
                q = dict(params, **({"cursor": cursor} if cursor else {}))
                payload = self._request("GET", path, q) or {}
                for o in self._data(payload) or []:
                    if o.get("client_order_id") == client_order_id:
                        return o
                cursor = (payload.get("metadata") or {}).get("next_cursor") if isinstance(payload, dict) else None
                if not cursor:
                    break
        return None

    def wait_final(self, venue_order_id: str | None, client_order_id: str, symbol: str, since_ms: int,
                   tries: int = 8) -> dict | None:
        """Aspetta lo stato finale. Ritorna l'ordine oppure None se resta introvabile/non confermato."""
        order = None
        for i in range(tries):
            try:
                if venue_order_id:
                    order = self.get_order(venue_order_id)
                else:
                    order = self.find_order(client_order_id, symbol, since_ms)
            except RevolutXError as e:
                if e.status not in (0, 404):
                    raise
                order = None
            if order and order_status(order) in FINAL_STATES:
                return order
            self.sleep(min(1 + i, 5))
        try:
            found = self.find_order(client_order_id, symbol, since_ms)
        except RevolutXError:
            found = None
        if found and order_status(found) in FINAL_STATES:
            return found
        return None
