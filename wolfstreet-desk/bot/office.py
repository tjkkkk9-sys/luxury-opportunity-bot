"""WOLF STREET CAPITAL · Desk Revolut X — un turno di lavoro dell'ufficio.

Ogni esecuzione (GitHub Actions ogni 30 minuti):
  1. SISTEMA  legge comandi (control.json), regole (config.json) e memoria (data/state.json),
              decide la modalità effettiva (SHADOW / PAPER / LIVE) con le regole di bot/safety.py
  2. SISTEMA  riconcilia gli ordini LIVE rimasti incerti dal turno precedente
  3. TRADER   controlla le posizioni aperte: stop, target, trailing, trend, chiusura manuale
  4. ANALISTA scansiona le coppie su candele chiuse e fresche, punteggio 0-100
  5. RISK     limiti giornalieri/settimanali, drawdown, esposizione, dati mancanti, parere IA
  6. TRADER   esegue: SHADOW registra soltanto, PAPER simula, LIVE invia ordini veri
  7. SISTEMA  salva stato, pubblica docs/data/office.json per l'ufficio, avvisa su Telegram

Uso:  python -m bot.office              turno normale
      python -m bot.office --check      verifica chiavi, saldi e dati (nessun ordine, non arma)
      python -m bot.office --selftest   come --check e, se tutto è verde e hai chiesto LIVE, arma il LIVE
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import ai, safety
from . import strategy as st
from .notify import esc, telegram
from .revolutx import (
    FINAL_STATES,
    RevolutX,
    RevolutXError,
    floor_step,
    order_status,
    to_dash,
)

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("Europe/Rome")
MAX_LOG, MAX_CLOSED, MAX_EQUITY, MAX_SHADOW = 200, 300, 1500, 200
MIN_CANDLES = 220            # servono per EMA200 + margine
PENDING_GIVE_UP_S = 15 * 60  # dopo 15 minuti un ordine mai trovato si considera non inviato
DEFINITE_REJECT = (400, 401, 403, 404, 409, 422)  # l'API ha risposto: l'ordine NON è stato creato


class OrderUncertain(RuntimeError):
    """Ordine forse inviato ma non confermato: si riconcilia al turno dopo, mai si ripete."""


# ------------------------------------------------------------------ helpers
def jload(p: Path, default):
    try:
        return json.loads(p.read_text())
    except Exception:
        return default


def jsave(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(p)


def hhmm(ts: float) -> str:
    return datetime.fromtimestamp(ts, TZ).strftime("%d/%m %H:%M")


def eur(v: float) -> str:
    return f"{v:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")


def empty_book(start: float) -> dict:
    return {"cash": start, "start": start, "positions": {}, "closed": [], "equity": [],
            "daily": {"date": "", "realized": 0.0}, "weekly": {"week": "", "realized": 0.0},
            "peak": start, "cooldown": {}, "fees": 0.0}


def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def fill_from_order(o: dict, side: str, base_ccy: str, fallback_px: float, fee_rate: float) -> tuple[float, float, float, float]:
    """(quantità netta, prezzo medio, euro spesi/incassati netti, commissione in euro) da un ordine Revolut X.

    filled_quantity è LORDA (prima delle commissioni). Se la commissione è in moneta base la si
    toglie dalla quantità; se è in euro la si somma alla spesa (acquisto) o la si sottrae dall'incasso.
    Senza total_fee si usa la commissione taker come stima prudente."""
    qty = _num(o.get("filled_quantity"))
    amount = _num(o.get("filled_amount"))
    avg = _num(o.get("average_fill_price")) or (amount / qty if qty and amount else fallback_px)
    if not amount:
        amount = qty * avg
    fee, fee_ccy = o.get("total_fee"), str(o.get("fee_currency") or "").upper()
    if fee is None or fee == "":
        fee_eur = amount * fee_rate
        if side == "buy":
            return qty * (1 - fee_rate), avg, amount, fee_eur
        return qty, avg, amount - fee_eur, fee_eur
    fee = _num(fee)
    if fee_ccy == base_ccy.upper():
        fee_eur = fee * avg
        return (qty - fee, avg, amount, fee_eur) if side == "buy" else (qty, avg, amount - fee_eur, fee_eur)
    return (qty, avg, amount + fee, fee) if side == "buy" else (qty, avg, amount - fee, fee)


# --------------------------------------------------------------- brokers
class PaperBroker:
    """Ordini simulati su prezzi REALI Revolut X (ask per comprare, bid per vendere, commissione taker)."""
    live = False

    def __init__(self, fee: float):
        self.fee = fee

    def buy(self, symbol: str, eur_amount: float, tk: dict, meta: dict) -> tuple[float, float, float, float]:
        ask = float(tk["ask"])
        return eur_amount * (1 - self.fee) / ask, ask, eur_amount, eur_amount * self.fee

    def sell(self, symbol: str, qty: float, tk: dict, meta: dict) -> tuple[float, float, float]:
        bid = float(tk["bid"])
        return bid, qty * bid * (1 - self.fee), qty * bid * self.fee


class LiveBroker:
    """Ordini VERI su Revolut X (market). Idempotente: il client_order_id viene salvato su disco
    PRIMA dell'invio; se la conferma non arriva l'ordine resta "in sospeso" e il desk si ferma."""
    live = True

    def __init__(self, client: RevolutX, pairs: dict, fee: float, journal):
        self.c, self.pairs, self.fee, self.journal = client, pairs, fee, journal

    def _pair(self, symbol: str) -> dict:
        p = self.pairs.get(symbol.replace("-", "/")) or self.pairs.get(symbol)
        if not p:
            raise RevolutXError(400, f"coppia {symbol} non presente in /configuration/pairs")
        if str(p.get("status", "active")).lower() != "active":
            raise RevolutXError(400, f"coppia {symbol} non attiva")
        return p

    def _send(self, symbol: str, side: str, meta: dict, **size) -> dict:
        coid = str(uuid.uuid4())
        since_ms = int(time.time() * 1000)
        self.journal.add({"client_order_id": coid, "symbol": symbol, "side": side, "size": size,
                          "created_ms": since_ms, "meta": meta})          # salvato su disco qui
        try:
            res = self.c.market_order(symbol, side, coid, **size)
        except RevolutXError as e:
            if e.status in DEFINITE_REJECT:
                self.journal.remove(coid)
                raise
            raise OrderUncertain(f"ordine {side} {symbol} senza risposta certa ({e}): verifico al prossimo turno")
        except Exception as e:
            raise OrderUncertain(f"ordine {side} {symbol} interrotto ({type(e).__name__}): verifico al prossimo turno")
        order = self.c.wait_final(res.get("venue_order_id"), coid, symbol, since_ms)
        if order is None:
            raise OrderUncertain(f"ordine {side} {symbol} inviato ma non confermato: verifico al prossimo turno")
        self.journal.remove(coid)
        if _num(order.get("filled_quantity")) <= 0:
            raise RevolutXError(0, f"ordine {side} {symbol} non eseguito (stato {order_status(order)}"
                                   f"{', ' + str(order.get('reject_reason')) if order.get('reject_reason') else ''})")
        return order

    def buy(self, symbol: str, eur_amount: float, tk: dict, meta: dict) -> tuple[float, float, float, float]:
        p = self._pair(symbol)
        quote = floor_step(eur_amount, p.get("quote_step", "0.01"))
        if float(quote) < float(p.get("min_order_size_quote", "0.1")):
            raise RevolutXError(400, f"importo {quote} sotto il minimo della coppia")
        order = self._send(symbol, "buy", meta, quote_size=quote)
        return fill_from_order(order, "buy", symbol.split("-")[0], float(tk["ask"]), self.fee)

    def sell(self, symbol: str, qty: float, tk: dict, meta: dict) -> tuple[float, float, float]:
        p = self._pair(symbol)
        base_ccy = symbol.split("-")[0]
        avail = _num(self.c.balances().get(base_ccy, {}).get("available"))
        size = floor_step(min(qty, avail), p.get("base_step", "0.00000001"))  # mai più di quanto comprato
        if float(size) <= 0:
            raise RevolutXError(400, f"nessun {base_ccy} disponibile da vendere")
        order = self._send(symbol, "sell", meta, base_size=size)
        _, avg, proceeds, fee = fill_from_order(order, "sell", base_ccy, float(tk["bid"]), self.fee)
        return avg, proceeds, fee


class Journal:
    """Registro degli ordini LIVE in volo. Ogni modifica viene salvata subito su disco."""

    def __init__(self, state: dict, persist):
        self.state, self.persist = state, persist

    @property
    def items(self) -> list[dict]:
        return self.state.setdefault("pending_orders", [])

    def add(self, item: dict):
        self.items.append(item)
        self.persist()

    def remove(self, coid: str):
        self.state["pending_orders"] = [o for o in self.items if o["client_order_id"] != coid]
        self.persist()


# ------------------------------------------------------------------ office
class Office:
    def __init__(self, client, cfg: dict, control: dict, state: dict, now: float | None = None,
                 live_secret: bool = False, persist=None, ai_review=None):
        self.c, self.ctl, self.state = client, control, state
        self.cfg, self.cfg_notes = safety.clamp_config(cfg)
        self.now = now or time.time()
        self.events: list[str] = []
        self.errors: list[str] = []
        self.persist = persist or (lambda: None)
        self.ai_review = ai_review or ai.review
        self.live_secret = live_secret
        key_fp = getattr(client, "fingerprint", None)
        self.mode, self.live_blocks = safety.resolve_mode(control, live_secret, key_fp)
        self.exits_live = safety.live_exits_allowed(control, live_secret)
        books = state.setdefault("books", {})
        self.paper = books.setdefault("paper", empty_book(self.cfg["paper_start_eur"]))
        self.live = books.setdefault("live", empty_book(self.cfg["budget_eur"]))
        self.book = self.live if self.mode == "live" else self.paper if self.mode == "paper" else None
        self.journal = Journal(state, self.persist)
        self.stats = {"analyst": {"scanned": 0, "candidates": 0, "ai": 0},
                      "risk": {"checked": 0, "blocked": 0, "last": ""},
                      "trader": {"buys": 0, "sells": 0, "blocked": 0, "shadow": 0}}

    # ---------------------------------------------------------------- utils
    def log(self, bot: str, text: str, level: str = "info"):
        self.state.setdefault("log", []).append({"t": self.now, "bot": bot, "text": text, "level": level, "mode": self.mode})
        self.state["log"] = self.state["log"][-MAX_LOG:]
        print(f"[{bot}] {text}")

    def pause(self, reason: str):
        self.ctl.update({"paused": True, "pause_reason": reason})

    def _periods(self, book: dict):
        dt = datetime.fromtimestamp(self.now, TZ)
        d, w = dt.strftime("%Y-%m-%d"), f"{dt.isocalendar()[0]}-W{dt.isocalendar()[1]:02d}"
        book.setdefault("daily", {"date": "", "realized": 0.0})
        book.setdefault("weekly", {"week": "", "realized": 0.0})
        if book["daily"]["date"] != d:
            book["daily"] = {"date": d, "realized": 0.0}
        if book["weekly"]["week"] != w:
            book["weekly"] = {"week": w, "realized": 0.0}
        return book["daily"], book["weekly"]

    @staticmethod
    def equity(book: dict, tickers: dict) -> float:
        val = book["cash"]
        for sym, p in book["positions"].items():
            tk = tickers.get(sym) or {}
            val += p["qty"] * float(tk["bid"]) if tk.get("bid") else p["cost"]
        return val

    # ----------------------------------------------------------------- turn
    def run(self) -> dict:
        cfg = self.cfg
        pairs = [to_dash(p) for p in cfg["pairs"]]
        for n in self.cfg_notes:
            self.log("SISTEMA", n, "warn")
        self.log("SISTEMA", f"Turno #{self.state.get('runs', 0) + 1} · modalità {self.mode.upper()}"
                 + (" · IN PAUSA" if self.ctl.get("paused") else "")
                 + (" · KILL SWITCH" if self.ctl.get("kill_switch") else ""))
        if self.ctl.get("mode") == "live" and self.live_blocks:
            self.log("SISTEMA", "LIVE richiesto ma non attivo: " + "; ".join(self.live_blocks) + ". Lavoro in SHADOW.", "warn")

        tickers = self.c.tickers(pairs)
        live_ready = self.mode == "live" or (self.live["positions"] and self.exits_live) or \
            (self.journal.items and self.live_secret)
        pair_cfg = self.c.pairs() if live_ready else {}
        live_broker = LiveBroker(self.c, pair_cfg, cfg["taker_fee"], self.journal) if live_ready else None
        paper_broker = PaperBroker(cfg["taker_fee"])

        # 2) riconciliazione degli ordini incerti
        if self.journal.items:
            self._reconcile(tickers)

        # dati di mercato
        market: dict[str, tuple[list, dict]] = {}
        for sym in pairs:
            try:
                cs = st.closed_only(st.normalize(self.c.candles(sym, cfg["interval_min"], count=cfg.get("candles", 300))),
                                    cfg["interval_min"], self.now)
                market[sym] = (cs, st.compute(cs))
            except Exception as e:
                self.errors.append(f"Candele {sym}: {e}")
                self.log("ANALISTA", f"Non riesco a leggere le candele di {sym}: {e}", "error")

        # 3) TRADER · posizioni aperte (LIVE prima: soldi veri)
        panic = bool(self.ctl.get("panic_close"))
        if self.live["positions"]:
            if live_broker and self.exits_live:
                self._manage(self.live, live_broker, tickers, market, panic)
            else:
                msg = ("kill switch attivo" if self.ctl.get("kill_switch") else "secret LIVE_TRADING assente")
                self.log("TRADER", f"{len(self.live['positions'])} posizioni LIVE aperte NON gestite ({msg}): "
                         "controllale su Revolut X.", "error")
                self.errors.append(f"Posizioni LIVE non gestite: {msg}")
        if self.paper["positions"]:
            self._manage(self.paper, paper_broker, tickers, market, panic)
        if panic:
            self.ctl["panic_close"] = False
            self.pause("Chiusura manuale eseguita: bot in pausa")
            self.log("TRADER", "Chiusura manuale completata. Ufficio in pausa finché non riattivi.", "warn")

        # 4) ANALISTA · scansione
        signals = []
        for sym in pairs:
            if sym not in market:
                continue
            cs, s = market[sym]
            if len(cs) < 2:
                continue
            tk = tickers.get(sym) or {}
            spread = None
            if tk.get("bid") and tk.get("ask"):
                b, a = float(tk["bid"]), float(tk["ask"])
                spread = (a - b) / ((a + b) / 2) * 100 if a > 0 and b > 0 else None
            sig = st.analyze(sym, cs, cfg, s, spread_pct=spread)
            sig["live_price"] = _num(tk.get("last_price")) or sig["price"]
            ch, lp = _num(tk.get("price_change_24h"), None), _num(tk.get("last_price"), None)
            sig["change_24h_pct"] = ch / (lp - ch) * 100 if ch is not None and lp and lp != ch else None
            sig["candles"] = len(cs)
            # fail-closed: senza dati certi non si compra
            stale_min = (self.now - (cs[-1]["t"] + cfg["interval_min"] * 60)) / 60
            blocks = []
            if len(cs) < MIN_CANDLES:
                blocks.append(f"Solo {len(cs)} candele chiuse (servono {MIN_CANDLES})")
            if stale_min > cfg["interval_min"] * 1.5:
                blocks.append(f"Dati vecchi: ultima candela chiusa {stale_min:.0f} min fa")
            if spread is None:
                blocks.append("Prezzi bid/ask non disponibili")
            if blocks and sig["action"] == "COMPRA":
                sig["action"], sig["reasons"] = "EVITA", (blocks + sig["reasons"])[:6]
            self.stats["analyst"]["scanned"] += 1
            signals.append(sig)
        signals.sort(key=lambda x: -x["score"])
        for sig in signals:
            if sig["action"] == "COMPRA":
                self.stats["analyst"]["candidates"] += 1
                self.log("ANALISTA", f"{sig['symbol']} punteggio {sig['score']}/100 → COMPRA · {sig['reasons'][0] if sig['reasons'] else ''}")
        top = signals[0] if signals else None
        if top and top["action"] != "COMPRA":
            self.log("ANALISTA", f"Scansionate {len(signals)} coppie. Migliore {top['symbol']} {top['score']}/100: nessun ingresso.")
        if not signals:
            self.log("ANALISTA", "Nessuna coppia analizzabile in questo turno: nessun acquisto.", "warn")

        # 5) RISK · cancelli comuni
        book = self.book
        ref = book or empty_book(cfg["budget_eur"])
        eq = self.equity(ref, tickers)
        gate = self._gate(ref, eq)

        # 6) TRADER · esecuzione
        for sig in signals:
            if sig["action"] != "COMPRA":
                continue
            sym = sig["symbol"]
            self.stats["risk"]["checked"] += 1
            if gate:
                self._blocked(sym, gate)
                continue
            if sym in ref["positions"] or any(o["symbol"] == sym for o in self.journal.items):
                continue
            if len(ref["positions"]) >= cfg["max_open_positions"]:
                self._blocked(sym, f"già {cfg['max_open_positions']} posizioni aperte")
                continue
            if ref.get("cooldown", {}).get(sym, 0) > self.now:
                self._blocked(sym, f"in pausa dopo uno stop fino alle {hhmm(ref['cooldown'][sym])}")
                continue
            exposure = sum(p["cost"] for p in ref["positions"].values())
            cash = ref["cash"]
            if self.mode == "live":
                try:
                    cash = min(cash, _num(self.c.balances().get("EUR", {}).get("available")))
                except Exception as e:
                    self._blocked(sym, f"saldo EUR non leggibile ({e})")
                    continue
            amount, why = st.size_position(sig, cash, eq, cfg)
            room = eq * cfg["max_exposure_pct"] / 100 - exposure
            if amount > room:
                amount = round(max(0.0, room), 2)
                why += f" · ridotto a {amount:.2f}€ per il tetto di esposizione"
                if amount < cfg.get("min_trade_eur", 5):
                    amount = 0.0
            if amount <= 0:
                self._blocked(sym, why)
                continue
            verdict = self.ai_review(sig, cfg)
            sig["ai"] = verdict
            if verdict:
                self.stats["analyst"]["ai"] += 1
                self.log("ANALISTA", f"IA su {sym}: {verdict['verdict']} — {verdict['reason']}",
                         "warn" if verdict["verdict"] == "VETO" else "info")
                if verdict["verdict"] != "APPROVA":
                    self.stats["risk"]["blocked"] += 1
                    self.stats["risk"]["last"] = f"{sym}: veto IA"
                    continue
            self.stats["risk"]["last"] = f"{sym}: via libera"
            if self.mode == "shadow":
                self._shadow(sig, amount, why, tickers.get(sym) or {})
                continue
            broker = live_broker if self.mode == "live" else paper_broker
            if not self._buy(book, broker, sig, amount, tickers[sym], why):
                break  # dopo un errore o un ordine incerto non si tenta altro in questo turno
            eq = self.equity(book, tickers)

        # 7) chiusura turno
        for b in (self.paper, self.live):
            if b is book or b["positions"]:
                b["equity"].append([self.now, round(self.equity(b, tickers), 4)])
                b["equity"] = b["equity"][-MAX_EQUITY:]
        self.state["runs"] = self.state.get("runs", 0) + 1
        self.state["last_run"] = self.now
        return self.snapshot(tickers, signals)

    def _gate(self, book: dict, eq: float) -> str | None:
        cfg = self.cfg
        daily, weekly = self._periods(book)
        book["peak"] = max(book.get("peak", eq), eq)
        dd = (book["peak"] - eq) / book["peak"] * 100 if book["peak"] else 0
        if self.ctl.get("kill_switch"):
            return "Kill switch attivo"
        if self.ctl.get("paused"):
            return "Ufficio in pausa" + (f" ({self.ctl.get('pause_reason')})" if self.ctl.get("pause_reason") else "")
        if self.journal.items:
            return "Ordine LIVE in sospeso da verificare"
        if daily["realized"] <= -cfg["daily_loss_limit_eur"]:
            return f"Stop giornaliero raggiunto ({eur(daily['realized'])}): niente acquisti fino a mezzanotte"
        if weekly["realized"] <= -cfg["weekly_loss_limit_eur"]:
            return f"Stop settimanale raggiunto ({eur(weekly['realized'])}): niente acquisti fino a lunedì"
        if dd >= cfg["max_drawdown_pct"]:
            reason = f"Drawdown {dd:.1f}% oltre il limite del {cfg['max_drawdown_pct']}%: pausa di sicurezza"
            self.pause(reason)
            self.events.append(f"🛑 <b>Pausa di sicurezza</b>\n{esc(reason)}")
            return reason
        return None

    def _blocked(self, sym: str, why: str):
        self.stats["trader"]["blocked"] += 1
        self.stats["risk"]["blocked"] += 1
        self.stats["risk"]["last"] = f"{sym}: {why}"
        self.log("RISK", f"{sym}: segnale valido ma bloccato → {why}", "warn")

    def _manage(self, book: dict, broker, tickers: dict, market: dict, panic: bool):
        for sym in list(book["positions"]):
            pos = book["positions"][sym]
            tk = tickers.get(sym) or {}
            if not tk.get("bid"):
                self.log("TRADER", f"{sym}: prezzo non disponibile, controllo rimandato", "warn")
                continue
            bid = float(tk["bid"])
            ema50 = ema200 = None
            if sym in market and market[sym][0]:
                ema50, ema200 = market[sym][1]["ema50"][-1], market[sym][1]["ema200"][-1]
            ex = ("CHIUSURA MANUALE", bid) if panic else st.check_exit(
                pos, {"o": bid, "h": bid, "l": bid, "c": bid}, ema50, ema200, self.now, self.cfg, intrabar=False)
            if ex:
                if not self._sell(book, broker, sym, pos, tk, ex[0]):
                    break
            else:
                self.log("TRADER", f"Tengo {sym} ({'LIVE' if broker.live else 'PAPER'}): {(bid / pos['entry'] - 1) * 100:+.2f}% · "
                         f"stop {pos['stop']:.6g} · target {pos['tp']:.6g}")

    # ---------------------------------------------------------- execution
    def _shadow(self, sig: dict, amount: float, why: str, tk: dict):
        a = sig["ind"]["atr"]
        px = _num(tk.get("ask")) or sig["price"]
        rec = {"t": self.now, "symbol": sig["symbol"], "score": sig["score"], "eur": amount, "price": px,
               "stop": px - self.cfg["stop_atr"] * a, "tp": px + self.cfg["tp_atr"] * a, "why": why}
        j = self.state.setdefault("shadow", [])
        j.append(rec)
        self.state["shadow"] = j[-MAX_SHADOW:]
        self.stats["trader"]["shadow"] += 1
        self.log("TRADER", f"SHADOW · avrei comprato {sig['symbol']} per {eur(amount)} @ {px:.6g} · {why}", "trade")

    def _buy(self, book: dict, broker, sig: dict, amount: float, tk: dict, why: str) -> bool:
        sym = sig["symbol"]
        meta = {"atr": sig["ind"]["atr"], "score": sig["score"], "mode": self.mode}
        try:
            qty, fill, spent, fee = broker.buy(sym, amount, tk, meta)
        except OrderUncertain as e:
            self.pause(f"Ordine {sym} non confermato: verifico al prossimo turno")
            self.errors.append(str(e))
            self.log("TRADER", str(e), "error")
            self.events.append(f"⚠️ <b>Ordine non confermato</b>\n{esc(e)}\nUfficio in pausa: niente nuovi acquisti.")
            return False
        except Exception as e:
            self.errors.append(f"Acquisto {sym}: {e}")
            self.log("TRADER", f"Acquisto {sym} FALLITO: {e}", "error")
            self.events.append(f"⚠️ Acquisto {esc(sym)} fallito: {esc(e)}")
            return False
        self._open(book, sig, qty, fill, spent, fee, why, broker.live)
        return True

    def _open(self, book, sig, qty, fill, spent, fee, why, live):
        pos = st.new_position(sig, qty, fill, spent, "live" if live else "paper", self.cfg, self.now)
        book["positions"][sig["symbol"]] = pos
        book["cash"] -= spent
        book["fees"] = book.get("fees", 0.0) + fee
        self.stats["trader"]["buys"] += 1
        self.log("TRADER", f"COMPRATO {sig['symbol']} {qty:.6g} @ {fill:.6g} per {eur(spent)} · {why}", "trade")
        self.events.append(
            f"🟢 <b>{'LIVE' if live else 'PAPER'} · COMPRA {esc(sig['symbol'])}</b>\n{eur(spent)} @ {fill:.6g}\n"
            f"Stop {pos['stop']:.6g} · Target {pos['tp']:.6g}\nPunteggio {sig['score']}/100")

    def _sell(self, book: dict, broker, sym: str, pos: dict, tk: dict, reason: str) -> bool:
        try:
            px, proceeds, fee = broker.sell(sym, pos["qty"], tk, {"reason": reason, "mode": "live" if broker.live else "paper"})
        except OrderUncertain as e:
            self.pause(f"Vendita {sym} non confermata: verifico al prossimo turno")
            self.errors.append(str(e))
            self.log("TRADER", str(e), "error")
            self.events.append(f"⚠️ <b>Vendita non confermata</b>\n{esc(e)}")
            return False
        except Exception as e:
            self.errors.append(f"Vendita {sym}: {e}")
            self.log("TRADER", f"Vendita {sym} FALLITA ({reason}): {e}", "error")
            self.events.append(f"⚠️ Vendita {esc(sym)} fallita: {esc(e)}")
            return True  # le altre posizioni vanno comunque controllate
        self._close(book, sym, pos, px, proceeds, fee, reason, broker.live)
        return True

    def _close(self, book, sym, pos, px, proceeds, fee, reason, live):
        pnl = proceeds - pos["cost"]
        book["cash"] += proceeds
        book["fees"] = book.get("fees", 0.0) + fee
        daily, weekly = self._periods(book)
        daily["realized"] += pnl
        weekly["realized"] += pnl
        closed = {**pos, "exit": px, "proceeds": proceeds, "pnl": pnl, "pnl_pct": pnl / pos["cost"] * 100 if pos["cost"] else 0,
                  "reason": reason, "closed_at": self.now}
        book["closed"] = (book["closed"] + [closed])[-MAX_CLOSED:]
        del book["positions"][sym]
        if reason == "STOP":
            book.setdefault("cooldown", {})[sym] = self.now + self.cfg["cooldown_hours"] * 3600
        self.stats["trader"]["sells"] += 1
        self.log("TRADER", f"VENDUTO {sym} @ {px:.6g} · {reason} · {pnl:+.2f} € ({closed['pnl_pct']:+.2f}%)", "trade")
        self.events.append(f"{'🟢' if pnl >= 0 else '🔴'} <b>{'LIVE' if live else 'PAPER'} · VENDE {esc(sym)}</b> · {esc(reason)}\n"
                           f"{pnl:+.2f} € ({closed['pnl_pct']:+.2f}%)")

    def _reconcile(self, tickers: dict):
        """Ritrova gli ordini LIVE incerti per client_order_id e aggiorna il portafoglio. Mai reinviare."""
        for item in list(self.journal.items):
            coid, sym, side = item["client_order_id"], item["symbol"], item["side"]
            try:
                o = self.c.find_order(coid, sym, item["created_ms"])
            except Exception as e:
                self.log("SISTEMA", f"Non riesco a verificare l'ordine {side} {sym}: {e}. Resto in pausa.", "error")
                continue
            age = self.now - item["created_ms"] / 1000
            if o is None:
                if age > PENDING_GIVE_UP_S:
                    self.journal.remove(coid)
                    self.log("SISTEMA", f"Ordine {side} {sym} mai arrivato a Revolut X dopo {age / 60:.0f} min: "
                             "lo considero non inviato. Controlla l'app e poi premi Riprendi.", "warn")
                    self.pause(f"Verifica manuale ordine {side} {sym} (non trovato)")
                continue
            if order_status(o) not in FINAL_STATES:
                self.log("SISTEMA", f"Ordine {side} {sym} ancora aperto su Revolut X ({order_status(o)}): attendo.", "warn")
                continue
            self.journal.remove(coid)
            base = sym.split("-")[0]
            if _num(o.get("filled_quantity")) <= 0:
                self.log("SISTEMA", f"Ordine {side} {sym} chiuso senza esecuzione ({order_status(o)}).", "warn")
                continue
            tk = tickers.get(sym) or {}
            if side == "buy":
                qty, avg, spent, fee = fill_from_order(o, "buy", base, _num(tk.get("ask")), self.cfg["taker_fee"])
                meta = item.get("meta", {})
                sig = {"symbol": sym, "score": meta.get("score", 0), "ind": {"atr": meta.get("atr") or avg * 0.02}}
                self._open(self.live, sig, qty, avg, spent, fee, "recuperato dalla riconciliazione", True)
                self.log("SISTEMA", f"Ordine d'acquisto {sym} ritrovato ed eseguito: posizione registrata.", "warn")
            else:
                _, avg, proceeds, fee = fill_from_order(o, "sell", base, _num(tk.get("bid")), self.cfg["taker_fee"])
                pos = self.live["positions"].get(sym)
                if pos:
                    self._close(self.live, sym, pos, avg, proceeds, fee, item.get("meta", {}).get("reason", "VENDITA"), True)
                self.log("SISTEMA", f"Ordine di vendita {sym} ritrovato ed eseguito: posizione chiusa.", "warn")

    # ------------------------------------------------------------ snapshot
    def _book_view(self, b: dict, tickers: dict) -> dict:
        cfg = self.cfg
        eq = self.equity(b, tickers)
        closed = b["closed"]
        wins = [c for c in closed if c["pnl"] > 0]
        losses = [c for c in closed if c["pnl"] <= 0]
        peak, mdd = b["start"], 0.0
        for _, e in b["equity"]:
            peak = max(peak, e)
            mdd = max(mdd, (peak - e) / peak * 100 if peak else 0)
        positions = []
        for sym, p in b["positions"].items():
            bid = _num((tickers.get(sym) or {}).get("bid")) or p["entry"]
            positions.append({**p, "price": bid, "value": p["qty"] * bid,
                              "pnl": p["qty"] * bid * (1 - cfg["taker_fee"]) - p["cost"],
                              "pnl_pct": (bid / p["entry"] - 1) * 100})
        daily, weekly = self._periods(b)
        n = len(closed)
        return {
            "kpi": {
                "equity": eq, "start": b["start"], "cash": b["cash"], "exposure": sum(p["value"] for p in positions),
                "pnl_total": eq - b["start"], "pnl_pct": (eq / b["start"] - 1) * 100 if b["start"] else 0,
                "pnl_today": daily["realized"], "pnl_week": weekly["realized"], "trades": n,
                "win_rate": len(wins) / n * 100 if n else None,
                "expectancy": sum(c["pnl"] for c in closed) / n if n else None,
                "profit_factor": (sum(c["pnl"] for c in wins) / -sum(c["pnl"] for c in losses))
                if losses and sum(c["pnl"] for c in losses) < 0 else None,
                "sample": "INCONCLUSIVO" if n < 100 else "sufficiente",
                "realized": sum(c["pnl"] for c in closed), "fees": b.get("fees", 0.0), "max_dd_pct": mdd,
            },
            "positions": positions, "closed": list(reversed(closed[-40:])), "equity": b["equity"][-400:],
        }

    def snapshot(self, tickers, signals) -> dict:
        cfg = self.cfg
        view = self._book_view(self.book, tickers) if self.book else {"kpi": {}, "positions": [], "closed": [], "equity": []}
        live_view = self._book_view(self.live, tickers) if (self.live["positions"] or self.live["closed"]) and self.book is not self.live else None
        a, t, r = self.stats["analyst"], self.stats["trader"], self.stats["risk"]
        paused = bool(self.ctl.get("paused"))
        best = signals[0] if signals else None
        return {
            "generated_at": self.now, "company": cfg.get("company"), "desk": cfg.get("desk"),
            "mode": self.mode, "requested_mode": self.ctl.get("mode", "shadow"), "live_blocks": self.live_blocks,
            "live_armed": bool(self.ctl.get("live_armed")), "kill_switch": bool(self.ctl.get("kill_switch")),
            "paused": paused, "pause_reason": self.ctl.get("pause_reason", ""),
            "pending_orders": [{k: o[k] for k in ("symbol", "side", "created_ms")} for o in self.journal.items],
            "ai_enabled": ai.enabled(cfg), "telegram": bool(os.getenv("TELEGRAM_BOT_TOKEN")),
            "runs": self.state.get("runs", 0),
            "config": {k: cfg.get(k) for k in ("pairs", "interval_min", "style", "budget_eur", "paper_start_eur",
                                               "risk_per_trade_eur", "max_risk_pct", "max_position_pct", "max_exposure_pct",
                                               "max_open_positions", "daily_loss_limit_eur", "weekly_loss_limit_eur",
                                               "max_drawdown_pct", "min_score", "stop_atr", "tp_atr")},
            "agents": [
                {"id": "analyst", "name": "Analista", "role": "Scansiona il mercato su candele chiuse e propone gli ingressi",
                 "status": "IN PAUSA" if paused else ("SEGNALE" if a["candidates"] else "SCANSIONE"),
                 "metric": a["scanned"], "unit": "coppie analizzate",
                 "detail": f"Migliore: {best['symbol']} {best['score']}/100" if best else "Nessun dato", "ai_reviews": a["ai"]},
                {"id": "risk", "name": "Risk", "role": "Limiti di perdita, esposizione, dati mancanti, veto IA",
                 "status": "IN PAUSA" if paused else ("BLOCCO" if r["blocked"] else "VIGILE"),
                 "metric": r["checked"], "unit": "controlli", "detail": r["last"] or "Nessun candidato in questo turno"},
                {"id": "trader", "name": "Trader", "role": "Ordini, stop, target e uscite",
                 "status": "IN PAUSA" if paused else ("OPERATIVO" if (t["buys"] or t["sells"] or t["shadow"]) else "VIGILE"),
                 "metric": len(view["positions"]), "unit": "posizioni aperte",
                 "detail": f"{t['buys']} acquisti · {t['sells']} vendite · {t['shadow']} simulati in shadow · {t['blocked']} bloccati"},
            ],
            **view,
            "live_book": live_view,
            "shadow": list(reversed(self.state.get("shadow", [])[-30:])),
            "signals": [{k: v for k, v in s.items() if k != "ind"} | {
                "rsi": s["ind"].get("rsi"), "atr_pct": s["ind"].get("atr_pct"), "adx": s["ind"].get("adx"),
                "ema50": s["ind"].get("ema50"), "ema200": s["ind"].get("ema200")} for s in signals],
            "log": list(reversed(self.state.get("log", [])[-80:])),
            "errors": self.errors,
        }


# ---------------------------------------------------------------- selftest
def selftest(client, cfg: dict, control: dict, state: dict, now: float, arm: bool, live_secret: bool) -> dict:
    """Verifica di sola lettura. Se `arm` e tutto è verde e hai chiesto LIVE, arma il LIVE."""
    cfg, _ = safety.clamp_config(cfg)
    checks: list[tuple[str, bool, str]] = []

    def check(name, fn):
        try:
            ok, detail = fn()
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"
        checks.append((name, bool(ok), str(detail)))
        print(("OK   " if ok else "FAIL ") + name + " · " + str(detail))
        return ok

    pairs = [to_dash(p) for p in cfg["pairs"]]
    bal = {}

    def _bal():
        bal.update(client.balances())
        e = _num(bal.get("EUR", {}).get("available"))
        return True, f"EUR disponibili {e:.2f}"
    check("Firma e chiavi (saldi)", _bal)

    def _pairs():
        p = client.pairs()
        missing = [s for s in pairs if str((p.get(s.replace("-", "/")) or {}).get("status", "")).lower() != "active"]
        return not missing, "tutte attive" if not missing else f"non attive/assenti: {', '.join(missing)}"
    check("Coppie configurate", _pairs)

    def _tk():
        tk = client.tickers(pairs)
        bad = [s for s in pairs if not ((tk.get(s) or {}).get("bid") and (tk.get(s) or {}).get("ask"))]
        return not bad, "bid/ask presenti" if not bad else f"senza prezzi: {', '.join(bad)}"
    check("Prezzi in tempo reale", _tk)

    for sym in pairs:
        def _c(sym=sym):
            cs = st.closed_only(st.normalize(client.candles(sym, cfg["interval_min"], count=cfg.get("candles", 300))),
                                cfg["interval_min"], now)
            age = (now - (cs[-1]["t"] + cfg["interval_min"] * 60)) / 60 if cs else 1e9
            return len(cs) >= MIN_CANDLES and age <= cfg["interval_min"] * 1.5, f"{len(cs)} candele chiuse, ultima {age:.0f} min fa"
        check(f"Candele {sym}", _c)

    check("Nessun ordine in sospeso", lambda: (not state.get("pending_orders"), f"{len(state.get('pending_orders') or [])} in sospeso"))
    if control.get("mode") == "live":
        check("Saldo per operare", lambda: (_num(bal.get("EUR", {}).get("available")) >= cfg.get("min_trade_eur", 5),
                                            f"minimo {cfg.get('min_trade_eur', 5)} €"))
        check("Secret LIVE_TRADING = SI", lambda: (live_secret, "presente" if live_secret else "assente"))
        check("Kill switch spento", lambda: (not control.get("kill_switch"), "spento" if not control.get("kill_switch") else "ACCESO"))

    green = all(ok for _, ok, _ in checks)
    armed = False
    if arm and control.get("mode") == "live":
        armed = green
        control.update({"live_armed": armed, "armed_key": client.fingerprint if armed else None,
                        "armed_at": now if armed else None})
    elif arm:
        control.update({"live_armed": False, "armed_key": None, "armed_at": None})
    report = {"t": now, "green": green, "armed": armed, "requested_mode": control.get("mode", "shadow"),
              "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks],
              "note": "Il permesso di trading della API key si può verificare solo con un ordine vero: "
                      "il primo acquisto LIVE è anche il test finale."}
    print("SELFTEST", "VERDE" if green else "ROSSO", "· LIVE armato" if armed else "")
    return report


# ------------------------------------------------------------------- main
def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    cfg = jload(ROOT / "config.json", {})
    ctl_path, state_path = ROOT / "control.json", ROOT / "data" / "state.json"
    out_path, test_path = ROOT / "docs" / "data" / "office.json", ROOT / "docs" / "data" / "selftest.json"
    control = jload(ctl_path, {"mode": "shadow"})
    state = jload(state_path, {})
    live_secret = os.getenv("LIVE_TRADING", "").strip().upper() == "SI"
    now = time.time()
    if control.get("mode") != "live" and control.get("live_armed"):
        control.update({"live_armed": False, "armed_key": None, "armed_at": None})  # cambio modalità = disarmo
    try:
        client = RevolutX(os.getenv("REVX_API_KEY", ""), os.getenv("REVX_PRIVATE_KEY", ""))
    except Exception as e:
        jsave(out_path, {"generated_at": now, "company": cfg.get("company"), "desk": cfg.get("desk"),
                         "mode": "spento", "requested_mode": control.get("mode", "shadow"), "paused": True,
                         "pause_reason": "Chiavi Revolut X mancanti o non valide", "errors": [str(e)],
                         "agents": [], "kpi": {}, "signals": [], "positions": [], "closed": [], "equity": [],
                         "log": [{"t": now, "bot": "SISTEMA", "text": f"Configurazione incompleta: {e}", "level": "error"}]})
        print("DESK SPENTO (nessun ordine):", e)
        # Chiavi non ancora inserite: stato normale prima della configurazione, non un guasto.
        # Il turno finisce "verde" per non mandare un'email di errore ogni 30 minuti;
        # la verifica manuale invece fallisce, così il problema si vede.
        return 1 if ("--check" in argv or "--selftest" in argv) else 0

    if "--check" in argv or "--selftest" in argv:
        report = selftest(client, cfg, control, state, now, arm="--selftest" in argv, live_secret=live_secret)
        jsave(test_path, report)
        jsave(ctl_path, control)
        telegram(f"🐺 <b>Verifica desk</b>: {'VERDE' if report['green'] else 'ROSSA'}"
                 + (" · <b>LIVE ARMATO</b>" if report["armed"] else "")
                 + "".join(f"\n{'✅' if c['ok'] else '❌'} {esc(c['name'])}: {esc(c['detail'])}" for c in report["checks"]))
        return 0 if report["green"] else 1

    def persist():
        jsave(state_path, state)
        jsave(ctl_path, control)

    office = Office(client, cfg, control, state, now=now, live_secret=live_secret, persist=persist)
    try:
        snap = office.run()
        if office.mode == "live" or office.live["positions"]:
            try:
                bal = client.balances()
                keep = {"EUR"} | {p.split("-")[0] for p in office.cfg["pairs"]}
                snap["balances"] = {k: v for k, v in bal.items() if k in keep}
            except Exception as e:
                snap["errors"].append(f"Saldi: {e}")
        code = 0
    except Exception as e:
        traceback.print_exc()
        office.log("SISTEMA", f"Turno interrotto: {e}", "error")
        office.events.append(f"⚠️ Turno interrotto: {esc(e)}")
        snap = {"generated_at": now, "company": cfg.get("company"), "desk": cfg.get("desk"),
                "mode": office.mode, "requested_mode": control.get("mode", "shadow"), "paused": control.get("paused", False),
                "errors": [str(e)], "agents": [], "kpi": {}, "signals": [], "positions": [], "closed": [], "equity": [],
                "log": list(reversed(state.get("log", [])[-80:]))}
        code = 1
    persist()
    jsave(out_path, snap)
    if office.events:
        telegram(f"🐺 <b>{esc(cfg.get('company'))}</b>\n\n" + "\n\n".join(office.events))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
