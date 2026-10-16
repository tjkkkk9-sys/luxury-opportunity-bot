// VERIFICATORE indipendente + RED TEAM. Funzioni pure, nessun I/O.
// Il Verificatore NON riusa i numeri né il codice dell'Analista: ricalcola gli indicatori dalle candele
// grezze con un'implementazione propria e confronta. Se trova un conflitto, la proposta è bloccata.
// Il Red team cerca attivamente motivi per cui l'operazione potrebbe fallire, solo con dati reali:
// un'obiezione "alta" blocca, le "medie" finiscono nella proposta come controtesi.
import type { Candle, Cfg, Signal } from "./strategy"

export type Check = { name: string; ok: boolean; detail: string }
export type Objection = { level: "alta" | "media"; text: string }
export type Verdict = { verdict: "CONFERMA" | "BLOCCA"; checks: Check[]; redteam: Objection[]; summary: string }
export type LabSym = { trades: number; win_rate: number | null; expectancy_r: number | null; profit_factor: number | null } | null
export type ForecastLite = { symbol: string; outcome?: string | null }
export type VerifyInput = {
  sig: Signal; candles: Candle[]; now: number; intervalMin: number
  ticker: { bid?: string; ask?: string; last_price?: string }
  amount: number; equity: number; cash: number; cfg: Cfg
  openSymbols?: string[] // posizioni già aperte (crypto: tutte correlate)
  recentClosed?: { symbol: string; reason: string; closed_at: number }[]
  lab?: LabSym // risultati del Laboratorio (prove storiche) per questo simbolo
  forecasts?: ForecastLite[] // previsioni già valutate per questo simbolo
}

// ---------------------------------------------------------------- indicatori, implementazione propria
/** EMA con seme = media semplice dei primi n valori. Ritorna solo l'ultimo valore. */
export function lastEma(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  let e = 0
  for (let i = 0; i < n; i++) e += xs[i]
  e /= n
  const a = 2 / (n + 1)
  for (let i = n; i < xs.length; i++) e += a * (xs[i] - e)
  return e
}
/** Media di Wilder sull'intera serie, ultimo valore. */
function lastWilder(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  let m = 0
  for (let i = 0; i < n; i++) m += xs[i]
  m /= n
  for (let i = n; i < xs.length; i++) m = m + (xs[i] - m) / n
  return m
}
export function lastRsi(closes: number[], n = 14): number | null {
  if (closes.length <= n) return null
  const up: number[] = [], dn: number[] = []
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; up.push(d > 0 ? d : 0); dn.push(d < 0 ? -d : 0) }
  const u = lastWilder(up, n), d = lastWilder(dn, n)
  if (u === null || d === null) return null
  return d === 0 ? 100 : 100 * u / (u + d)
}
export function lastAtr(cs: Candle[], n = 14): number | null {
  if (!cs.length) return null
  const tr = cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h, cs[i - 1].c) - Math.min(c.l, cs[i - 1].c)))
  return lastWilder(tr, n)
}
const rel = (a: number, b: number) => (b === 0 ? Infinity : Math.abs(a - b) / Math.abs(b))
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—")

