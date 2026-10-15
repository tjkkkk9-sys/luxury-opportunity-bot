// Analista Plus500: segnali LONG/SHORT su CFD con livelli di ingresso, stop e limite da inserire a mano.
// Plus500 non ha API pubbliche: il desk NON può aprire ordini, prepara il piano e avvisa su Telegram.
// Funzioni pure: stessi indicatori e stesse regole "correzione nel trend" del desk Revolut X, in entrambe le direzioni.
import type { Candle, Computed } from "./strategy"
import { aggregate, closedOnly, compute } from "./strategy"

export type Instrument = { id: string; name: string; yahoo: string; ccy: "USD" | "EUR"; margin_pct: number; min_atr_pct: number; kind: string }

// Margine = leva massima ESMA per clienti retail (Plus500 UE): materie prime 1:10, indici principali 1:20, forex major 1:30.
export const INSTRUMENTS: Instrument[] = [
  { id: "brent", name: "Petrolio Brent", yahoo: "BZ=F", ccy: "USD", margin_pct: 10, min_atr_pct: 0.3, kind: "Materia prima" },
  { id: "wti", name: "Petrolio greggio (WTI)", yahoo: "CL=F", ccy: "USD", margin_pct: 10, min_atr_pct: 0.3, kind: "Materia prima" },
  { id: "oro", name: "Oro", yahoo: "GC=F", ccy: "USD", margin_pct: 5, min_atr_pct: 0.15, kind: "Materia prima" },
  { id: "argento", name: "Argento", yahoo: "SI=F", ccy: "USD", margin_pct: 10, min_atr_pct: 0.3, kind: "Materia prima" },
  { id: "gas", name: "Gas naturale", yahoo: "NG=F", ccy: "USD", margin_pct: 10, min_atr_pct: 0.5, kind: "Materia prima" },
  { id: "usa500", name: "USA 500 (S&P 500)", yahoo: "ES=F", ccy: "USD", margin_pct: 5, min_atr_pct: 0.15, kind: "Indice" },
  { id: "usatech", name: "USA Tech 100 (Nasdaq)", yahoo: "NQ=F", ccy: "USD", margin_pct: 5, min_atr_pct: 0.2, kind: "Indice" },
  { id: "germany40", name: "Germany 40 (DAX)", yahoo: "^GDAXI", ccy: "EUR", margin_pct: 5, min_atr_pct: 0.15, kind: "Indice" },
  { id: "eurusd", name: "EUR/USD", yahoo: "EURUSD=X", ccy: "USD", margin_pct: 3.33, min_atr_pct: 0.06, kind: "Forex" },
]
export const byId = (id: string) => INSTRUMENTS.find((i) => i.id === id)

export const P500_DEFAULT = {
  enabled: ["brent", "wti", "oro", "usatech", "germany40", "eurusd"],
  capital_eur: 500, // capitale del conto Plus500 dedicato a questi segnali (lo modifichi dal telefono)
  risk_pct: 1, // perdita massima per operazione se scatta lo stop, in % del capitale
  max_margin_pct: 25, // margine massimo impegnato da una singola operazione
  min_score: 80, pullback_rsi: 42, max_from_ema50_pct: 3, max_atr_pct: 6,
  stop_atr: 3, tp_atr: 4, breakeven_atr: 2, idea_days: 10, stale_hours: 6,
}
export type P500Cfg = typeof P500_DEFAULT

/** Converte la risposta di Yahoo Finance (chart v8) in candele, scartando le righe vuote. */
export function parseYahoo(json: any): { candles: Candle[]; ccy: string | null } {
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(json?.chart?.error?.description ?? "risposta dati vuota")
  const t: number[] = r.timestamp ?? []
  const q = r.indicators?.quote?.[0] ?? {}
  const out: Candle[] = []
  for (let i = 0; i < t.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]]
    if ([o, h, l, c].some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) continue
    out.push({ t: t[i], o, h, l, c, v: Number(q.volume?.[i] ?? 0) || 0 })
  }
  return { candles: out, ccy: r.meta?.currency ?? null }
}

/** Candele 1h -> 4h chiuse (le barre 4h sono allineate alla mezzanotte UTC). */
export function to4h(h1: Candle[], now: number): Candle[] {
  return closedOnly(aggregate(h1, 240), 240, now)
}

export type CfdSignal = {
  id: string; name: string; side: "LONG" | "SHORT" | "ATTESA" | "EVITA" | "DATI" | "CHIUSO"
  score: number; long_score: number; short_score: number; reasons: string[]
  price: number | null; t: number | null; last_t: number | null
  stop?: number; target?: number; ind: Record<string, number>; plan?: Plan | null
}
export type Plan = { exposure_eur: number; margin_eur: number; risk_eur: number; reward_eur: number; units: number; note: string }

