// Verificatore indipendente, red team, prove storiche e previsione → esito su candele reali Revolut X.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { backtest, evaluateForecasts, forecastSummary, labReport, PROMOTION, stats } from "../convex/lib/backtest"
import type { Forecast } from "../convex/lib/backtest"
import { Office } from "../convex/lib/office"
import * as safety from "../convex/lib/safety"
import * as st from "../convex/lib/strategy"
import { lastAtr, lastEma, lastRsi, redTeam, verify } from "../convex/lib/verifier"

const SYMS = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"]
const CFG = safety.DEFAULT_CONFIG
const load = (s: string): st.Candle[] =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `${s}_4h.json`), "utf8")).map(([t, o, h, l, c, v]: number[]) => ({ t, o, h, l, c, v }))
const DATA: Record<string, st.Candle[]> = Object.fromEntries(SYMS.map((s) => [s, load(s)]))
const STEP = 240 * 60

/** Primo segnale COMPRA reale nelle candele (con la soglia di default). */
function findBuy(): { sym: string; cs: st.Candle[]; sig: st.Signal } {
  for (const sym of SYMS) {
    const all = DATA[sym], s = st.compute(all)
    for (let i = 250; i < all.length; i++) {
      const sig = st.analyze(sym, all, CFG, s, i, 0.02)
      if (sig.action === "COMPRA") return { sym, cs: all.slice(0, i + 1), sig }
    }
  }
  throw new Error("nessun segnale nei dati")
}
const tick = (px: number) => ({ bid: String(px * 0.9999), ask: String(px * 1.0001), last_price: String(px) })
const base = () => {
  const { sym, cs, sig } = findBuy()
  const last = cs.at(-1)!
  const [amount] = st.sizePosition(sig, 100, 100, safety.clampConfig(CFG)[0])
  return { sig, candles: cs, now: last.t + STEP + 60, intervalMin: 240, ticker: tick(last.c), amount, equity: 100, cash: 100, cfg: safety.clampConfig(CFG)[0], sym }
}

describe("Verificatore indipendente", () => {
  it("i suoi indicatori, scritti a parte, coincidono con quelli dell'Analista", () => {
    const cs = DATA["BTC-EUR"], s = st.compute(cs), c = cs.map((x) => x.c), k = cs.length - 1
    expect(lastEma(c, 50)).toBeCloseTo(s.ema50[k]!, 6)
    expect(lastEma(c, 200)).toBeCloseTo(s.ema200[k]!, 6)
    expect(lastRsi(c, 14)).toBeCloseTo(s.rsi[k]!, 6)
    expect(lastAtr(cs, 14)).toBeCloseTo(s.atr[k]!, 6)
  })
  it("un segnale vero e coerente passa tutti i controlli", () => {
    const v = verify(base())
    expect(v.checks.every((c) => c.ok)).toBe(true)
  })
  it("numeri dell'Analista alterati → blocca", () => {
    const x = base()
    const v = verify({ ...x, sig: { ...x.sig, ind: { ...x.sig.ind, ema50: x.sig.ind.ema50 * 1.02 } } })
    expect(v.verdict).toBe("BLOCCA"); expect(v.summary).toMatch(/Ricalcolo EMA/)
  })
  it("candela non ancora chiusa (dato dal futuro) → blocca", () => {
    const x = base()
    expect(verify({ ...x, now: x.candles.at(-1)!.t + 60 }).summary).toMatch(/futuro/)
  })
  it("prezzo live in conflitto con le candele → blocca", () => {
    const x = base(), px = x.candles.at(-1)!.c * 1.12
    expect(verify({ ...x, ticker: tick(px) }).summary).toMatch(/Prezzo live/)
  })
  it("importo oltre il rischio autorizzato → blocca", () => {
    const x = base()
    expect(verify({ ...x, amount: x.amount * 3, cash: 1000 }).summary).toMatch(/Importo e rischio/)
  })
  it("storico con buchi → blocca", () => {
    const x = base()
    const holes = x.candles.filter((_, i) => i % 50 !== 7)
    expect(verify({ ...x, candles: holes, sig: { ...x.sig } }).checks.find((c) => c.name === "Storico continuo")!.ok).toBe(false)
  })
})

