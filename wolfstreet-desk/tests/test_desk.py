"""Test del desk. Esegui:  python -m pytest -q"""
import base64
import itertools
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from bot import ai, backtest, office, safety
from bot import indicators as ind
from bot import strategy as st
from bot.revolutx import (
    RevolutX,
    RevolutXError,
    floor_step,
    key_fingerprint,
    load_private_key,
    sign,
)

FIX = ROOT / "tests" / "fixtures"
CFG = json.loads((ROOT / "config.json").read_text())
PAIRS_CFG = {s.replace("-", "/"): {"base_step": "0.00000001", "quote_step": "0.01", "min_order_size_quote": "0.1",
                                   "status": "active"} for s in CFG["pairs"]}


def pem():
    k = Ed25519PrivateKey.generate()
    return k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                           serialization.NoEncryption()).decode()


# ------------------------------------------------------------------ firma e client
@pytest.mark.skipif(not shutil.which("node"), reason="node non installato")
def test_signature_matches_official_node_signer():
    p = pem()
    args = ["1765360896219", "POST", "/api/1.0/orders", "",
            '{"client_order_id":"x","symbol":"BTC-EUR","side":"buy","order_configuration":{"market":{"quote_size":"10"}}}']
    py = sign(load_private_key(p), *args)
    js = ("const c=require('crypto');const [t,m,p,q,b]=JSON.parse(process.env.A);"
          "process.stdout.write(c.sign(null,Buffer.from(t+m.toUpperCase()+p+q+b,'utf-8'),c.createPrivateKey(process.env.K)).toString('base64'))")
    env = {"PATH": __import__("os").environ["PATH"], "K": p, "A": json.dumps(args)}
    assert py == subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True, env=env).stdout


def test_private_key_pasted_on_one_line():
    p = pem()
    assert sign(load_private_key(p.replace("\n", " ")), "1", "GET", "/x") == sign(load_private_key(p), "1", "GET", "/x")


class Resp:
    def __init__(self, status=200, payload=None):
        self.status_code, self.ok = status, 200 <= status < 300
        self._p = payload if payload is not None else {"data": []}
        self.content = json.dumps(self._p).encode()
        self.text, self.headers = self.content.decode(), {}

    def json(self):
        return self._p


def make_client(handler):
    c = RevolutX("k" * 64, pem())
    c.sleep = lambda s: None
    seen = []

    def fake(method, url, data=None, headers=None, timeout=None):
        seen.append({"method": method, "url": url, "data": data, "headers": headers})
        return handler(method, url, data)
    c.s.request = fake
    return c, seen


def test_request_is_signed_like_api_expects():
    c, seen = make_client(lambda m, u, d: Resp(200, {"data": {"venue_order_id": "v1"}} if m == "POST" else {"data": []}))
    c.tickers(["BTC/EUR", "ETH-EUR"])
    assert seen[0]["url"] == "https://revx.revolut.com/api/1.0/tickers?symbols=BTC-EUR%2CETH-EUR"
    h = seen[0]["headers"]
    c.key.public_key().verify(base64.b64decode(h["X-Revx-Signature"]),
                              f'{h["X-Revx-Timestamp"]}GET/api/1.0/tickerssymbols=BTC-EUR%2CETH-EUR'.encode())
    c.market_order("BTC-EUR", "BUY", "coid-1", quote_size="10.00")
    body = json.loads(seen[-1]["data"])
    assert body == {"client_order_id": "coid-1", "symbol": "BTC-EUR", "side": "buy",
                    "order_configuration": {"market": {"quote_size": "10.00"}}}
    assert ", " not in seen[-1]["data"]  # JSON minificato, come richiesto dalla firma


def test_order_requires_client_order_id_and_is_never_retried():
    c, seen = make_client(lambda m, u, d: Resp(503, {"message": "down"}))
    with pytest.raises(ValueError):
        c.market_order("BTC-EUR", "buy", "", quote_size="5")
    with pytest.raises(RevolutXError):
        c.market_order("BTC-EUR", "buy", "coid", quote_size="5")
    assert len(seen) == 1  # un solo tentativo, mai un secondo ordine


