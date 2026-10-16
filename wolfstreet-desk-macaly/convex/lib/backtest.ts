// LABORATORIO: prove storiche ripetibili e confronto previsione → esito. Funzioni pure.
// Regole: si decide sulla candela chiusa i e si entra all'apertura della candela i+1 (mai prima);
// commissioni e slippage su entrata e uscita; stop prima del target se toccati nella stessa candela.
// Gli indicatori sono causali (il valore in i usa solo candele ≤ i): un test lo verifica troncando i dati.
// Le soglie di promozione sono fissate QUI, prima di ogni test, e non si adattano ai risultati.
import * as st from "./strategy"
import type { Candle, Cfg } from "./strategy"

export const LAB_VERSION = "lab v1"
export const PROMOTION = { min_trades: 30, min_profit_factor: 1.2, min_oos_expectancy_r: 0, max_drawdown_r: 8 } as const
export const OOS_SHARE = 0.4 // ultimo 40% del periodo: dati più recenti, giudicati a parte
export const DEFAULT_SLIP_PCT = 0.05 // slippage stimato per lato, in %

/** Varianti registrate PRIMA di vederne i risultati, ciascuna con la sua motivazione. Non si aggiungono dopo il test. */
export const VARIANTS: { id: string; name: string; why: string; cfg: Record<string, any> }[] = [
  { id: "A", name: "Solo BTC+ETH", why: "SOL e XRP perdevano nelle prove: si tengono le due coppie più liquide", cfg: { pairs: ["BTC-EUR", "ETH-EUR"], min_score: 80 } },
  { id: "B", name: "BTC+ETH, trend forte", why: "Entra solo se il trend è forte (ADX ≥ 20) e la EMA50 sale da 6 candele", cfg: { pairs: ["BTC-EUR", "ETH-EUR"], min_score: 80, min_adx: 20, ema50_slope_bars: 6 } },
  { id: "C", name: "BTC+ETH, trend forte, target largo", why: "Come B, ma lascia correre i guadagni: target a 6 ATR", cfg: { pairs: ["BTC-EUR", "ETH-EUR"], min_score: 80, min_adx: 20, ema50_slope_bars: 6, tp_atr: 6 } },
  { id: "D", name: "BTC+ETH, trend forte, stop più stretto", why: "Come B, ma perdite più piccole: stop a 2 ATR, target a 4 ATR", cfg: { pairs: ["BTC-EUR", "ETH-EUR"], min_score: 80, min_adx: 20, ema50_slope_bars: 6, stop_atr: 2, tp_atr: 4 } },
]
/** Chiavi che una variante può cambiare (mai limiti di perdita, budget o tetti di sicurezza). */
export const VARIANT_KEYS = ["pairs", "min_score", "min_adx", "ema50_slope_bars", "stop_atr", "tp_atr"] as const

export type BtTrade = { symbol: string; t_in: number; t_out: number; entry: number; exit: number; stop0: number; reason: string; pnl_pct: number; r: number; oos: boolean }
export type BtStats = { trades: number; win_rate: number | null; expectancy_r: number | null; avg_pnl_pct: number | null; profit_factor: number | null; max_drawdown_r: number; avg_hold_h: number | null }

export function stats(ts: BtTrade[]): BtStats {
  const n = ts.length
  const wins = ts.filter((t) => t.r > 0), loss = ts.filter((t) => t.r <= 0)
  const gl = loss.reduce((s, t) => s + t.pnl_pct, 0)
  let cum = 0, peak = 0, mdd = 0
  for (const t of ts) { cum += t.r; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum) }
  return {
    trades: n, win_rate: n ? (wins.length / n) * 100 : null,
    expectancy_r: n ? ts.reduce((s, t) => s + t.r, 0) / n : null,
    avg_pnl_pct: n ? ts.reduce((s, t) => s + t.pnl_pct, 0) / n : null,
    profit_factor: loss.length && gl < 0 ? wins.reduce((s, t) => s + t.pnl_pct, 0) / -gl : wins.length ? Infinity : null,
    max_drawdown_r: mdd, avg_hold_h: n ? ts.reduce((s, t) => s + (t.t_out - t.t_in), 0) / n / 3600 : null,
  }
}