describe("Red team", () => {
  it("shock di volatilità e prove storiche negative sono obiezioni gravi", () => {
    const x = base()
    const last = x.candles.at(-1)!
    const a = lastAtr(x.candles)!
    const shock = [...x.candles.slice(0, -1), { ...last, h: last.c + 2.5 * a, l: last.c - 2.5 * a }]
    expect(redTeam({ ...x, candles: shock }).some((o) => o.level === "alta" && /volatilità/.test(o.text))).toBe(true)
    const bad = redTeam({ ...x, lab: { trades: 12, win_rate: 20, expectancy_r: -0.4, profit_factor: 0.5 } })
    expect(bad.some((o) => o.level === "alta" && /Prove storiche/.test(o.text))).toBe(true)
    expect(verify({ ...x, lab: { trades: 12, win_rate: 20, expectancy_r: -0.4, profit_factor: 0.5 } }).verdict).toBe("BLOCCA")
  })
  it("senza prove storiche lo dice, ma non inventa un blocco", () => {
    const o = redTeam(base())
    expect(o.some((x) => /Nessuna prova storica/.test(x.text) && x.level === "media")).toBe(true)
  })
  it("due stop recenti sullo stesso strumento bloccano", () => {
    const x = base()
    const rc = [1, 2].map((i) => ({ symbol: x.sig.symbol, reason: "STOP", closed_at: x.now - i * 3600 }))
    expect(verify({ ...x, recentClosed: rc }).verdict).toBe("BLOCCA")
  })
})

describe("Laboratorio: prove storiche", () => {
  it("niente dati dal futuro: tagliare lo storico non cambia le operazioni già chiuse", () => {
    const cs = DATA["ETH-EUR"]
    const full = backtest("ETH-EUR", cs, CFG)
    const cut = cs[Math.floor(cs.length * 0.75)].t
    const part = backtest("ETH-EUR", cs.filter((c) => c.t < cut), CFG)
    const closedBefore = (ts: typeof full) => ts.filter((t) => t.t_out <= cut).map((t) => [t.t_in, t.t_out, t.entry.toFixed(6), t.reason])
    expect(closedBefore(part)).toEqual(closedBefore(full))
  })
  it("si entra all'apertura della candela successiva, mai sulla candela del segnale", () => {
    const cs = DATA["BTC-EUR"]
    for (const t of backtest("BTC-EUR", cs, CFG, { slipPct: 0 })) {
      const bar = cs.find((c) => c.t === t.t_in)!
      expect(t.entry).toBeCloseTo(bar.o, 9)
    }
  })
  it("commissioni e slippage peggiorano sempre il risultato", () => {
    for (const sym of SYMS) {
      const a = backtest(sym, DATA[sym], CFG, { feePct: 0, slipPct: 0 }), b = backtest(sym, DATA[sym], CFG)
      if (!a.length) continue
      expect(stats(b).avg_pnl_pct!).toBeLessThan(stats(a).avg_pnl_pct!)
    }
  })
  it("il rapporto è ripetibile e giudica con soglie fissate prima del test", () => {
    const r1 = labReport(DATA, CFG, 1, "v"), r2 = labReport(DATA, CFG, 1, "v")
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
    expect(r1.promotion).toEqual(PROMOTION)
    expect(["SUPERATO", "NON SUPERATO", "INCONCLUSIVO"]).toContain(r1.verdict)
    expect(r1.symbols.map((s) => s.symbol)).toEqual(SYMS)
    const n = r1.total.in_sample.trades + r1.total.out_of_sample.trades
    expect(n).toBe(r1.total.all.trades)
    if (r1.verdict !== "SUPERATO") expect(r1.reasons.length).toBeGreaterThan(0)
  })
})

describe("Previsione → esito", () => {
  const mk = (over: Partial<Forecast>): Forecast => ({ id: "f", symbol: "X", t_signal: 0, created: 1000, entry: 100, stop: 95, tp: 110, horizon_h: 100, tag: "paper", score: 80, expected_win_pct: 40, outcome: null, ...over })
  const bar = (t: number, l: number, h: number, c = (l + h) / 2): st.Candle => ({ t, o: c, h, l, c, v: 1 })
  it("target, stop (prima del target se nella stessa candela) e scadenza", () => {
    const fs = [mk({ id: "a", symbol: "A" }), mk({ id: "b", symbol: "B" }), mk({ id: "c", symbol: "C", horizon_h: 8 })]
    const data = {
      A: [bar(1000, 99, 104), bar(1000 + STEP, 101, 111)],
      B: [bar(1000, 94, 112)],
      C: [bar(1000, 99, 102, 101), bar(1000 + STEP, 99, 103, 102)],
    }
    const n = evaluateForecasts(fs, data, 240, 1000 + 3 * STEP)
    expect(n).toBe(3)
    expect(fs.map((f) => f.outcome)).toEqual(["TARGET prima", "STOP prima", "SCADUTA"])
    expect(fs[0].r).toBeCloseTo(2, 9); expect(fs[1].r).toBeCloseTo(-1, 9); expect(fs[2].r).toBeCloseTo(0.4, 9)
    const sm = forecastSummary(fs)
    expect(sm.evaluated).toBe(3); expect(sm.target_first_pct).toBeCloseTo(100 / 3, 6); expect(sm.expected_win_pct).toBe(40)
  })
  it("candele precedenti alla previsione non contano", () => {
    const fs = [mk({ symbol: "A", created: 5000 })]
    evaluateForecasts(fs, { A: [bar(1000, 50, 200)] }, 240, 5000 + STEP)
    expect(fs[0].outcome).toBeNull()
  })
})