def test_candles_are_paged_to_get_enough_history():
    """L'API dà al massimo 100 candele per richiesta: per EMA200 ne servono 300 → 3 finestre contigue."""
    def handler(m, url, d):
        q = dict(p.split("=") for p in url.split("?")[1].split("&"))
        since, until, iv = int(q["since"]), int(q["until"]), int(q["interval"]) * 60_000
        return Resp(200, {"data": [{"start": t, "open": "1", "high": "1", "low": "1", "close": "1", "volume": "1"}
                                   for t in range(since, until, iv)]})
    c, seen = make_client(handler)
    rows = c.candles("BTC-EUR", 240, count=300, until_ms=1_800_000_000_000)
    assert len(seen) == 3 and len(rows) == 300
    starts = [r["start"] for r in rows]
    assert starts == sorted(set(starts)) and all(b - a == 240 * 60_000 for a, b in itertools.pairwise(starts))


def test_wait_final_tolerates_404_and_finds_by_client_order_id():
    """Il bug del 9 ottobre: GET /orders/{id} dava 404 per qualche secondo dopo l'ordine."""
    def handler(m, url, d):
        if "/orders/v1" in url:
            return Resp(404, {"message": "not found"})
        if "/orders/historical" in url:
            return Resp(200, {"data": [{"client_order_id": "c1", "status": "filled", "filled_quantity": "0.001"}]})
        return Resp(200, {"data": []})
    c, _ = make_client(handler)
    o = c.wait_final("v1", "c1", "BTC-EUR", 1_800_000_000_000, tries=2)
    assert o and o["status"] == "filled"


def test_floor_step_and_fingerprint():
    assert floor_step(10.239, "0.01") == "10.23"
    assert floor_step("0.123456789", "0.00001") == "0.12345"
    assert key_fingerprint("a") != key_fingerprint("b") and len(key_fingerprint("a")) == 12


# ------------------------------------------------------------------ indicatori
def test_rsi_no_losses_is_100_not_nan():
    r = ind.rsi([float(i) for i in range(1, 40)], 14)
    assert r[-1] == 100.0 and r[5] is None


def test_no_lookahead_resistance():
    assert ind.rolling_max_prev([1, 2, 3, 10, 4], 2)[3] == 3


# ------------------------------------------------------------------ regole di sicurezza
def test_config_cannot_exceed_hard_caps():
    cfg, notes = safety.clamp_config({**CFG, "max_open_positions": 5, "max_position_pct": 80, "max_risk_pct": 10, "stop_atr": 0.2})
    assert cfg["max_open_positions"] == 2 and cfg["max_position_pct"] == 30 and cfg["max_risk_pct"] == 1.5
    assert cfg["stop_atr"] == 1.0 and len(notes) == 4
    with pytest.raises(ValueError):
        safety.clamp_config({**CFG, "daily_loss_limit_eur": 0})


def test_risk_per_trade_is_capped_at_1_5_percent():
    sig = {"price": 100.0, "ind": {"atr": 1.0}}
    cfg, _ = safety.clamp_config({**CFG, "risk_per_trade_eur": 5})
    eur, why = st.size_position(sig, 40, 40, cfg)
    assert "Rischio 0.60€" in why  # 1,5% di 40 €
    assert eur <= 40 * 0.30 + 1e-9


@pytest.mark.parametrize("ctl,secret,fp,expected", [
    ({"mode": "shadow"}, True, "x", "shadow"),
    ({"mode": "paper"}, True, "x", "paper"),
    ({"mode": "boh"}, True, "x", "shadow"),
    ({"mode": "live"}, True, "x", "shadow"),                                             # non armato
    ({"mode": "live", "live_armed": True, "armed_key": "x"}, False, "x", "shadow"),       # senza secret
    ({"mode": "live", "live_armed": True, "armed_key": "x", "kill_switch": True}, True, "x", "shadow"),
    ({"mode": "live", "live_armed": True, "armed_key": "old"}, True, "new", "shadow"),   # chiave cambiata
    ({"mode": "live", "live_armed": True, "armed_key": "x"}, True, "x", "live"),
])
def test_live_needs_every_lock(ctl, secret, fp, expected):
    assert safety.resolve_mode(ctl, secret, fp)[0] == expected


