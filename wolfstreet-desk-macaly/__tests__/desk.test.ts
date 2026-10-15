// Test di sicurezza del desk su candele reali Revolut X (giugno–ottobre 2026, 4h).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ApiError, emptyBook, fillFromOrder, floorStep, Office, selftest } from "../convex/lib/office"
import * as safety from "../convex/lib/safety"
import * as st from "../convex/lib/strategy"

const SYMS = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"]
const CFG = safety.DEFAULT_CONFIG
const load = (s: string): st.Candle[] =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", `${s}_4h.json`), "utf8")).map(([t, o, h, l, c, v]: number[]) => ({ t, o, h, l, c, v }))
const DATA: Record<string, st.Candle[]> = Object.fromEntries(SYMS.map((s) => [s, load(s)]))
const PAIRS = Object.fromEntries(SYMS.map((s) => [s.replace("-", "/"), { base_step: "0.00000001", quote_step: "0.01", min_order_size_quote: "0.1", status: "active" }]))

class Fake {
  fingerprint = "fp-test"; now = 0; orders: any[] = []; history: any[] = []; ordersOk: boolean
  constructor(ordersOk = true) { this.ordersOk = ordersOk }
  vis(s: string) { return DATA[s].filter((c) => c.t <= this.now) }
  async tickers(p: string[]) {
    const o: any = {}
    for (const s of p) { const px = this.vis(s).at(-1)!.c; o[s] = { bid: String(px * 0.9997), ask: String(px * 1.0003), last_price: String(px), price_change_24h: "0" } }
    return o
  }
  async candles(s: string, _i: number, count: number) { return this.vis(s).map((c) => ({ start: c.t * 1000, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })).slice(-count) }
  async pairs() { return PAIRS }
  async balances() { return { EUR: { available: "100" }, ...Object.fromEntries(SYMS.map((s) => [s.split("-")[0], { available: "1000000" }])) } }
  async marketOrder(symbol: string, side: string, coid: string, size: any) {
    this.orders.push([symbol, side, coid, size])
    if (!this.ordersOk) throw new ApiError(0, "rete")
    const px = Number((await this.tickers([symbol]))[symbol][side === "buy" ? "ask" : "bid"])
    const q = side === "buy" ? Number(size.quote_size) / px : Number(size.base_size)
    this.history.push({ client_order_id: coid, status: "filled", filled_quantity: String(q), filled_amount: String(q * px), average_fill_price: String(px) })
    return { venue_order_id: coid }
  }
  async waitFinal(_v: string | null, coid: string) { return this.history.find((o) => o.client_order_id === coid) ?? null }
  async findOrder(coid: string) { return this.history.find((o) => o.client_order_id === coid) ?? null }
}

let seq = 0
const uuid = () => `coid-${++seq}`
async function replay(ctl: safety.Control, opts: { ordersOk?: boolean; ai?: any; every?: number } = {}) {
  const fake = new Fake(opts.ordersOk ?? true)
  const state: any = {}
  const times = DATA["BTC-EUR"].map((c) => c.t).slice(300).filter((_, i) => i % (opts.every ?? 2) === 0)
  let snap: any
  for (const t of times) {
    fake.now = t + 1
    snap = await new Office(fake as any, CFG, ctl, state, t + 1, { uuid, ai: opts.ai }).run()
  }
  return { fake, state, snap, times }
}

describe("regole di sicurezza", () => {
  it("la configurazione non supera i tetti fissi", () => {
    const [cfg, notes] = safety.clampConfig({ ...CFG, max_open_positions: 5, max_position_pct: 80, max_risk_pct: 10, stop_atr: 0.2 })
    expect([cfg.max_open_positions, cfg.max_position_pct, cfg.max_risk_pct, cfg.stop_atr]).toEqual([2, 30, 1.5, 1])
    expect(notes).toHaveLength(4)
    expect(() => safety.clampConfig({ ...CFG, daily_loss_limit_eur: 0 })).toThrow()
  })
  it("il rischio per operazione è al massimo 1,5% del patrimonio", () => {
    const [cfg] = safety.clampConfig({ ...CFG, risk_per_trade_eur: 5 })
    const [eur, why] = st.sizePosition({ price: 100, ind: { atr: 1 } } as any, 40, 40, cfg)
    expect(why).toContain("Rischio 0.60€")
    expect(eur).toBeLessThanOrEqual(12)
  })
  it.each([
    [{ mode: "shadow" }, "x", "shadow"], [{ mode: "paper" }, "x", "paper"], [{ mode: "boh" }, "x", "shadow"],
    [{ mode: "live" }, "x", "shadow"], [{ mode: "live", live_armed: true, armed_key: "x", kill_switch: true }, "x", "shadow"],
    [{ mode: "live", live_armed: true, armed_key: "old" }, "new", "shadow"], [{ mode: "live", live_armed: true, armed_key: "x" }, "x", "live"],
  ])("LIVE solo con tutte le chiavi: %j", (ctl, fp, expected) => {
    expect(safety.resolveMode(ctl as any, fp)[0]).toBe(expected)
  })
})