// ---------------------------------------------------------------- Verificatore
export function verifyBuy(x: VerifyInput): Check[] {
  const { sig, candles: cs, now, intervalMin, cfg } = x
  const step = intervalMin * 60
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const last = cs[cs.length - 1]

  // 1. niente informazioni dal futuro: solo candele chiuse, e il segnale è sull'ultima
  const future = cs.filter((c) => c.t + step > now).length
  add("Nessun dato dal futuro", !!last && future === 0 && sig.t === last.t,
    future ? `${future} candele non ancora chiuse` : !last ? "nessuna candela" : sig.t !== last.t ? "il segnale non è sull'ultima candela chiusa" : "solo candele chiuse, segnale sull'ultima")
  // 2. storico continuo
  const tail = cs.slice(-220)
  let gaps = 0
  for (let i = 1; i < tail.length; i++) if (tail[i].t - tail[i - 1].t !== step) gaps++
  add("Storico continuo", tail.length >= 220 && gaps <= 2, `${tail.length} candele, ${gaps} buchi`)
  // 3-4. ricalcolo indipendente degli indicatori
  const closes = cs.map((c) => c.c)
  const e50 = lastEma(closes, 50), e200 = lastEma(closes, 200), r = lastRsi(closes, 14), a = lastAtr(cs, 14)
  const I = sig.ind ?? {}
  const emaOk = e50 !== null && e200 !== null && rel(e50, I.ema50) < 0.005 && rel(e200, I.ema200) < 0.005
  add("Ricalcolo EMA50/EMA200", emaOk, `mio ${f(e50 ?? NaN)} / ${f(e200 ?? NaN)} · Analista ${f(I.ema50)} / ${f(I.ema200)}`)
  const oscOk = r !== null && a !== null && Math.abs(r - I.rsi) <= 1.5 && rel(a, I.atr) < 0.03
  add("Ricalcolo RSI/ATR", oscOk, `mio RSI ${f(r ?? NaN, 1)} ATR ${f(a ?? NaN)} · Analista ${f(I.rsi, 1)} / ${f(I.atr)}`)
  // 5. la tesi principale regge con i miei numeri
  const trendOk = e50 !== null && e200 !== null && e50 > e200 && last.c > e200
  add("Trend rialzista confermato", trendOk, trendOk ? "EMA50 sopra EMA200 e prezzo sopra EMA200" : "con i miei calcoli il trend non è rialzista")
  // 6. due fonti diverse dicono la stessa cosa (candele vs prezzo live)
  const bid = Number(x.ticker.bid), ask = Number(x.ticker.ask)
  const live = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(x.ticker.last_price)
  const atrPct = a && last ? (a / last.c) * 100 : 0
  const tol = Math.max(3, 1.5 * atrPct)
  const div = live > 0 && last ? Math.abs(live / last.c - 1) * 100 : Infinity
  add("Prezzo live coerente con le candele", div <= tol, live > 0 ? `differenza ${f(div)}% (tolleranza ${f(tol)}%)` : "prezzo live assente")
  // 7. spread ricalcolato
  const spread = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : Infinity
  add("Spread", spread <= (cfg.max_spread_pct ?? 0.3), Number.isFinite(spread) ? `${f(spread, 3)}% (massimo ${cfg.max_spread_pct ?? 0.3}%)` : "bid/ask assenti")
  // 8. importo e rischio rifatti da zero, entro i limiti autorizzati
  const atrUse = a ?? I.atr, px = last?.c ?? sig.price
  const riskEur = atrUse && px ? (x.amount * cfg.stop_atr * atrUse) / px : Infinity
  const riskCap = Math.min(cfg.risk_per_trade_eur, (x.equity * (cfg.max_risk_pct ?? 1.5)) / 100)
  const posCap = (x.equity * (cfg.max_position_pct ?? 30)) / 100
  const sizeOk = riskEur <= riskCap * 1.02 && x.amount <= x.cash + 1e-9 && x.amount <= posCap * 1.01
  add("Importo e rischio entro i limiti", sizeOk, `rischio ${f(riskEur)} € (max ${f(riskCap)} €) · importo ${f(x.amount)} € (liquidità ${f(x.cash)} €, max posizione ${f(posCap)} €)`)
  return checks
}