# ------------------------------------------------------------------ IA fail-closed
def test_ai_fail_closed(monkeypatch):
    sig = {"symbol": "BTC-EUR", "price": 1.0, "score": 90, "reasons": [], "ind": {"atr": 0.1}}
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ai.review(sig, CFG) is None                         # IA non configurata: decidono le regole
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")

    class Boom:
        class messages:
            @staticmethod
            def create(**kw): raise TimeoutError()
    assert ai.review(sig, CFG, client=Boom)["verdict"] == "VETO"

    def client_returning(stop, text):
        resp = SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=text)])
        return SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: resp))
    assert ai.review(sig, CFG, client=client_returning("refusal", ""))["verdict"] == "VETO"
    assert ai.review(sig, CFG, client=client_returning("end_turn", "boh"))["verdict"] == "VETO"
    ok = ai.review(sig, CFG, client=client_returning("end_turn", '{"verdict":"APPROVA","reason":"ok"}'))
    assert ok == {"verdict": "APPROVA", "reason": "ok"}


# ------------------------------------------------------------------ ufficio su candele reali
def load(sym):
    return st.aggregate(st.normalize(json.loads((FIX / f"{sym}_1h.json").read_text())), CFG["interval_min"])


class FakeRevolutX:
    """Rigioca candele reali Revolut X come se fossero l'API, avanzando nel tempo."""
    fingerprint = "fp-test"

    def __init__(self, orders_ok=True):
        self.data = {s: load(s) for s in ("BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR")}
        self.now = 0
        self.orders, self.orders_ok, self.history = [], orders_ok, []

    def visible(self, s):
        return [c for c in self.data[s] if c["t"] <= self.now]

    def tickers(self, pairs):
        out = {}
        for s in pairs:
            px = self.visible(s)[-1]["c"]
            out[s] = {"bid": str(px * 0.9997), "ask": str(px * 1.0003), "last_price": str(px), "price_change_24h": "0"}
        return out

    def candles(self, s, interval, count=300):
        return [{"start": int(c["t"] * 1000), "open": c["o"], "high": c["h"], "low": c["l"], "close": c["c"], "volume": c["v"]}
                for c in self.visible(s)][-count:]

    def pairs(self):
        return PAIRS_CFG

    def balances(self):
        return {"EUR": {"available": "100"}, **{s.split("-")[0]: {"available": "1000000"} for s in self.data}}

    def market_order(self, symbol, side, coid, **size):
        self.orders.append((symbol, side, coid, size))
        if not self.orders_ok:
            raise RevolutXError(0, "ConnectionError")  # timeout: l'ordine potrebbe essere partito
        px = float(self.tickers([symbol])[symbol]["ask" if side == "buy" else "bid"])
        q = float(size.get("quote_size") or 0) / px if side == "buy" else float(size["base_size"])
        o = {"client_order_id": coid, "status": "filled", "filled_quantity": str(q),
             "filled_amount": str(q * px), "average_fill_price": str(px)}
        self.history.append(o)
        return {"venue_order_id": coid, "client_order_id": coid, "state": "new"}

    def wait_final(self, vid, coid, symbol, since_ms, tries=8):
        return next((o for o in self.history if o["client_order_id"] == coid), None)

    def find_order(self, coid, symbol, since_ms):
        return next((o for o in self.history if o["client_order_id"] == coid), None)


def replay(control, every=2, live_secret=False, **kw):
    fake = FakeRevolutX(**kw)
    state = {}
    times = [c["t"] for c in fake.data["BTC-EUR"]][300::every]
    snap = None
    for t in times:
        fake.now = t + 1
        snap = office.Office(fake, CFG, control, state, now=t + 1, live_secret=live_secret, ai_review=lambda s, c: None).run()
    return fake, state, snap, times


def test_paper_replay_runs_and_trades():
    fake, state, snap, times = replay({"mode": "paper"})
    book = state["books"]["paper"]
    assert state["runs"] == len(times) and len(book["closed"]) > 0
    assert not fake.orders, "in PAPER non deve partire nessun ordine vero"
    assert abs(snap["kpi"]["equity"] - (book["cash"] + sum(p["value"] for p in snap["positions"]))) < 1e-6
    assert len(book["positions"]) <= 2
    json.dumps(snap)