/** Punteggio della stessa strategia in una direzione: dir=+1 compra la correzione nel rialzo, dir=-1 vende il rimbalzo nel ribasso. */
export function scoreSide(cs: Candle[], s: Computed, k: number, dir: 1 | -1, cfg: P500Cfg, minAtrPct: number) {
  const g = (key: keyof Computed, j = k) => (j >= 0 && j < s[key].length ? s[key][j] : null)
  const vals = [g("ema20"), g("ema50"), g("ema200"), g("rsi"), g("atr"), g("adx"), g("macd_h"), g("macd_h", k - 1), g("rsi", k - 1)]
  if (vals.some((v) => v === null)) return null
  const [E20, E50, E200, R, A, X, M, MP, RP] = vals as number[]
  const price = cs[k].c
  const atrPct = (A / price) * 100
  const pr = cfg.pullback_rsi
  let score = 0
  const why: string[] = [], block: string[] = []
  if (dir === 1) {
    if (E50 > E200 && price > E200) { score += 30; why.push("Trend di fondo rialzista (EMA50 > EMA200)") } else block.push("Nessun trend rialzista")
    if (price < E20 || RP < pr) { score += 20; why.push("Prezzo in correzione sotto EMA20") }
    if (RP < pr && R > RP) { score += 25; why.push(`RSI risale dall'ipervenduto (${RP.toFixed(0)}→${R.toFixed(0)})`) }
    if (M > MP) { score += 15; why.push("Momentum MACD che gira al rialzo") }
    if (price >= E50 * (1 - cfg.max_from_ema50_pct / 100)) { score += 10; why.push("Prezzo vicino alla EMA50 (supporto)") } else block.push("Correzione troppo profonda sotto EMA50")
    if (R > 70) block.push(`RSI ipercomprato ${R.toFixed(0)}`)
  } else {
    if (E50 < E200 && price < E200) { score += 30; why.push("Trend di fondo ribassista (EMA50 < EMA200)") } else block.push("Nessun trend ribassista")
    if (price > E20 || RP > 100 - pr) { score += 20; why.push("Prezzo in rimbalzo sopra EMA20") }
    if (RP > 100 - pr && R < RP) { score += 25; why.push(`RSI scende dall'ipercomprato (${RP.toFixed(0)}→${R.toFixed(0)})`) }
    if (M < MP) { score += 15; why.push("Momentum MACD che gira al ribasso") }
    if (price <= E50 * (1 + cfg.max_from_ema50_pct / 100)) { score += 10; why.push("Prezzo vicino alla EMA50 (resistenza)") } else block.push("Rimbalzo troppo ampio sopra EMA50")
    if (R < 30) block.push(`RSI ipervenduto ${R.toFixed(0)}`)
  }
  if (!(minAtrPct <= atrPct && atrPct <= cfg.max_atr_pct)) block.push(`Volatilità fuori range (${atrPct.toFixed(2)}%)`)
  return { score: Math.max(0, Math.min(100, score)), why, block, ind: { ema20: E20, ema50: E50, ema200: E200, rsi: R, adx: X, atr: A, atr_pct: atrPct, macd_h: M } }
}

/** Dimensione in euro: rischio fisso in € se scatta lo stop, limitata dal margine massimo. eurUsd = quanti USD vale 1 EUR. */
export function planTrade(inst: Instrument, side: 1 | -1, price: number, atrV: number, eurUsd: number | null, cfg: P500Cfg): Plan | null {
  const fx = inst.ccy === "EUR" ? 1 : inst.id === "eurusd" ? price : eurUsd
  if (!fx || fx <= 0 || !atrV || atrV <= 0) return null
  const riskEur = (cfg.capital_eur * cfg.risk_pct) / 100
  const stopDist = cfg.stop_atr * atrV
  // P&L per unità in valuta di quotazione = variazione di prezzo; per EUR/USD l'unità è 1 € nominale.
  const unitPrice = inst.id === "eurusd" ? 1 * price : price
  const lossPerUnitEur = stopDist / fx
  let units = riskEur / lossPerUnitEur
  const maxMargin = (cfg.capital_eur * cfg.max_margin_pct) / 100
  const marginPerUnit = (unitPrice / fx) * (inst.margin_pct / 100)
  let note = `Rischio ${riskEur.toFixed(2)} € con stop a ${((stopDist / price) * 100).toFixed(2)}%`
  if (units * marginPerUnit > maxMargin) { units = maxMargin / marginPerUnit; note += ` · ridotta per non superare ${cfg.max_margin_pct}% di margine` }
  const exposure = (units * unitPrice) / fx
  void side
  return {
    units, exposure_eur: round2(exposure), margin_eur: round2(units * marginPerUnit),
    risk_eur: round2(units * lossPerUnitEur), reward_eur: round2((units * cfg.tp_atr * atrV) / fx), note,
  }
}
const round2 = (n: number) => Math.round(n * 100) / 100