/** Una posizione alla volta per simbolo. `from` = primo indice in cui si può entrare. */
export function backtest(symbol: string, cs: Candle[], cfg: Cfg, opts: { feePct?: number; slipPct?: number; from?: number } = {}): BtTrade[] {
  const fee = opts.feePct ?? (cfg.taker_fee ?? 0.0009) * 100, slip = opts.slipPct ?? DEFAULT_SLIP_PCT
  const s = st.compute(cs)
  const step = (cfg.interval_min ?? 240) * 60
  const from = Math.max(opts.from ?? 0, 220)
  const oosFrom = Math.floor(from + (cs.length - from) * (1 - OOS_SHARE))
  const out: BtTrade[] = []
  let pos: (st.Position & { i: number; stop0: number }) | null = null
  for (let i = from; i < cs.length; i++) {
    const bar = cs[i]
    if (pos) {
      const ex = st.checkExit(pos, bar, s.ema50[i], s.ema200[i], bar.t + step, cfg, true)
      if (ex) {
        const exit = ex[1] * (1 - slip / 100)
        const pnl = (exit / pos.entry - 1) * 100 - 2 * fee
        out.push({ symbol, t_in: pos.opened_at, t_out: bar.t + step, entry: pos.entry, exit, stop0: pos.stop0, reason: ex[0], pnl_pct: pnl,
          r: pnl / (((pos.entry - pos.stop0) / pos.entry) * 100), oos: pos.i >= oosFrom })
        pos = null
      }
      continue
    }
    if (i + 1 >= cs.length) break
    const sig = st.analyze(symbol, cs, cfg, s, i, null)
    if (sig.action !== "COMPRA") continue
    const nxt = cs[i + 1]
    const entry = nxt.o * (1 + slip / 100)
    const p = st.newPosition(sig, 1, entry, entry, "lab", cfg, nxt.t)
    pos = { ...p, i: i + 1, stop0: p.stop }
  }
  return out
}

export type SymResult = { symbol: string; all: BtStats; in_sample: BtStats; out_of_sample: BtStats; first_t: number | null; last_t: number | null; candles: number }
export type LabReport = { t: number; version: string; strategy: string; promotion: typeof PROMOTION; fee_pct: number; slip_pct: number;
  symbols: SymResult[]; total: { all: BtStats; in_sample: BtStats; out_of_sample: BtStats }; verdict: "SUPERATO" | "NON SUPERATO" | "INCONCLUSIVO"; reasons: string[] }

export function labReport(data: Record<string, Candle[]>, cfg: Cfg, now: number, strategy: string, slipPct = DEFAULT_SLIP_PCT): LabReport {
  const all: BtTrade[] = [], symbols: SymResult[] = []
  for (const [sym, cs] of Object.entries(data)) {
    const ts = backtest(sym, cs, cfg, { slipPct })
    all.push(...ts)
    symbols.push({ symbol: sym, all: stats(ts), in_sample: stats(ts.filter((t) => !t.oos)), out_of_sample: stats(ts.filter((t) => t.oos)),
      first_t: cs[0]?.t ?? null, last_t: cs.at(-1)?.t ?? null, candles: cs.length })
  }
  all.sort((a, b) => a.t_out - b.t_out)
  const total = { all: stats(all), in_sample: stats(all.filter((t) => !t.oos)), out_of_sample: stats(all.filter((t) => t.oos)) }
  const reasons: string[] = []
  const P = PROMOTION
  if (total.all.trades < P.min_trades) reasons.push(`Solo ${total.all.trades} operazioni: ne servono almeno ${P.min_trades}`)
  if ((total.all.profit_factor ?? 0) < P.min_profit_factor) reasons.push(`Profit factor ${fmt(total.all.profit_factor)} sotto ${P.min_profit_factor}`)
  if (!((total.out_of_sample.expectancy_r ?? -1) > P.min_oos_expectancy_r)) reasons.push(`Periodo recente (mai usato per giudicare): ${fmt(total.out_of_sample.expectancy_r)} R per operazione`)
  if (total.all.max_drawdown_r > P.max_drawdown_r) reasons.push(`Calo massimo ${total.all.max_drawdown_r.toFixed(1)} R oltre ${P.max_drawdown_r} R`)
  const verdict = total.all.trades < P.min_trades ? "INCONCLUSIVO" : reasons.length ? "NON SUPERATO" : "SUPERATO"
  return { t: now, version: LAB_VERSION, strategy, promotion: P, fee_pct: (cfg.taker_fee ?? 0.0009) * 100, slip_pct: slipPct, symbols, total, verdict, reasons }
}
const fmt = (v: number | null) => (v === null ? "—" : Number.isFinite(v) ? v.toFixed(2) : "∞")

