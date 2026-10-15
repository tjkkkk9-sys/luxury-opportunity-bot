"""Backtest: fa girare la STESSA logica dei bot (bot/strategy.py + limiti di bot/safety.py)
su candele storiche reali Revolut X.

Onestà del test:
- si decide alla chiusura della candela e si entra all'APERTURA della candela successiva
  (niente acquisto al prezzo già visto), con slippage e commissione taker;
- stop e target valutati sul minimo/massimo della candela con lo stop valido PRIMA della candela;
- risultato riportato anche con costi raddoppiati (stress test);
- sotto i 100 trade il risultato è INCONCLUSIVO, non una prova.

Uso:  python -m bot.backtest tests/fixtures      (cartella con file SIMBOLO_1h.json)
"""
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from . import safety
from . import strategy as st


def run(data: dict[str, list[dict]], cfg: dict, start_eur: float = 40.0, slippage: float = 0.0005, fee_mult: float = 1.0):
    cfg, _ = safety.clamp_config(cfg)
    fee = cfg.get("taker_fee", 0.0009) * fee_mult
    slippage *= fee_mult
    iv = cfg["interval_min"] * 60
    series = {s: st.compute(c) for s, c in data.items()}
    index = {s: {c["t"]: i for i, c in enumerate(cs)} for s, cs in data.items()}
    times = sorted({c["t"] for cs in data.values() for c in cs})
    cash, positions, closed, curve = start_eur, {}, [], []
    cooldown: dict[str, float] = {}
    pending: dict[str, dict] = {}  # segnali da eseguire all'apertura della candela successiva
    day = week = None
    day_pnl = week_pnl = 0.0
    peak = start_eur
    for t in times:
        dt = datetime.fromtimestamp(t, UTC)
        d, w = dt.date(), dt.isocalendar()[:2]
        if d != day:
            day, day_pnl = d, 0.0
        if w != week:
            week, week_pnl = w, 0.0
        now = t + iv  # fine della candela t
        # 0) esecuzione degli ingressi decisi alla candela precedente, all'apertura di questa
        for sym, sig in list(pending.items()):
            i = index[sym].get(t)
            del pending[sym]
            if i is None or sym in positions or len(positions) >= cfg["max_open_positions"]:
                continue
            fill = data[sym][i]["o"] * (1 + slippage)
            eur = min(sig["eur"], cash * 0.98)
            if eur < cfg.get("min_trade_eur", 5):
                continue
            cash -= eur
            positions[sym] = st.new_position(sig["sig"], eur * (1 - fee) / fill, fill, eur, "backtest", cfg, t)
        # 1) TRADER gestisce le posizioni aperte
        for sym in list(positions):
            i = index[sym].get(t)
            if i is None:
                continue
            pos = positions[sym]
            ex = st.check_exit(pos, data[sym][i], series[sym]["ema50"][i], series[sym]["ema200"][i], now, cfg, intrabar=True)
            if ex:
                reason, px = ex
                px *= (1 - slippage)
                proceeds = pos["qty"] * px * (1 - fee)
                pnl = proceeds - pos["cost"]
                cash += proceeds
                day_pnl += pnl
                week_pnl += pnl
                closed.append({**pos, "exit": px, "pnl": pnl, "reason": reason, "closed_at": now})
                del positions[sym]
                if reason == "STOP":
                    cooldown[sym] = now + cfg["cooldown_hours"] * 3600
        equity = cash + sum(p["qty"] * data[s][index[s][t]]["c"] if t in index[s] else p["cost"] for s, p in positions.items())
        peak = max(peak, equity)
        curve.append((now, equity))
        # 2) ANALISTA + RISK: decisione alla chiusura, esecuzione alla candela dopo
        if day_pnl <= -cfg["daily_loss_limit_eur"] or week_pnl <= -cfg["weekly_loss_limit_eur"]:
            continue
        if (peak - equity) / peak * 100 >= cfg["max_drawdown_pct"]:
            continue
        exposure = sum(p["cost"] for p in positions.values())
        for sym, candles in data.items():
            if sym in positions or len(positions) + len(pending) >= cfg["max_open_positions"] or cooldown.get(sym, 0) > now:
                continue
            i = index[sym].get(t)
            if i is None or i < 220:
                continue
            sig = st.analyze(sym, candles, cfg, series[sym], i)
            if sig["action"] != "COMPRA":
                continue
            eur, _ = st.size_position(sig, cash, equity, cfg)
            eur = min(eur, equity * cfg["max_exposure_pct"] / 100 - exposure)
            if eur < cfg.get("min_trade_eur", 5):
                continue
            exposure += eur
            pending[sym] = {"sig": sig, "eur": round(eur, 2)}
    final = cash + sum(p["qty"] * data[s][-1]["c"] for s, p in positions.items())
    return summarize(start_eur, final, closed, curve, len(positions)), closed, curve