// ---------------------------------------------------------------- Red team
export function redTeam(x: VerifyInput): Objection[] {
  const out: Objection[] = []
  const { candles: cs, sig, cfg, now } = x
  const last = cs[cs.length - 1], a = lastAtr(cs, 14) ?? sig.ind?.atr
  if (!last || !a) return [{ level: "alta", text: "Dati insufficienti per cercare controprove" }]
  // shock di volatilità sull'ultima candela
  const range = last.h - last.l
  if (range > 3 * a) out.push({ level: "alta", text: `Shock di volatilità: ultima candela ampia ${(range / a).toFixed(1)} ATR` })
  // coltello che cade
  const c3 = cs.slice(-4)
  if (c3.length === 4 && c3[1].c > c3[2].c && c3[2].c > c3[3].c && c3[3].c < c3[2].l)
    out.push({ level: "media", text: "Prezzo in caduta da 3 candele e sotto il minimo precedente: rischio di entrare troppo presto" })
  // volume sottile
  const vols = cs.slice(-21, -1).map((c) => c.v).filter((v) => v > 0)
  if (vols.length >= 10 && last.v > 0) {
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length
    if (last.v < 0.4 * avg) out.push({ level: "media", text: `Volume sottile: ultima candela al ${((last.v / avg) * 100).toFixed(0)}% della media` })
  }
  // stop vicino al rumore
  const bid = Number(x.ticker.bid), ask = Number(x.ticker.ask)
  const spread = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null
  const stopPct = ((cfg.stop_atr * a) / last.c) * 100
  if (spread !== null && stopPct < 4 * spread) out.push({ level: "media", text: `Stop a ${stopPct.toFixed(2)}%: troppo vicino allo spread (${spread.toFixed(3)}%)` })
  // concentrazione: le crypto si muovono insieme
  const others = (x.openSymbols ?? []).filter((s) => s !== sig.symbol)
  if (others.length) out.push({ level: "media", text: `Già aperte ${others.join(", ")}: le crypto sono correlate, il rischio reale si somma` })
  // errori recenti sullo stesso strumento
  const stops = (x.recentClosed ?? []).filter((c) => c.symbol === sig.symbol && c.reason === "STOP" && now - c.closed_at < 7 * 86400)
  if (stops.length >= 2) out.push({ level: "alta", text: `${sig.symbol}: ${stops.length} stop negli ultimi 7 giorni` })
  // prove storiche (Laboratorio)
  const lab = x.lab
  if (lab && lab.trades >= 8 && lab.expectancy_r !== null && lab.expectancy_r < 0)
    out.push({ level: "alta", text: `Prove storiche: su ${sig.symbol} la strategia perde (${lab.trades} operazioni, ${lab.expectancy_r.toFixed(2)} R in media)` })
  else if (lab && lab.trades > 0 && lab.expectancy_r !== null && lab.expectancy_r < 0)
    out.push({ level: "media", text: `Prove storiche negative ma con poche operazioni (${lab.trades}): non affidabili` })
  else if (!lab) out.push({ level: "media", text: "Nessuna prova storica disponibile per questo strumento" })
  // previsioni passate che non si sono avverate
  const done = (x.forecasts ?? []).filter((p) => p.symbol === sig.symbol && p.outcome)
  const lastN = done.slice(-5)
  if (lastN.length >= 3 && lastN.filter((p) => p.outcome === "STOP prima").length / lastN.length >= 0.6)
    out.push({ level: "media", text: `Ultime ${lastN.length} previsioni su ${sig.symbol}: la maggior parte ha toccato lo stop prima del target` })
  return out
}

export function verify(x: VerifyInput): Verdict {
  const checks = verifyBuy(x)
  const redteam = redTeam(x)
  const failed = checks.filter((c) => !c.ok), high = redteam.filter((o) => o.level === "alta")
  const verdict = failed.length || high.length ? "BLOCCA" : "CONFERMA"
  const summary = verdict === "CONFERMA"
    ? `${checks.length}/${checks.length} controlli superati · red team: ${redteam.length ? `${redteam.length} obiezioni medie` : "nessuna obiezione"}`
    : [...failed.map((c) => `${c.name}: ${c.detail}`), ...high.map((o) => `Red team: ${o.text}`)].join(" · ")
  return { verdict, checks, redteam, summary }
}
