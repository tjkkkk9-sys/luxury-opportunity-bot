"""Indicatori tecnici in Python puro (porting corretto del tuo engine.py).

Correzioni rispetto all'engine.py originale:
- RSI: con perdite = 0 l'originale dava NaN (divisione su loss.replace(0, nan)); qui vale 100.
- I primi valori (warm-up) sono None invece di numeri "falsi" calcolati su 1-2 candele.
- Resistenza/supporto usano solo candele precedenti (niente look-ahead).
- Nessuna dipendenza da pandas/numpy: il bot parte in pochi secondi su GitHub Actions.
"""
from __future__ import annotations


def ema(values: list[float], span: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < span:
        return out
    k = 2 / (span + 1)
    prev = sum(values[:span]) / span  # seme = media semplice delle prime N
    out[span - 1] = prev
    for i in range(span, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def wilder(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def rsi(closes: list[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = [0.0] + [max(closes[i] - closes[i - 1], 0.0) for i in range(1, len(closes))]
    losses = [0.0] + [max(closes[i - 1] - closes[i], 0.0) for i in range(1, len(closes))]
    ag = wilder(gains[1:], period)
    al = wilder(losses[1:], period)
    for i, (g, l) in enumerate(zip(ag, al), start=1):
        if g is None or l is None:
            continue
        out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    return out


def true_range(h: list[float], l: list[float], c: list[float]) -> list[float]:
    tr = [h[0] - l[0]]
    for i in range(1, len(c)):
        tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    return tr


def atr(h, l, c, period: int = 14):
    return wilder(true_range(h, l, c), period)


def macd_hist(closes: list[float], fast=12, slow=26, signal=9) -> list[float | None]:
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [a - b if a is not None and b is not None else None for a, b in zip(ef, es)]
    start = next((i for i, v in enumerate(line) if v is not None), None)
    out: list[float | None] = [None] * len(closes)
    if start is None:
        return out
    sig = ema([v for v in line[start:]], signal)
    for j, s in enumerate(sig):
        i = start + j
        if s is not None and line[i] is not None:
            out[i] = line[i] - s
    return out


def adx(h, l, c, period: int = 14) -> list[float | None]:
    n = len(c)
    out: list[float | None] = [None] * n
    if n < period * 2 + 1:
        return out
    plus, minus = [0.0], [0.0]
    for i in range(1, n):
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        plus.append(up if up > dn and up > 0 else 0.0)
        minus.append(dn if dn > up and dn > 0 else 0.0)
    tr = true_range(h, l, c)
    atr_ = wilder(tr[1:], period)
    p_ = wilder(plus[1:], period)
    m_ = wilder(minus[1:], period)
    dx: list[float] = []
    idx: list[int] = []
    for j in range(len(atr_)):
        if atr_[j] is None or not atr_[j]:
            continue
        pdi, mdi = 100 * p_[j] / atr_[j], 100 * m_[j] / atr_[j]
        dx.append(0.0 if pdi + mdi == 0 else 100 * abs(pdi - mdi) / (pdi + mdi))
        idx.append(j + 1)
    sm = wilder(dx, period)
    for k, v in enumerate(sm):
        if v is not None:
            out[idx[k]] = v
    return out


def rolling_max_prev(values: list[float], window: int) -> list[float | None]:
    """Massimo delle `window` candele PRECEDENTI (esclude la candela corrente)."""
    return [None if i < window else max(values[i - window:i]) for i in range(len(values))]