describe("ufficio su candele reali", () => {
  it("PAPER fa operazioni senza ordini veri e massimo 2 posizioni", async () => {
    const { fake, state, snap, times } = await replay({ mode: "paper" })
    expect(state.runs).toBe(times.length)
    expect(state.books.paper.closed.length).toBe(13) // identico al desk Python sullo stesso storico
    expect(fake.orders).toHaveLength(0)
    expect(Object.keys(state.books.paper.positions).length).toBeLessThanOrEqual(2)
    expect(Math.abs(snap.kpi.equity - (state.books.paper.cash + snap.positions.reduce((s: number, p: any) => s + p.value, 0)))).toBeLessThan(1e-6)
  })
  it("SHADOW registra le decisioni senza ordini né portafoglio", async () => {
    const { fake, state, snap } = await replay({ mode: "shadow" })
    expect(fake.orders).toHaveLength(0)
    expect(state.books.paper.closed).toHaveLength(0)
    expect(state.shadow.length).toBeGreaterThan(0)
    expect(snap.mode).toBe("shadow")
  })
  it("LIVE non armato non invia mai ordini", async () => {
    const { fake, snap } = await replay({ mode: "live" })
    expect(fake.orders).toHaveLength(0)
    expect(snap.mode).toBe("shadow")
    expect(snap.live_blocks.length).toBeGreaterThan(0)
  })
  it("LIVE armato opera con client_order_id unici e senza ordini in sospeso", async () => {
    const { fake, state } = await replay({ mode: "live", live_armed: true, armed_key: "fp-test" })
    expect(fake.orders.some((o) => o[1] === "buy")).toBe(true)
    expect(new Set(fake.orders.map((o) => o[2])).size).toBe(fake.orders.length)
    expect(state.books.live.closed.length).toBeGreaterThan(0)
    expect(state.pending_orders).toHaveLength(0)
  })
  it("un ordine incerto non viene mai ripetuto e viene riconciliato", async () => {
    const fake = new Fake(false)
    const ctl: any = { mode: "live", live_armed: true, armed_key: "fp-test" }
    const state: any = {}, saved: string[] = []
    const persist = async () => { saved.push(JSON.stringify(state.pending_orders ?? [])) }
    for (const t of DATA["BTC-EUR"].map((c) => c.t).slice(300)) {
      fake.now = t + 1
      await new Office(fake as any, CFG, ctl, state, t + 1, { uuid, persist }).run()
      if (fake.orders.length) break
    }
    expect(fake.orders).toHaveLength(1)
    expect(ctl.paused).toBe(true)
    const coid = fake.orders[0][2]
    expect(saved.some((s) => s.includes(coid))).toBe(true) // salvato prima dell'invio
    fake.now += 1800
    await new Office(fake as any, CFG, ctl, state, fake.now, { uuid }).run()
    expect(fake.orders).toHaveLength(1)
    const sym = fake.orders[0][0]
    const px = Number((await fake.tickers([sym]))[sym].ask)
    fake.history.push({ client_order_id: coid, status: "filled", filled_quantity: String(10 / px), filled_amount: "10", average_fill_price: String(px), total_fee: "0.009", fee_currency: "EUR" })
    await new Office(fake as any, CFG, ctl, state, fake.now + 60, { uuid }).run()
    expect(state.pending_orders).toHaveLength(0)
    expect(state.books.live.positions[sym].cost).toBeCloseTo(10.009, 9)
    expect(fake.orders).toHaveLength(1)
  })
  it("il kill switch blocca tutto, anche gli stop", async () => {
    const fake = new Fake()
    const t = DATA["BTC-EUR"][400].t
    fake.now = t + 1
    const state: any = { books: { live: { ...emptyBook(40), cash: 30, positions: { "BTC-EUR": { symbol: "BTC-EUR", qty: 0.0001, entry: 1e9, cost: 10, atr: 1, stop: 1e9, tp: 2e9, high: 1e9, opened_at: 0, mode: "live", score: 90 } } } } }
    const snap: any = await new Office(fake as any, CFG, { mode: "live", live_armed: true, armed_key: "fp-test", kill_switch: true }, state, t + 1, { uuid }).run()
    expect(fake.orders).toHaveLength(0)
    expect(snap.errors.join(" ")).toContain("non gestite")
  })
  it("gli stop LIVE restano attivi anche con il desk disarmato", async () => {
    const fake = new Fake()
    const t = DATA["BTC-EUR"][400].t
    fake.now = t + 1
    const state: any = { books: { live: { ...emptyBook(40), cash: 30, positions: { "BTC-EUR": { symbol: "BTC-EUR", qty: 0.0001, entry: 1e9, cost: 10, atr: 1, stop: 1e9, tp: 2e9, high: 1e9, opened_at: 0, mode: "live", score: 90 } } } } }
    await new Office(fake as any, CFG, { mode: "paper" }, state, t + 1, { uuid }).run()
    expect(fake.orders.map((o) => o[1])).toEqual(["sell"])
    expect(state.books.live.positions).toEqual({})
  })
  it("dati vecchi bloccano gli acquisti", async () => {
    const fake = new Fake()
    fake.now = DATA["BTC-EUR"].at(-1)!.t + 1
    const state: any = {}
    const snap: any = await new Office(fake as any, CFG, { mode: "paper" }, state, fake.now + 3 * 86400, { uuid }).run()
    expect(Object.keys(state.books.paper.positions)).toHaveLength(0)
    expect(snap.signals.every((s: any) => s.action !== "COMPRA")).toBe(true)
  })
  it("il veto dell'IA blocca ogni acquisto", async () => {
    const { state } = await replay({ mode: "paper" }, { ai: async () => ({ verdict: "VETO", reason: "test" }) })
    expect(state.books.paper.closed).toHaveLength(0)
    expect(Object.keys(state.books.paper.positions)).toHaveLength(0)
  })
  it("la verifica arma il LIVE solo se è verde e richiesto", async () => {
    const fake = new Fake()
    const t = DATA["BTC-EUR"].at(-1)!.t
    fake.now = t + 1
    const ctl: any = { mode: "live" }
    const r = await selftest(fake as any, CFG, ctl, {}, t + 1, true)
    expect(r.green && r.armed && ctl.live_armed && ctl.armed_key === "fp-test").toBe(true)
    const ctl2: any = { mode: "live", kill_switch: true }
    const r2 = await selftest(fake as any, CFG, ctl2, {}, t + 1, true)
    expect(r2.green || ctl2.live_armed).toBe(false)
    const ctl3: any = { mode: "paper", live_armed: true }
    await selftest(fake as any, CFG, ctl3, {}, t + 1, true)
    expect(ctl3.live_armed).toBe(false)
  })
})

describe("ordini e commissioni", () => {
  it("arrotonda per difetto al passo della coppia", () => {
    expect(floorStep(10.239, "0.01")).toBe("10.23")
    expect(floorStep("0.123456789", "0.00001")).toBe("0.12345")
  })
  it("legge le commissioni dall'ordine (filled_quantity è lorda)", () => {
    const o = { filled_quantity: "0.002", filled_amount: "100", average_fill_price: "50000", total_fee: "0.000002", fee_currency: "BTC" }
    const [qty, , spent, fee] = fillFromOrder(o, "buy", "BTC", 0, 0.0009)
    expect(qty).toBeCloseTo(0.001998, 12)
    expect(spent).toBe(100)
    expect(fee).toBeCloseTo(0.1, 9)
    expect(fillFromOrder({ ...o, total_fee: "0.09", fee_currency: "EUR" }, "sell", "BTC", 0, 0.0009)[2]).toBeCloseTo(99.91, 9)
  })
})