// ---------------------------------------------------------------- previsione → esito
export type Forecast = {
  id: string; symbol: string; t_signal: number; created: number; entry: number; stop: number; tp: number; horizon_h: number
  tag: string; score: number; expected_win_pct: number | null
  outcome?: "TARGET prima" | "STOP prima" | "SCADUTA" | null; closed_at?: number; exit?: number; r?: number
}

/** Valuta le previsioni aperte con le candele chiuse dopo la loro creazione. Stop prima del target se nella stessa candela. */
export function evaluateForecasts(fs: Forecast[], data: Record<string, Candle[]>, intervalMin: number, now: number): number {
  let n = 0
  const step = intervalMin * 60
  for (const p of fs) {
    if (p.outcome) continue
    const cs = (data[p.symbol] ?? []).filter((c) => c.t >= p.created && c.t + step <= now)
    const risk = p.entry - p.stop
    for (const c of cs) {
      if (c.l <= p.stop) { Object.assign(p, { outcome: "STOP prima", closed_at: c.t + step, exit: p.stop }); break }
      if (c.h >= p.tp) { Object.assign(p, { outcome: "TARGET prima", closed_at: c.t + step, exit: p.tp }); break }
    }
    if (!p.outcome && now - p.created >= p.horizon_h * 3600 && cs.length) {
      const last = cs[cs.length - 1]
      Object.assign(p, { outcome: "SCADUTA", closed_at: last.t + step, exit: last.c })
    }
    if (p.outcome) { p.r = risk > 0 ? (p.exit! - p.entry) / risk : 0; n++ }
  }
  return n
}

export function forecastSummary(fs: Forecast[]) {
  const done = fs.filter((p) => p.outcome)
  const hits = done.filter((p) => p.outcome === "TARGET prima").length
  const exp = done.filter((p) => p.expected_win_pct !== null)
  const byTag: Record<string, { n: number; target: number; avg_r: number | null }> = {}
  for (const p of done) {
    const b = (byTag[p.tag] = byTag[p.tag] ?? { n: 0, target: 0, avg_r: 0 })
    b.n++; if (p.outcome === "TARGET prima") b.target++; b.avg_r = (b.avg_r ?? 0) + (p.r ?? 0)
  }
  for (const b of Object.values(byTag)) b.avg_r = b.n ? (b.avg_r ?? 0) / b.n : null
  return {
    open: fs.length - done.length, evaluated: done.length,
    target_first_pct: done.length ? (hits / done.length) * 100 : null,
    avg_r: done.length ? done.reduce((s, p) => s + (p.r ?? 0), 0) / done.length : null,
    expected_win_pct: exp.length ? exp.reduce((s, p) => s + (p.expected_win_pct ?? 0), 0) / exp.length : null,
    by_tag: byTag,
  }
}
