// Cervello dei bot (porting 1:1 di bot/strategy.py, verificato con i test di parità).
// ANALISTA -> analyze(); TRADER -> sizePosition() + checkExit(). Funzioni pure.
import * as ind from "./indicators"

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }
export type Computed = Record<"ema20" | "ema50" | "ema200" | "rsi" | "atr" | "adx" | "macd_h" | "res20", ind.Series>
export type Signal = {
  symbol: string; price: number; t: number; score: number; action: string; reasons: string[]
  ind: Record<string, number>; spread_pct: number | null
  [k: string]: any
}
export type Position = {
  symbol: string; qty: number; entry: number; cost: number; atr: number; stop: number; tp: number
  high: number; opened_at: number; mode: string; score: number
}
export type Cfg = Record<string, any>

export function parseTs(v: unknown): number {
  if (typeof v === "number") return v > 1e11 ? v / 1000 : v
  const s = String(v)
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 1e11 ? n / 1000 : n
  }
  return Date.parse(s) / 1000
}

export function normalize(rows: any[]): Candle[] {
  const byT = new Map<number, Candle>()
  for (const r of rows) {
    const c: Candle = {
      t: parseTs(r.start ?? r.t),
      o: Number(r.open ?? r.o), h: Number(r.high ?? r.h), l: Number(r.low ?? r.l), c: Number(r.close ?? r.c),
      v: Number(r.volume ?? r.v ?? 0) || 0,
    }
    byT.set(c.t, c)
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

export function aggregate(cs: Candle[], minutes: number): Candle[] {
  const out: Candle[] = []
  for (const c of cs) {
    const b = Math.floor(c.t / (minutes * 60)) * minutes * 60
    const last = out[out.length - 1]
    if (last && last.t === b) {
      last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v
    } else out.push({ ...c, t: b })
  }
  return out
}

/** Scarta la candela in formazione: si decide solo su candele chiuse. */
export function closedOnly(cs: Candle[], intervalMin: number, now: number): Candle[] {
  return cs.filter((c) => c.t + intervalMin * 60 <= now)
}

export function compute(cs: Candle[]): Computed {
  const c = cs.map((x) => x.c), h = cs.map((x) => x.h), l = cs.map((x) => x.l)
  return {
    ema20: ind.ema(c, 20), ema50: ind.ema(c, 50), ema200: ind.ema(c, 200), rsi: ind.rsi(c, 14),
    atr: ind.atr(h, l, c, 14), adx: ind.adx(h, l, c, 14), macd_h: ind.macdHist(c), res20: ind.rollingMaxPrev(h, 20),
  }
}

export function analyze(symbol: string, cs: Candle[], cfg: Cfg, series?: Computed, i?: number, spreadPct: number | null = null): Signal {
  const s = series ?? compute(cs)
  const k = i ?? cs.length - 1
  const price = cs[k].c
  const g = (key: keyof Computed, j = k) => (j >= 0 && j < s[key].length ? s[key][j] : null)
  const [e20, e50, e200, r, a, x, m, mprev] = [g("ema20"), g("ema50"), g("ema200"), g("rsi"), g("atr"), g("adx"), g("macd_h"), g("macd_h", k - 1)]
  const base: Signal = { symbol, price, t: cs[k].t, score: 0, action: "ATTESA", reasons: [], ind: {}, spread_pct: spreadPct }
  if ([e20, e50, e200, r, a, x, m, mprev].some((v) => v === null)) {
    return { ...base, action: "DATI", reasons: ["Storico insufficiente per gli indicatori (servono ~220 candele)"] }
  }
  const [E20, E50, E200, R, A, X, M, MP] = [e20, e50, e200, r, a, x, m, mprev] as number[]
  const atrPct = (A / price) * 100
  const rprev = g("rsi", k - 1)
  let score = 0
  const why: string[] = [], block: string[] = []
  const pr = cfg.pullback_rsi ?? 42
  if (E50 > E200 && price > E200) { score += 30; why.push("Trend di fondo rialzista (EMA50 > EMA200)") }
  else block.push("Nessun trend rialzista: si resta fuori")
  if (price < E20 || (rprev !== null && rprev < pr)) { score += 20; why.push("Prezzo in correzione sotto EMA20") }
  if (rprev !== null && rprev < pr && R > rprev) { score += 25; why.push(`RSI risale da ipervenduto relativo (${rprev.toFixed(0)}→${R.toFixed(0)})`) }
  if (M > MP) { score += 15; why.push("Momentum MACD che gira al rialzo") }
  if (price >= E50 * (1 - (cfg.max_below_ema50_pct ?? 3) / 100)) { score += 10; why.push("Prezzo vicino alla EMA50 (supporto dinamico)") }
  else block.push("Correzione troppo profonda sotto EMA50")
  if (R > 70) block.push(`RSI ipercomprato ${R.toFixed(0)}`)
  if (!((cfg.min_atr_pct ?? 0.35) <= atrPct && atrPct <= (cfg.max_atr_pct ?? 6))) block.push(`Volatilità fuori range (${atrPct.toFixed(2)}%)`)
  if (spreadPct !== null && spreadPct > (cfg.max_spread_pct ?? 0.3)) block.push(`Spread troppo largo (${spreadPct.toFixed(2)}%)`)
  // filtri opzionali delle varianti (spenti se non configurati: comportamento base invariato)
  if (cfg.min_adx && X < cfg.min_adx) block.push(`Trend debole: ADX ${X.toFixed(0)} sotto ${cfg.min_adx}`)
  if (cfg.ema50_slope_bars) {
    const past = g("ema50", k - cfg.ema50_slope_bars)
    if (past === null || E50 <= past) block.push(`EMA50 non in salita nelle ultime ${cfg.ema50_slope_bars} candele`)
  }
  score = Math.max(0, Math.min(100, score))
  const action = block.length ? "EVITA" : score >= (cfg.min_score ?? 70) ? "COMPRA" : "ATTESA"
  return {
    ...base, score, action, reasons: [...why, ...block].slice(0, 6),
    ind: { ema20: E20, ema50: E50, ema200: E200, rsi: R, adx: X, atr: A, atr_pct: atrPct, macd_h: M },
  }
}

/** TRADER: euro da investire. Rischio = min(risk_per_trade_eur, max_risk_pct del patrimonio). */
export function sizePosition(sig: Signal, cash: number, equity: number, cfg: Cfg): [number, string] {
  const a = sig.ind.atr
  if (!a || a <= 0 || !sig.price) return [0, "ATR non disponibile: niente acquisto"]
  const stopDistPct = (cfg.stop_atr * a) / sig.price
  const riskEur = Math.min(cfg.risk_per_trade_eur, (equity * (cfg.max_risk_pct ?? 1.5)) / 100)
  const byRisk = riskEur / Math.max(stopDistPct, 1e-6)
  const cap = (equity * cfg.max_position_pct) / 100
  const eur = Math.min(byRisk, cap, cash * 0.98)
  const min = cfg.min_trade_eur ?? 5
  if (eur < min) return [0, `Importo ${eur.toFixed(2)}€ sotto il minimo operativo ${min}€`]
  return [Math.round(eur * 100) / 100, `Rischio ${riskEur.toFixed(2)}€ con stop a ${(stopDistPct * 100).toFixed(1)}% → ${eur.toFixed(2)}€`]
}

export function newPosition(sig: Signal, qty: number, fill: number, cost: number, mode: string, cfg: Cfg, now: number): Position {
  const a = sig.ind.atr
  return {
    symbol: sig.symbol, qty, entry: fill, cost, atr: a, stop: fill - cfg.stop_atr * a, tp: fill + cfg.tp_atr * a,
    high: fill, opened_at: now, mode, score: sig.score,
  }
}

/** Motivo e prezzo di uscita, oppure null. Nel bot reale bar.c è il bid attuale. */
export function checkExit(pos: Position, bar: { o: number; h: number; l: number; c: number }, ema50: number | null,
  ema200: number | null, now: number, cfg: Cfg, intrabar = false): [string, number] | null {
  if (intrabar) {
    if (bar.l <= pos.stop) return ["STOP", Math.min(bar.o, pos.stop)]
    if (bar.h >= pos.tp) return ["TARGET", Math.max(bar.o, pos.tp)]
  } else {
    if (bar.c <= pos.stop) return ["STOP", bar.c]
    if (bar.c >= pos.tp) return ["TARGET", bar.c]
  }
  pos.high = Math.max(pos.high, intrabar ? bar.h : bar.c)
  if (pos.high >= pos.entry + cfg.trail_trigger_atr * pos.atr) {
    pos.stop = Math.max(pos.stop, pos.entry * 1.003, pos.high - cfg.trail_atr * pos.atr)
  }
  if (ema50 !== null && ema200 !== null && (ema50 < ema200 || bar.c < ema200)) return ["TREND ROTTO", bar.c]
  const hours = (now - pos.opened_at) / 3600
  if (hours >= cfg.time_stop_hours && bar.c < pos.entry * 1.005) return ["TEMPO SCADUTO", bar.c]
  return null
}