describe("Ufficio con Verificatore", () => {
  class Fake {
    fingerprint = "fp"; now = 0; orders: any[] = []; skew = 1
    vis(s: string) { return DATA[s].filter((c) => c.t + STEP <= this.now + STEP) }
    async tickers(p: string[]) { const o: any = {}; for (const s of p) { const px = this.vis(s).at(-1)!.c * this.skew; o[s] = tick(px) } return o }
    async candles(s: string) { return this.vis(s).map((c) => ({ start: c.t * 1000, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })) }
    async pairs() { return {} }
    async balances() { return { EUR: { available: "100" } } }
    async marketOrder() { this.orders.push(1); throw new Error("nessun ordine nei test") }
    async waitFinal() { return null }
    async findOrder() { return null }
  }
  async function run(skew: number) {
    const fake = new Fake(); fake.skew = skew
    const state: any = {}
    let snap: any
    for (const t of DATA["BTC-EUR"].map((c) => c.t).slice(300).filter((_, i) => i % 2 === 0)) {
      fake.now = t + 1
      snap = await new Office(fake as any, CFG, { mode: "paper" }, state, t + 1, { uuid: () => Math.random().toString(36).slice(2) }).run()
    }
    return { state, snap, fake }
  }
  it("PAPER: ogni ingresso passa dal Verificatore e lascia una previsione valutabile", async () => {
    const { state, snap } = await run(1)
    expect(state.books.paper.closed.length).toBeGreaterThan(0)
    expect(state.log.some((l: any) => l.bot === "VERIFICATORE" && /CONFERMATO/.test(l.text))).toBe(true)
    expect(state.forecasts.length).toBeGreaterThan(0)
    expect(snap.forecasts.evaluated).toBeGreaterThan(0)
  })
  it("variante seguita in avanti: solo previsioni con la sua etichetta, mai ordini né posizioni", async () => {
    const { VARIANTS } = await import("../convex/lib/backtest")
    const A = VARIANTS.find((v) => v.id === "A")!
    const fake = new Fake(); const state: any = {}
    for (const t of DATA["BTC-EUR"].map((c) => c.t).slice(300).filter((_, i) => i % 2 === 0)) {
      fake.now = t + 1
      await new Office(fake as any, CFG, { mode: "shadow" }, state, t + 1, { uuid: () => Math.random().toString(36).slice(2), track: [{ id: "A", name: A.name, cfg: A.cfg }] }).run()
    }
    const mine = state.forecasts.filter((f: any) => f.tag === "variante A (in avanti)")
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((f: any) => ["BTC-EUR", "ETH-EUR"].includes(f.symbol))).toBe(true)
    expect(new Set(mine.map((f: any) => f.symbol + f.t_signal)).size).toBe(mine.length) // una per candela
    expect(fake.orders).toHaveLength(0)
    expect(state.proposals ?? []).toHaveLength(0)
    expect(state.books?.paper?.closed ?? []).toHaveLength(0)
  })
  it("fonti in conflitto (prezzo live 10% sopra le candele): il Verificatore blocca ogni ingresso", async () => {
    const { state, fake } = await run(1.1)
    expect(Object.keys(state.books.paper.positions)).toHaveLength(0)
    expect(state.books.paper.closed).toHaveLength(0)
    expect(fake.orders).toHaveLength(0)
    expect(state.forecasts.every((f: any) => f.tag === "bloccato dal verificatore")).toBe(true)
  })
})

describe("Varianti registrate", () => {
  it("le varianti cambiano solo parametri di strategia, mai limiti o budget", async () => {
    const { VARIANTS, VARIANT_KEYS } = await import("../convex/lib/backtest")
    for (const v of VARIANTS) for (const k of Object.keys(v.cfg)) expect(VARIANT_KEYS as readonly string[]).toContain(k)
    expect(VARIANTS.length).toBeLessThanOrEqual(4)
  })
  it("i filtri delle varianti bloccano davvero, e spenti non cambiano nulla", () => {
    const cs = DATA["BTC-EUR"]
    const base = backtest("BTC-EUR", cs, CFG)
    expect(backtest("BTC-EUR", cs, { ...CFG, min_adx: 0, ema50_slope_bars: 0 })).toEqual(base)
    expect(backtest("BTC-EUR", cs, { ...CFG, min_adx: 99 })).toHaveLength(0)
    const sig = st.analyze("BTC-EUR", cs, { ...CFG, ema50_slope_bars: 6 })
    expect(sig.reasons.join() + sig.action).toBeTruthy()
  })
})
