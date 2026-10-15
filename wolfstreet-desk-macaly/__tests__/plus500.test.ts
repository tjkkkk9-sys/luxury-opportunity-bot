// Test dell'analista Plus500 su candele reali (fixture 4h) e su casi costruiti.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as p from "../convex/lib/plus500"
import * as safety from "../convex/lib/safety"
import * as st from "../convex/lib/strategy"

const load = (s: string): st.Candle[] =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `${s}_4h.json`), "utf8")).map(([t, o, h, l, c, v]: number[]) => ({ t, o, h, l, c, v }))
const CFG = p.P500_DEFAULT
const brent = p.byId("brent")!

describe("analista Plus500", () => {
  it("LONG ha lo stesso punteggio dell'Analista Revolut X (stesse regole)", () => {
    for (const sym of ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"]) {
      const cs = load(sym), s = st.compute(cs)
      for (let k = 230; k < cs.length; k += 7) {
        const a = st.analyze(sym, cs, { ...safety.DEFAULT_CONFIG, max_below_ema50_pct: 3 }, s, k)
        const b = p.scoreSide(cs, s, k, 1, CFG, 0)!
        expect(b.score).toBe(a.score)
      }
    }
  })
  it("SHORT è lo specchio del LONG", () => {
    const cs = load("BTC-EUR")
    const M = Math.max(...cs.map((c) => c.h)) * 2
    const mir = cs.map((c) => ({ t: c.t, o: M - c.o, h: M - c.l, l: M - c.h, c: M - c.c, v: c.v }))
    const s1 = st.compute(cs), s2 = st.compute(mir)
    let checked = 0
    for (let k = 230; k < cs.length; k += 5) {
      const L = p.scoreSide(cs, s1, k, 1, { ...CFG, max_from_ema50_pct: 100 }, 0)!
      const S = p.scoreSide(mir, s2, k, -1, { ...CFG, max_from_ema50_pct: 100 }, 0)!
      expect(S.score).toBe(L.score); checked++
    }
    expect(checked).toBeGreaterThan(10)
  })
  it("niente segnale con mercato chiuso o storico corto", () => {
    const cs = load("BTC-EUR")
    const now = cs.at(-1)!.t + 4 * 3600
    expect(p.analyzeCfd(brent, cs.slice(-100), now, 1.1, CFG).side).toBe("DATI")
    expect(p.analyzeCfd(brent, cs, now + 2 * 86400, 1.1, CFG).side).toBe("CHIUSO")
    expect(p.analyzeCfd(brent, [], now, 1.1, CFG).side).toBe("DATI")
  })
  it("ogni segnale ha stop e limite dal lato giusto e rischio entro il limite", () => {
    let n = 0
    for (const sym of ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"]) {
      const cs = load(sym)
      for (let k = 230; k < cs.length; k++) {
        const now = cs[k].t + 4 * 3600
        const sig = p.analyzeCfd(brent, cs.slice(0, k + 1), now, 1.1, { ...CFG, max_atr_pct: 50 })
        if (sig.side !== "LONG" && sig.side !== "SHORT") continue
        n++
        const d = sig.side === "LONG" ? 1 : -1
        expect(d * (sig.price! - sig.stop!)).toBeGreaterThan(0)
        expect(d * (sig.target! - sig.price!)).toBeGreaterThan(0)
        expect(sig.plan!.risk_eur).toBeLessThanOrEqual(CFG.capital_eur * CFG.risk_pct / 100 + 0.01)
        expect(sig.plan!.margin_eur).toBeLessThanOrEqual(CFG.capital_eur * CFG.max_margin_pct / 100 + 0.01)
      }
    }
    expect(n).toBeGreaterThan(0)
  })
  it("dimensione: rischio in euro corretto con conversione USD", () => {
    const plan = p.planTrade(brent, 1, 100, 2, 1.25, CFG)!
    // stop 3 ATR = 6 $ = 4.8 € per unità; rischio 5 € -> 1.0417 unità; valore 100$/1.25 = 80 € per unità
    expect(plan.risk_eur).toBeCloseTo(5, 1)
    expect(plan.exposure_eur).toBeCloseTo(83.33, 1)
    expect(plan.margin_eur).toBeCloseTo(8.33, 1)
    expect(p.planTrade(brent, 1, 100, 2, null, CFG)).toBeNull()
    const fx = p.planTrade(p.byId("eurusd")!, -1, 1.1, 0.002, null, CFG)!
    expect(fx.risk_eur).toBeCloseTo(5, 1)
    expect(fx.margin_eur).toBeLessThanOrEqual(125)
  })
  it("segue il segnale: pareggio, target, stop", () => {
    const idea: p.Idea = { id: "brent", side: "SHORT", entry: 100, stop: 106, target: 92, atr: 2, t: 0, opened: 0, be: false }
    const bar = (t: number, h: number, l: number, c: number): st.Candle => ({ t, o: c, h, l, c, v: 0 })
    expect(p.followIdea(idea, [bar(14400, 101, 95.9, 96)], null, 20000, CFG).move_be).toBe(true)
    expect(p.followIdea(idea, [bar(14400, 101, 91, 92)], null, 20000, CFG).close).toBe("TARGET")
    expect(p.followIdea(idea, [bar(14400, 107, 99, 105)], null, 20000, CFG).close).toBe("STOP")
    expect(p.followIdea(idea, [bar(0, 107, 99, 105)], null, 20000, CFG).close).toBeUndefined() // candela del segnale ignorata
    expect(p.followIdea(idea, [bar(14400, 101, 99, 100)], { ema50: 110, ema200: 100 }, 20000, CFG).close).toBe("TREND ROTTO")
  })
  it("legge Yahoo scartando righe vuote, e i limiti di rischio non si scavalcano", () => {
    const j = { chart: { result: [{ meta: { currency: "USD" }, timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, null, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [0, 0, null] }] } }] } }
    expect(p.parseYahoo(j).candles.map((c) => c.t)).toEqual([1, 3])
    expect(() => p.parseYahoo({ chart: { result: null, error: { description: "No data" } } })).toThrow("No data")
    const c = p.clampP500({ risk_pct: 10, max_margin_pct: 90, min_score: 10, enabled: ["oro", "bitcoin"] })
    expect([c.risk_pct, c.max_margin_pct, c.min_score, c.enabled]).toEqual([2, 40, 70, ["oro"]])
  })
})
