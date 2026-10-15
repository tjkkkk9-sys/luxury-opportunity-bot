"""Cervello dei due bot.

BOT 1 · ANALISTA  -> analyze(): legge le candele chiuse, calcola indicatori, dà un punteggio 0-100.
BOT 2 · TRADER    -> size_position() + check_exit(): decide quanto comprare e quando uscire.

Funzioni pure: le usa sia il bot reale sia il backtest, così il backtest misura
esattamente la logica che gira sul conto.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import indicators as ind


def parse_ts(v) -> float:
    """Revolut X restituisce `start` in millisecondi (API) o ISO (MCP). Ritorna secondi epoch."""
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    s = str(v)
    if s.isdigit():
        n = int(s)
        return n / 1000 if n > 1e11 else float(n)
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def normalize(candles: list[dict]) -> list[dict]:
    out = []
    for c in candles:
        out.append({
            "t": parse_ts(c.get("start", c.get("t"))),
            "o": float(c["open"] if "open" in c else c["o"]),
            "h": float(c["high"] if "high" in c else c["h"]),
            "l": float(c["low"] if "low" in c else c["l"]),
            "c": float(c["close"] if "close" in c else c["c"]),
            "v": float(c.get("volume", c.get("v", 0)) or 0),
        })
    out.sort(key=lambda x: x["t"])
    # de-duplica per timestamp
    dedup = {}
    for c in out:
        dedup[c["t"]] = c
    return list(dedup.values())


def aggregate(candles: list[dict], minutes: int) -> list[dict]:
    """Unisce candele più piccole in candele da `minutes` (es. 1h -> 4h)."""
    out: list[dict] = []
    for c in candles:
        b = int(c["t"] // (minutes * 60)) * minutes * 60
        if out and out[-1]["t"] == b:
            o = out[-1]
            o["h"], o["l"], o["c"], o["v"] = max(o["h"], c["h"]), min(o["l"], c["l"]), c["c"], o["v"] + c["v"]
        else:
            out.append(dict(c, t=b))
    return out


def closed_only(candles: list[dict], interval_min: int, now: float) -> list[dict]:
    """Scarta la candela ancora in formazione: si decide solo su candele chiuse."""
    return [c for c in candles if c["t"] + interval_min * 60 <= now]


def compute(candles: list[dict]) -> dict:
    c = [x["c"] for x in candles]
    h = [x["h"] for x in candles]
    l = [x["l"] for x in candles]
    return {
        "ema20": ind.ema(c, 20),
        "ema50": ind.ema(c, 50),
        "ema200": ind.ema(c, 200),
        "rsi": ind.rsi(c, 14),
        "atr": ind.atr(h, l, c, 14),
        "adx": ind.adx(h, l, c, 14),
        "macd_h": ind.macd_hist(c),
        "res20": ind.rolling_max_prev(h, 20),
    }


def analyze(symbol: str, candles: list[dict], cfg: dict, series: dict | None = None,
            i: int | None = None, spread_pct: float | None = None) -> dict:
    """BOT 1 · ANALISTA. Valuta l'ultima candela chiusa (o l'indice i nel backtest)."""
    s = series or compute(candles)
    i = len(candles) - 1 if i is None else i
    price = candles[i]["c"]
    g = lambda k, j=i: s[k][j] if 0 <= j < len(s[k]) else None  # noqa: E731
    e20, e50, e200, r, a, x, m, mprev, res = (
        g("ema20"), g("ema50"), g("ema200"), g("rsi"), g("atr"), g("adx"), g("macd_h"), g("macd_h", i - 1), g("res20"))
    base = {"symbol": symbol, "price": price, "t": candles[i]["t"], "score": 0, "action": "ATTESA", "reasons": [],
            "ind": {}, "spread_pct": spread_pct}
    if None in (e20, e50, e200, r, a, x, m, mprev):
        base["reasons"] = ["Storico insufficiente per gli indicatori (servono ~220 candele)"]
        base["action"] = "DATI"
        return base

    atr_pct = a / price * 100
    if cfg.get("style", "pullback") == "pullback":
        return _pullback(base, price, e20, e50, e200, r, a, x, m, mprev, atr_pct, spread_pct, cfg, g, i)
    score, why, block = 0, [], []
    if e50 > e200:
        score += 25; why.append("Trend di fondo rialzista (EMA50 > EMA200)")
    else:
        block.append("Trend di fondo ribassista (EMA50 < EMA200)")
    if price > e50 and e20 > e50:
        score += 15; why.append("Prezzo sopra EMA20/EMA50")
    if m > 0 and m > mprev:
        score += 15; why.append("Momentum MACD in accelerazione")
    elif m < 0:
        score -= 10
    if 45 <= r <= 68:
        score += 15; why.append(f"RSI sano {r:.0f}")
    elif r > 74:
        score -= 20; block.append(f"RSI ipercomprato {r:.0f}")
    elif r < 40:
        score -= 10
    if x >= 20:
        score += 15; why.append(f"Trend con forza (ADX {x:.0f})")
    if res is not None and price > res:
        score += 15; why.append("Rottura del massimo a 20 candele")
    if not (cfg.get("min_atr_pct", 0.35) <= atr_pct <= cfg.get("max_atr_pct", 6.0)):
        block.append(f"Volatilità fuori range ({atr_pct:.2f}%)")
    if spread_pct is not None and spread_pct > cfg.get("max_spread_pct", 0.3):
        block.append(f"Spread troppo largo ({spread_pct:.2f}%)")

    score = max(0, min(100, score))
    action = "ATTESA"
    if not block and score >= cfg.get("min_score", 70):
        action = "COMPRA"
    elif block:
        action = "EVITA"
    base.update({
        "score": score, "action": action, "reasons": (why + block)[:6],
        "ind": {"ema20": e20, "ema50": e50, "ema200": e200, "rsi": r, "adx": x, "atr": a,
                "atr_pct": atr_pct, "macd_h": m},
    })
    return base


def _pullback(base, price, e20, e50, e200, r, a, x, m, mprev, atr_pct, spread_pct, cfg, g, i):
    """Stile 'compra la correzione nel trend': entra quando un mercato rialzista ritraccia
    e il momentum riparte. Meno ingressi, prezzi migliori, meno commissioni sprecate."""
    rprev = g("rsi", i - 1)
    score, why, block = 0, [], []
    if e50 > e200 and price > e200:
        score += 30; why.append("Trend di fondo rialzista (EMA50 > EMA200)")
    else:
        block.append("Nessun trend rialzista: si resta fuori")
    if price < e20 or (rprev is not None and rprev < cfg.get("pullback_rsi", 42)):
        score += 20; why.append("Prezzo in correzione sotto EMA20")
    if rprev is not None and rprev < cfg.get("pullback_rsi", 42) and r > rprev:
        score += 25; why.append(f"RSI risale da ipervenduto relativo ({rprev:.0f}→{r:.0f})")
    if m > mprev:
        score += 15; why.append("Momentum MACD che gira al rialzo")
    if price >= e50 * (1 - cfg.get("max_below_ema50_pct", 3) / 100):
        score += 10; why.append("Prezzo vicino alla EMA50 (supporto dinamico)")
    else:
        block.append("Correzione troppo profonda sotto EMA50")
    if r > 70:
        block.append(f"RSI ipercomprato {r:.0f}")
    if not (cfg.get("min_atr_pct", 0.35) <= atr_pct <= cfg.get("max_atr_pct", 6.0)):
        block.append(f"Volatilità fuori range ({atr_pct:.2f}%)")
    if spread_pct is not None and spread_pct > cfg.get("max_spread_pct", 0.3):
        block.append(f"Spread troppo largo ({spread_pct:.2f}%)")
    score = max(0, min(100, score))
    action = "EVITA" if block else ("COMPRA" if score >= cfg.get("min_score", 70) else "ATTESA")
    base.update({
        "score": score, "action": action, "reasons": (why + block)[:6],
        "ind": {"ema20": e20, "ema50": e50, "ema200": e200, "rsi": r, "adx": x, "atr": a,
                "atr_pct": atr_pct, "macd_h": m},
    })
    return base


# --------------------------------------------------------------------- TRADER
def size_position(signal: dict, cash_eur: float, equity_eur: float, cfg: dict) -> tuple[float, str]:
    """BOT 2 · TRADER. Quanti euro investire. Rischio fisso per trade + tetto per posizione.

    Il rischio usato è il minore tra risk_per_trade_eur e max_risk_pct del patrimonio:
    con 40 € e 1,5% il rischio massimo è 0,60 € anche se config.json chiede di più."""
    a = signal["ind"].get("atr")
    if not a or a <= 0 or not signal.get("price"):
        return 0.0, "ATR non disponibile: niente acquisto"
    stop_dist_pct = cfg["stop_atr"] * a / signal["price"]
    risk_eur = min(cfg["risk_per_trade_eur"], equity_eur * cfg.get("max_risk_pct", 1.5) / 100)
    by_risk = risk_eur / max(stop_dist_pct, 1e-6)
    cap = equity_eur * cfg["max_position_pct"] / 100
    eur = min(by_risk, cap, cash_eur * 0.98)
    if eur < cfg.get("min_trade_eur", 5):
        return 0.0, f"Importo {eur:.2f}€ sotto il minimo operativo {cfg.get('min_trade_eur', 5)}€"
    return round(eur, 2), f"Rischio {risk_eur:.2f}€ con stop a {stop_dist_pct*100:.1f}% → {eur:.2f}€"


def new_position(signal: dict, qty: float, fill: float, cost_eur: float, mode: str, cfg: dict, now: float) -> dict:
    a = signal["ind"]["atr"]
    return {
        "symbol": signal["symbol"], "qty": qty, "entry": fill, "cost": cost_eur, "atr": a,
        "stop": fill - cfg["stop_atr"] * a, "tp": fill + cfg["tp_atr"] * a, "high": fill,
        "opened_at": now, "mode": mode, "score": signal["score"],
    }


def check_exit(pos: dict, bar: dict, ema50: float | None, ema200: float | None, now: float, cfg: dict,
               intrabar: bool = False) -> tuple[str, float] | None:
    """Ritorna (motivo, prezzo) se la posizione va chiusa.

    intrabar=True (backtest): stop e target si verificano su minimo/massimo della candela
    usando lo stop valido PRIMA della candela (nessun vantaggio dal futuro).
    Nel bot reale bar["c"] è il prezzo bid attuale.
    """
    if intrabar:
        if bar["l"] <= pos["stop"]:
            return ("STOP", min(bar["o"], pos["stop"]))
        if bar["h"] >= pos["tp"]:
            return ("TARGET", max(bar["o"], pos["tp"]))
    else:
        if bar["c"] <= pos["stop"]:
            return ("STOP", bar["c"])
        if bar["c"] >= pos["tp"]:
            return ("TARGET", bar["c"])
    # trailing stop: dopo +N ATR protegge l'utile seguendo il massimo raggiunto
    pos["high"] = max(pos["high"], bar["h"] if intrabar else bar["c"])
    if pos["high"] >= pos["entry"] + cfg["trail_trigger_atr"] * pos["atr"]:
        pos["stop"] = max(pos["stop"], pos["entry"] * 1.003, pos["high"] - cfg["trail_atr"] * pos["atr"])
    if ema50 is not None and ema200 is not None and (ema50 < ema200 or bar["c"] < ema200):
        return ("TREND ROTTO", bar["c"])
    hours = (now - pos["opened_at"]) / 3600
    if hours >= cfg["time_stop_hours"] and bar["c"] < pos["entry"] * 1.005:
        return ("TEMPO SCADUTO", bar["c"])
    return None