def test_shadow_records_decisions_without_orders_or_portfolio():
    fake, state, snap, _ = replay({"mode": "shadow"})
    assert not fake.orders
    assert state["books"]["paper"]["closed"] == [] and state["books"]["live"]["closed"] == []
    assert state.get("shadow"), "lo shadow deve registrare cosa avrebbe comprato"
    assert snap["mode"] == "shadow"


def test_live_not_armed_never_sends_orders():
    fake, _, snap, _ = replay({"mode": "live"}, live_secret=True)
    assert not fake.orders and snap["mode"] == "shadow" and snap["live_blocks"]


def test_armed_live_trades_and_sells_only_its_own_quantity():
    ctl = {"mode": "live", "live_armed": True, "armed_key": "fp-test"}
    fake, state, _, _ = replay(ctl, live_secret=True)
    buys = [o for o in fake.orders if o[1] == "buy"]
    max_eq = max(e for _, e in state["books"]["live"]["equity"])
    assert buys and all(float(o[3]["quote_size"]) <= max_eq * 0.30 + 0.01 for o in buys)
    assert len({o[2] for o in fake.orders}) == len(fake.orders), "ogni ordine ha un client_order_id unico"
    assert state["books"]["live"]["closed"] and not state["pending_orders"]


def test_uncertain_order_is_never_repeated_and_is_reconciled():
    """Ordine partito ma senza conferma: il desk si mette in pausa, NON ricompra, e al turno
    successivo ritrova l'ordine per client_order_id e registra la posizione."""
    fake = FakeRevolutX(orders_ok=False)
    ctl = {"mode": "live", "live_armed": True, "armed_key": "fp-test"}
    state, persisted = {}, []
    times = [c["t"] for c in fake.data["BTC-EUR"]][300:]
    for t in times:
        fake.now = t + 1
        office.Office(fake, CFG, ctl, state, now=t + 1, live_secret=True, ai_review=lambda s, c: None,
                      persist=lambda: persisted.append(json.dumps(state.get("pending_orders")))).run()
        if fake.orders:
            break
    assert len(fake.orders) == 1 and ctl["paused"]
    coid = fake.orders[0][2]
    assert any(coid in p for p in persisted), "il client_order_id va salvato prima dell'invio"
    assert state["pending_orders"][0]["client_order_id"] == coid

    # turno dopo: ancora in sospeso → nessun nuovo ordine
    fake.now += 1800
    office.Office(fake, CFG, ctl, state, now=fake.now, live_secret=True, ai_review=lambda s, c: None).run()
    assert len(fake.orders) == 1

    # Revolut X lo mostra eseguito → posizione registrata, ordine non ripetuto
    sym = fake.orders[0][0]
    px = float(fake.tickers([sym])[sym]["ask"])
    fake.history.append({"client_order_id": coid, "status": "filled", "filled_quantity": str(10 / px),
                         "filled_amount": "10", "average_fill_price": str(px), "total_fee": "0.009", "fee_currency": "EUR"})
    office.Office(fake, CFG, ctl, state, now=fake.now + 60, live_secret=True, ai_review=lambda s, c: None).run()
    assert not state["pending_orders"] and sym in state["books"]["live"]["positions"]
    assert len(fake.orders) == 1
    assert abs(state["books"]["live"]["positions"][sym]["cost"] - 10.009) < 1e-9


def test_kill_switch_stops_everything():
    fake = FakeRevolutX()
    t = fake.data["BTC-EUR"][400]["t"]
    fake.now = t + 1
    state = {"books": {"live": {**office.empty_book(40), "cash": 30, "positions": {"BTC-EUR": {
        "symbol": "BTC-EUR", "qty": 0.0001, "entry": 1e9, "cost": 10, "atr": 1, "stop": 1e9, "tp": 2e9, "high": 1e9,
        "opened_at": 0, "mode": "live", "score": 90}}}}}
    ctl = {"mode": "live", "live_armed": True, "armed_key": "fp-test", "kill_switch": True}
    snap = office.Office(fake, CFG, ctl, state, now=t + 1, live_secret=True, ai_review=lambda s, c: None).run()
    assert not fake.orders, "con il kill switch non parte nemmeno lo stop"
    assert any("NON gestite" in e or "non gestite" in e for e in snap["errors"])