export function analyzeCfd(inst: Instrument, h1: Candle[], now: number, eurUsd: number | null, cfg: P500Cfg): CfdSignal {
  const base: CfdSignal = { id: inst.id, name: inst.name, side: "DATI", score: 0, long_score: 0, short_score: 0, reasons: [], price: null, t: null, last_t: h1.at(-1)?.t ?? null, ind: {} }
  if (!h1.length) return { ...base, reasons: ["Nessun dato di mercato ricevuto"] }
  const lastT = h1[h1.length - 1].t
  base.price = h1[h1.length - 1].c
  const cs = to4h(h1, now)
  if (cs.length < 220) return { ...base, reasons: [`Storico insufficiente (${cs.length} candele 4h, ne servono ~220)`] }
  const k = cs.length - 1
  const s = compute(cs)
  const L = scoreSide(cs, s, k, 1, cfg, inst.min_atr_pct), S = scoreSide(cs, s, k, -1, cfg, inst.min_atr_pct)
  if (!L || !S) return { ...base, reasons: ["Indicatori non ancora calcolabili"] }
  const out: CfdSignal = { ...base, price: cs[k].c, t: cs[k].t, long_score: L.score, short_score: S.score, ind: L.ind }
  // Mercato chiuso (weekend, pausa serale): nessun segnale su prezzi fermi.
  if (now - lastT > cfg.stale_hours * 3600) return { ...out, side: "CHIUSO", score: Math.max(L.score, S.score), reasons: [`Mercato chiuso: ultimo prezzo ${Math.round((now - lastT) / 3600)} h fa`] }
  const best = L.score >= S.score ? { r: L, dir: 1 as const } : { r: S, dir: -1 as const }
  const ok = !best.r.block.length && best.r.score >= cfg.min_score
  out.score = best.r.score
  out.reasons = [...best.r.why, ...best.r.block].slice(0, 6)
  if (!ok) return { ...out, side: best.r.block.length && best.r.score >= cfg.min_score ? "EVITA" : "ATTESA" }
  const A = best.r.ind.atr, px = cs[k].c
  return {
    ...out, side: best.dir === 1 ? "LONG" : "SHORT",
    stop: px - best.dir * cfg.stop_atr * A, target: px + best.dir * cfg.tp_atr * A,
    plan: planTrade(inst, best.dir, px, A, eurUsd, cfg),
  }
}

export type Idea = { id: string; side: "LONG" | "SHORT"; entry: number; stop: number; target: number; atr: number; t: number; opened: number; be: boolean }

/** Segue un segnale già inviato: avvisa se tocca stop/target, se conviene portare lo stop a pareggio o se il trend si rompe. */
export function followIdea(idea: Idea, bars: Candle[], ind: Record<string, number> | null, now: number, cfg: P500Cfg): { close?: string; px?: number; move_be?: boolean } {
  const d = idea.side === "LONG" ? 1 : -1
  for (const b of bars.filter((x) => x.t >= idea.t + 4 * 3600)) {
    const hitStop = d === 1 ? b.l <= idea.stop : b.h >= idea.stop
    const hitTp = d === 1 ? b.h >= idea.target : b.l <= idea.target
    if (hitStop) return { close: idea.be ? "STOP A PAREGGIO" : "STOP", px: idea.stop }
    if (hitTp) return { close: "TARGET", px: idea.target }
    if (!idea.be && (d === 1 ? b.h : -b.l) >= d * idea.entry + cfg.breakeven_atr * idea.atr) return { move_be: true }
  }
  if (ind && ind.ema50 && ind.ema200) {
    const last = bars.at(-1)?.c ?? idea.entry
    if (d === 1 ? ind.ema50 < ind.ema200 || last < ind.ema200 : ind.ema50 > ind.ema200 || last > ind.ema200) return { close: "TREND ROTTO", px: last }
  }
  if (now - idea.opened > cfg.idea_days * 86400) return { close: "TEMPO SCADUTO", px: bars.at(-1)?.c }
  return {}
}

export function clampP500(raw: any): P500Cfg {
  const c = { ...P500_DEFAULT, ...(raw ?? {}) }
  c.enabled = (Array.isArray(c.enabled) ? c.enabled : P500_DEFAULT.enabled).filter((x: string) => byId(x))
  c.capital_eur = Math.max(50, Math.min(1_000_000, Number(c.capital_eur) || P500_DEFAULT.capital_eur))
  c.risk_pct = Math.max(0.1, Math.min(2, Number(c.risk_pct) || P500_DEFAULT.risk_pct)) // mai oltre il 2% per operazione
  c.max_margin_pct = Math.max(5, Math.min(40, Number(c.max_margin_pct) || P500_DEFAULT.max_margin_pct))
  c.min_score = Math.max(70, Math.min(100, Number(c.min_score) || P500_DEFAULT.min_score))
  return c
}