def summarize(start, final, closed, curve, open_n):
    wins = [c for c in closed if c["pnl"] > 0]
    losses = [c for c in closed if c["pnl"] <= 0]
    mdd, pk, streak, worst = 0.0, start, 0, 0
    for _, e in curve:
        pk = max(pk, e)
        mdd = max(mdd, (pk - e) / pk * 100)
    for c in closed:
        streak = streak + 1 if c["pnl"] <= 0 else 0
        worst = max(worst, streak)
    n = len(closed)
    gross_loss = -sum(c["pnl"] for c in losses)
    return {
        "start": start, "final": round(final, 2), "return_pct": round((final / start - 1) * 100, 2),
        "trades": n, "win_rate": round(len(wins) / n * 100, 1) if n else 0,
        "avg_win": round(sum(c["pnl"] for c in wins) / len(wins), 3) if wins else 0,
        "avg_loss": round(-gross_loss / len(losses), 3) if losses else 0,
        "expectancy_eur": round(sum(c["pnl"] for c in closed) / n, 3) if n else 0,
        "profit_factor": round(sum(c["pnl"] for c in wins) / gross_loss, 2) if gross_loss > 0 else None,
        "max_drawdown_pct": round(mdd, 2), "worst_losing_streak": worst,
        "by_reason": {r: sum(1 for c in closed if c["reason"] == r) for r in sorted({c["reason"] for c in closed})},
        "open": open_n,
        "verdict": "INCONCLUSIVO (meno di 100 operazioni)" if n < 100 else "campione sufficiente",
    }


def buy_and_hold(data, start_eur=40.0, warmup=220):
    each = start_eur / len(data)
    return round(sum(each * cs[-1]["c"] / cs[warmup]["c"] for cs in data.values()), 2)


def load_folder(folder: Path, cfg: dict) -> dict[str, list[dict]]:
    data = {p.stem.split("_")[0]: st.normalize(json.loads(p.read_text())) for p in sorted(folder.glob("*_1h.json"))}
    return {s: st.aggregate(c, cfg["interval_min"]) for s, c in data.items()}


if __name__ == "__main__":
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
    cfg = json.loads((Path(__file__).parent.parent / "config.json").read_text())
    data = load_folder(folder, cfg)
    start = cfg["paper_start_eur"]
    first = min(cs[220]["t"] for cs in data.values())
    last = max(cs[-1]["t"] for cs in data.values())
    print(f"Periodo valutato: {datetime.fromtimestamp(first, UTC):%d/%m/%Y} – {datetime.fromtimestamp(last, UTC):%d/%m/%Y}")
    res, _, _ = run(data, cfg, start)
    print("Costi normali:", json.dumps(res, indent=2, ensure_ascii=False))
    res2, _, _ = run(data, cfg, start, fee_mult=2.0)
    print("Costi raddoppiati:", json.dumps({k: res2[k] for k in ("final", "return_pct", "trades", "profit_factor", "max_drawdown_pct")}, ensure_ascii=False))
    bh = buy_and_hold(data, start)
    print(f"Buy & hold stesso periodo: {bh} € ({(bh / start - 1) * 100:+.1f}%)")