def test_stop_still_works_on_live_positions_when_disarmed():
    fake = FakeRevolutX()
    t = fake.data["BTC-EUR"][400]["t"]
    fake.now = t + 1
    state = {"books": {"live": {**office.empty_book(40), "cash": 30, "positions": {"BTC-EUR": {
        "symbol": "BTC-EUR", "qty": 0.0001, "entry": 1e9, "cost": 10, "atr": 1, "stop": 1e9, "tp": 2e9, "high": 1e9,
        "opened_at": 0, "mode": "live", "score": 90}}}}}
    office.Office(fake, CFG, {"mode": "paper"}, state, now=t + 1, live_secret=True, ai_review=lambda s, c: None).run()
    assert [o[1] for o in fake.orders] == ["sell"] and not state["books"]["live"]["positions"]


def test_stale_or_missing_data_blocks_buys():
    fake = FakeRevolutX()
    t = fake.data["BTC-EUR"][-1]["t"]
    fake.now = t + 1
    state = {}
    snap = office.Office(fake, CFG, {"mode": "paper"}, state, now=t + 3 * 86400, ai_review=lambda s, c: None).run()
    assert not state["books"]["paper"]["positions"]
    assert all(s["action"] != "COMPRA" for s in snap["signals"])


def test_ai_veto_blocks_buy():
    _, state, _, _ = replay({"mode": "paper"})
    assert state["books"]["paper"]["closed"]
    fake2 = FakeRevolutX()
    state2 = {}
    for t in [c["t"] for c in fake2.data["BTC-EUR"]][300::2]:
        fake2.now = t + 1
        office.Office(fake2, CFG, {"mode": "paper"}, state2, now=t + 1,
                      ai_review=lambda s, c: {"verdict": "VETO", "reason": "test"}).run()
    assert not state2["books"]["paper"]["closed"] and not state2["books"]["paper"]["positions"]


def test_fill_parsing_fees():
    o = {"filled_quantity": "0.002", "filled_amount": "100", "average_fill_price": "50000", "total_fee": "0.000002", "fee_currency": "BTC"}
    qty, _, spent, fee = office.fill_from_order(o, "buy", "BTC", 0, 0.0009)
    assert abs(qty - 0.001998) < 1e-12 and spent == 100 and abs(fee - 0.1) < 1e-9
    _, _, proceeds, fee = office.fill_from_order({**o, "total_fee": "0.09", "fee_currency": "EUR"}, "sell", "BTC", 0, 0.0009)
    assert abs(proceeds - 99.91) < 1e-9


def test_selftest_arms_only_when_green_and_requested(monkeypatch):
    fake = FakeRevolutX()
    t = fake.data["BTC-EUR"][-1]["t"]
    fake.now = t + 1
    ctl = {"mode": "live"}
    r = office.selftest(fake, CFG, ctl, {}, t + 1, arm=True, live_secret=True)
    assert r["green"] and r["armed"] and ctl["live_armed"] and ctl["armed_key"] == "fp-test"
    ctl2 = {"mode": "live"}
    r2 = office.selftest(fake, CFG, ctl2, {}, t + 1, arm=True, live_secret=False)
    assert not r2["green"] and not ctl2["live_armed"]
    ctl3 = {"mode": "paper", "live_armed": True}
    office.selftest(fake, CFG, ctl3, {}, t + 1, arm=True, live_secret=True)
    assert not ctl3["live_armed"]


# ------------------------------------------------------------------ backtest
def test_backtest_is_deterministic_and_honest():
    data = {s: load(s) for s in ("BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR")}
    a, _, _ = backtest.run(data, CFG, 40)
    b, _, _ = backtest.run(data, CFG, 40)
    assert a == b
    stressed, _, _ = backtest.run(data, CFG, 40, fee_mult=2.0)
    assert stressed["final"] <= a["final"]
    assert a["verdict"].startswith("INCONCLUSIVO")
