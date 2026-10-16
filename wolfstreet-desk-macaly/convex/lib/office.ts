// WOLF STREET CAPITAL · un turno dell'ufficio (porting 1:1 di bot/office.py).
//   SISTEMA  infrastruttura: modalità effettiva (lib/safety), registro, ordini LIVE incerti
//   SCOUT    controllore dati: saldo confermato dal broker, registro = conto, prezzi e candele freschi
//   TRADER   posizioni aperte: stop, target, trailing, trend, chiusura manuale
//   ANALISTA scansione su candele chiuse e fresche
//   RISK     limiti giornalieri/settimanali, drawdown, esposizione, dati mancanti, veto IA (solo riduce o blocca)
//   TRADER   esecuzione: SHADOW registra, PAPER simula, LIVE prepara una PROPOSTA che parte solo
//            dopo la conferma del titolare (sito o Telegram), ricontrollando saldo, prezzo e limiti.
//   Se un passaggio fallisce il flusso si ferma: dato assente o vecchio = non operare.
// Nessun I/O diretto: client di mercato, salvataggio e IA vengono iniettati.
import * as safety from "./safety"
import * as st from "./strategy"
import type { Cfg, Position, Signal } from "./strategy"

const MAX_LOG = 200, MAX_CLOSED = 300, MAX_EQUITY = 1500, MAX_SHADOW = 200
export const MIN_CANDLES = 220
const PENDING_GIVE_UP_S = 15 * 60
const DEFINITE_REJECT = [400, 401, 403, 404, 409, 422] // l'API ha risposto: l'ordine NON esiste
export const FINAL_STATES = ["filled", "cancelled", "canceled", "rejected", "replaced"]
export const STRATEGY_VERSION = "pullback-trend 4h v1"
export const PROPOSAL_TTL_S = 25 * 60 // una proposta vale fino al turno successivo
export const MAX_DRIFT_PCT = 0.5 // alla conferma il prezzo d'acquisto non può essere salito oltre questa %
const DESYNC_QTY = 0.98 // sul conto meno del 98% della quantità in registro = posizione non più lì
const DESYNC_EUR = 0.5 // sul conto mancano più di 0,50 € rispetto al registro

export type Ticker = { bid?: string; ask?: string; last_price?: string; price_change_24h?: string }
export interface MarketClient {
  fingerprint: string | null
  tickers(pairs: string[]): Promise<Record<string, Ticker>>
  candles(symbol: string, interval: number, count: number): Promise<any[]>
  pairs(): Promise<Record<string, any>>
  balances(): Promise<Record<string, any>>
  marketOrder(symbol: string, side: "buy" | "sell", coid: string, size: { quote_size?: string; base_size?: string }): Promise<any>
  waitFinal(venueId: string | null, coid: string, symbol: string, sinceMs: number): Promise<any | null>
  findOrder(coid: string, symbol: string, sinceMs: number): Promise<any | null>
}
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(`HTTP ${status}: ${message}`); this.status = status }
}
export class OrderUncertain extends Error {}

export type Book = {
  cash: number; start: number; positions: Record<string, Position>; closed: any[]; equity: [number, number][]
  daily: { date: string; realized: number }; weekly: { week: string; realized: number }
  peak: number; cooldown: Record<string, number>; fees: number; eq_v2?: boolean
}
export type Proposal = {
  id: string; side: "buy" | "sell"; symbol: string; status: "in attesa" | "rifiutata" | "scaduta" | "annullata" | "eseguita" | "fallita"
  created: number; expires: number; decided?: number; ref_price: number; amount_eur?: number; qty?: number
  reason: string; score?: number; atr?: number; why?: string; result?: string; contract: Record<string, any>
}
export type State = { books?: { paper?: Book; live?: Book }; log?: any[]; runs?: number; last_run?: number; pending_orders?: any[]; shadow?: any[]; proposals?: Proposal[]; desync_seen?: string }
export type AiReview = (sig: Signal, cfg: Cfg) => Promise<{ verdict: string; reason: string } | null>

export const emptyBook = (start: number): Book => ({
  cash: start, start, positions: {}, closed: [], equity: [], daily: { date: "", realized: 0 },
  weekly: { week: "", realized: 0 }, peak: start, cooldown: {}, fees: 0,
})
const num = (v: unknown, d = 0) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? d : n }
const eur = (v: number) => v.toFixed(2).replace(".", ",") + " €"
const g6 = (v: number) => Number(v.toPrecision(6)).toString()
export const toDash = (s: string) => s.replace("/", "-").toUpperCase()
export const orderStatus = (o: any) => String(o?.status ?? o?.state ?? "").toLowerCase()
export const esc = (t: unknown) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Totale di una valuta sul conto (disponibile + riservato). */
export const balTotal = (bal: Record<string, any>, cur: string) => {
  const b = bal?.[cur]
  if (!b) return 0
  return b.total !== undefined ? num(b.total) : num(b.available) + num(b.reserved)
}
/** Differenze tra registro LIVE e conto reale: posizioni che sul conto non ci sono più, EUR mancanti. */
export function desyncOf(book: Book, bal: Record<string, any>): string[] {
  const out: string[] = []
  for (const [sym, pos] of Object.entries(book.positions)) {
    const base = sym.split("-")[0], have = balTotal(bal, base)
    if (have < pos.qty * DESYNC_QTY) out.push(`${sym}: sul conto ${have} ${base}, nel registro ${pos.qty}`)
  }
  const eurHave = balTotal(bal, "EUR")
  if (eurHave + DESYNC_EUR < book.cash) out.push(`EUR: sul conto ${eurHave.toFixed(2)} €, nel registro ${book.cash.toFixed(2)} €`)
  return out
}

function romeParts(t: number) {
  const d = new Date(t * 1000)
  const day = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" })
  const [y, m, dd] = day.split("-").map(Number)
  // settimana ISO 8601 (lunedì-domenica), come isocalendar() di Python
  const u = new Date(Date.UTC(y, m - 1, dd))
  u.setUTCDate(u.getUTCDate() + 4 - (u.getUTCDay() || 7))
  const y0 = Date.UTC(u.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((u.getTime() - y0) / 86400000 + 1) / 7)
  return { day, week: `${u.getUTCFullYear()}-W${String(week).padStart(2, "0")}` }
}
const hhmm = (t: number) => new Date(t * 1000).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })

export function floorStep(value: number | string, step: string): string {
  const dec = step.includes(".") ? step.split(".")[1].length : 0
  const f = 10 ** dec
  return (Math.floor(Number(value) * f + 1e-7) / f).toFixed(dec)
}

/** [quantità netta, prezzo medio, euro spesi/incassati netti, commissione €]. filled_quantity è LORDA. */
export function fillFromOrder(o: any, side: "buy" | "sell", base: string, fallbackPx: number, feeRate: number): [number, number, number, number] {
  const qty = num(o.filled_quantity)
  let amount = num(o.filled_amount)
  const avg = num(o.average_fill_price) || (qty && amount ? amount / qty : fallbackPx)
  if (!amount) amount = qty * avg
  const feeRaw = o.total_fee
  if (feeRaw === undefined || feeRaw === null || feeRaw === "") {
    const fe = amount * feeRate
    return side === "buy" ? [qty * (1 - feeRate), avg, amount, fe] : [qty, avg, amount - fe, fe]
  }
  const fee = num(feeRaw)
  if (String(o.fee_currency ?? "").toUpperCase() === base.toUpperCase()) {
    const fe = fee * avg
    return side === "buy" ? [qty - fee, avg, amount, fe] : [qty, avg, amount - fe, fe]
  }
  return side === "buy" ? [qty, avg, amount + fee, fee] : [qty, avg, amount - fee, fee]
}

interface Broker {
  live: boolean
  buy(sym: string, eurAmt: number, tk: Ticker, meta: any): Promise<[number, number, number, number]>
  sell(sym: string, qty: number, tk: Ticker, meta: any): Promise<[number, number, number]>
}

class PaperBroker implements Broker {
  live = false
  fee: number
  constructor(fee: number) { this.fee = fee }
  async buy(_s: string, amt: number, tk: Ticker): Promise<[number, number, number, number]> {
    const ask = Number(tk.ask)
    return [(amt * (1 - this.fee)) / ask, ask, amt, amt * this.fee]
  }
  async sell(_s: string, qty: number, tk: Ticker): Promise<[number, number, number]> {
    const bid = Number(tk.bid)
    return [bid, qty * bid * (1 - this.fee), qty * bid * this.fee]
  }
}

class Journal {
  state: State; persist: () => Promise<void>
  constructor(state: State, persist: () => Promise<void>) { this.state = state; this.persist = persist }
  get items(): any[] { return (this.state.pending_orders = this.state.pending_orders ?? []) }
  async add(item: any) { this.items.push(item); await this.persist() }
  async remove(coid: string) { this.state.pending_orders = this.items.filter((o) => o.client_order_id !== coid); await this.persist() }
}

/** Ordini VERI. Idempotente: client_order_id salvato PRIMA dell'invio; conferma assente → "in sospeso". */
class LiveBroker implements Broker {
  live = true
  c: MarketClient; pairs: Record<string, any>; fee: number; journal: Journal; uuid: () => string
  constructor(c: MarketClient, pairs: Record<string, any>, fee: number, journal: Journal, uuid: () => string) {
    this.c = c; this.pairs = pairs; this.fee = fee; this.journal = journal; this.uuid = uuid
  }
  private pair(sym: string) {
    const p = this.pairs[sym.replace("-", "/")] ?? this.pairs[sym]
    if (!p) throw new ApiError(400, `coppia ${sym} non presente in /configuration/pairs`)
    if (String(p.status ?? "active").toLowerCase() !== "active") throw new ApiError(400, `coppia ${sym} non attiva`)
    return p
  }
  private async send(sym: string, side: "buy" | "sell", meta: any, size: { quote_size?: string; base_size?: string }) {
    const coid = this.uuid()
    const sinceMs = Date.now()
    await this.journal.add({ client_order_id: coid, symbol: sym, side, size, created_ms: sinceMs, meta }) // salvato qui
    let res: any
    try {
      res = await this.c.marketOrder(sym, side, coid, size)
    } catch (e: any) {
      if (e instanceof ApiError && DEFINITE_REJECT.includes(e.status)) { await this.journal.remove(coid); throw e }
      throw new OrderUncertain(`ordine ${side} ${sym} senza risposta certa (${e?.message ?? e}): verifico al prossimo turno`)
    }
    const order = await this.c.waitFinal(res?.venue_order_id ?? null, coid, sym, sinceMs)
    if (!order) throw new OrderUncertain(`ordine ${side} ${sym} inviato ma non confermato: verifico al prossimo turno`)
    await this.journal.remove(coid)
    if (num(order.filled_quantity) <= 0) {
      throw new ApiError(0, `ordine ${side} ${sym} non eseguito (stato ${orderStatus(order)}${order.reject_reason ? ", " + order.reject_reason : ""})`)
    }
    return order
  }
  async buy(sym: string, amt: number, tk: Ticker, meta: any) {
    const p = this.pair(sym)
    const quote = floorStep(amt, p.quote_step ?? "0.01")
    if (Number(quote) < Number(p.min_order_size_quote ?? "0.1")) throw new ApiError(400, `importo ${quote} sotto il minimo della coppia`)
    const o = await this.send(sym, "buy", meta, { quote_size: quote })
    return fillFromOrder(o, "buy", sym.split("-")[0], Number(tk.ask), this.fee)
  }
  async sell(sym: string, qty: number, tk: Ticker, meta: any): Promise<[number, number, number]> {
    const p = this.pair(sym)
    const base = sym.split("-")[0]
    const avail = num((await this.c.balances())[base]?.available)
    const size = floorStep(Math.min(qty, avail), p.base_step ?? "0.00000001") // mai più di quanto comprato
    if (Number(size) <= 0) throw new ApiError(400, `nessun ${base} disponibile da vendere`)
    const o = await this.send(sym, "sell", meta, { base_size: size })
    const [, avg, proceeds, fee] = fillFromOrder(o, "sell", base, Number(tk.bid), this.fee)
    return [avg, proceeds, fee]
  }
}

export type OfficeOpts = { persist?: () => Promise<void>; ai?: AiReview; uuid?: () => string; aiEnabled?: boolean; telegram?: boolean }

export class Office {
  c: MarketClient; ctl: safety.Control; state: State; cfg: Cfg; cfgNotes: string[]; now: number
  events: string[] = []; errors: string[] = []
  persist: () => Promise<void>; ai: AiReview; uuid: () => string; opts: OfficeOpts
  mode: string; liveBlocks: string[]; exitsLive: boolean
  paper: Book; live: Book; book: Book | null; journal: Journal
  stats = { analyst: { scanned: 0, candidates: 0, ai: 0 }, risk: { checked: 0, blocked: 0, last: "" }, trader: { buys: 0, sells: 0, blocked: 0, shadow: 0, proposed: 0 } }
  bal: Record<string, any> | null = null // saldo confermato da Revolut X in questo turno
  scoutStop: string | null = null // motivo per cui niente ordini LIVE in questo turno
  scoutInfo: { checked_at: number | null; desync: string[]; prices_ok: number; prices_n: number; candles_ok: number; stale: string[] } =
    { checked_at: null, desync: [], prices_ok: 0, prices_n: 0, candles_ok: 0, stale: [] }
  newProposals: Proposal[] = []

  constructor(c: MarketClient, cfg: Cfg, ctl: safety.Control, state: State, now: number, opts: OfficeOpts = {}) {
    this.c = c; this.ctl = ctl; this.state = state; this.now = now; this.opts = opts
    ;[this.cfg, this.cfgNotes] = safety.clampConfig(cfg)
    this.persist = opts.persist ?? (async () => {})
    this.ai = opts.ai ?? (async () => null)
    this.uuid = opts.uuid ?? (() => crypto.randomUUID())
    ;[this.mode, this.liveBlocks] = safety.resolveMode(ctl, c.fingerprint)
    this.exitsLive = safety.liveExitsAllowed(ctl)
    state.books = state.books ?? {}
    this.paper = state.books.paper = state.books.paper ?? emptyBook(this.cfg.paper_start_eur)
    this.live = state.books.live = state.books.live ?? emptyBook(this.cfg.budget_eur)
    // Budget cambiato dal titolare: la differenza entra (o esce) come versamento, senza toccare il risultato.
    const delta = Math.round((this.cfg.budget_eur - this.live.start) * 100) / 100
    if (delta !== 0) {
      const d = Math.max(delta, -this.live.cash)
      this.live.start += d; this.live.cash += d
      // Il versamento non è un guadagno né una perdita: sposta anche la curva e il massimo, così il calo resta vero.
      this.live.equity = (this.live.equity ?? []).map(([t, v]) => [t, Math.round((v + d) * 1e4) / 1e4] as [number, number])
      this.live.peak = (this.live.peak ?? this.live.start - d) + d
      if (d) this.log("SISTEMA", `Budget LIVE aggiornato a ${this.live.start.toFixed(2)} € (${d > 0 ? "+" : ""}${d.toFixed(2)} € di liquidità)`)
    }
    // Riparazione una tantum: curve registrate prima che il budget spostasse anche la curva (salto > 25% in un turno).
    if (!this.live.eq_v2) {
      const e = this.live.equity ?? []
      for (let j = e.length - 2; j >= 0; j--) {
        const jump = e[j + 1][1] - e[j][1]
        if (e[j][1] > 0 && jump > e[j][1] * 0.25) {
          const d = Math.round(jump * 100) / 100
          for (let i = 0; i <= j; i++) e[i] = [e[i][0], Math.round((e[i][1] + d) * 1e4) / 1e4]
          break
        }
      }
      this.live.eq_v2 = true
    }
    this.book = this.mode === "live" ? this.live : this.mode === "paper" ? this.paper : null
    this.journal = new Journal(state, this.persist)
  }

  log(bot: string, text: string, level = "info") {
    const l = (this.state.log = this.state.log ?? [])
    l.push({ t: this.now, bot, text, level, mode: this.mode })
    this.state.log = l.slice(-MAX_LOG)
  }
  pause(reason: string) { Object.assign(this.ctl, { paused: true, pause_reason: reason }) }
  periods(b: Book) {
    const { day, week } = romeParts(this.now)
    b.daily = b.daily ?? { date: "", realized: 0 }
    b.weekly = b.weekly ?? { week: "", realized: 0 }
    if (b.daily.date !== day) b.daily = { date: day, realized: 0 }
    if (b.weekly.week !== week) b.weekly = { week, realized: 0 }
    return [b.daily, b.weekly] as const
  }
  static equity(b: Book, tk: Record<string, Ticker>) {
    let v = b.cash
    for (const [s, p] of Object.entries(b.positions)) v += tk[s]?.bid ? p.qty * Number(tk[s].bid) : p.cost
    return v
  }

  async run() {
    const cfg = this.cfg
    const pairs: string[] = cfg.pairs.map(toDash)
    for (const n of this.cfgNotes) this.log("SISTEMA", n, "warn")
    this.log("SISTEMA", `Turno #${(this.state.runs ?? 0) + 1} · modalità ${this.mode.toUpperCase()}` +
      (this.ctl.paused ? " · IN PAUSA" : "") + (this.ctl.kill_switch ? " · KILL SWITCH" : ""))
    if (this.ctl.mode === "live" && this.liveBlocks.length) {
      this.log("SISTEMA", `LIVE richiesto ma non attivo: ${this.liveBlocks.join("; ")}. Lavoro in SHADOW.`, "warn")
    }
    const tickers = await this.c.tickers(pairs)
    const liveReady = this.mode === "live" || (Object.keys(this.live.positions).length > 0 && this.exitsLive) || this.journal.items.length > 0
    const liveBroker = liveReady ? new LiveBroker(this.c, await this.c.pairs(), cfg.taker_fee, this.journal, this.uuid) : null
    const paperBroker = new PaperBroker(cfg.taker_fee)

    if (this.journal.items.length) await this.reconcile(tickers)
    this.expireProposals()
    const prOk = pairs.filter((s) => tickers[s]?.bid && tickers[s]?.ask)
    Object.assign(this.scoutInfo, { prices_ok: prOk.length, prices_n: pairs.length })
    if (this.mode === "live" || Object.keys(this.live.positions).length) await this.scout()

    const market: Record<string, [st.Candle[], st.Computed]> = {}
    for (const sym of pairs) {
      try {
        const cs = st.closedOnly(st.normalize(await this.c.candles(sym, cfg.interval_min, cfg.candles ?? 300)), cfg.interval_min, this.now)
        market[sym] = [cs, st.compute(cs)]
      } catch (e: any) {
        this.errors.push(`Candele ${sym}: ${e?.message ?? e}`)
        this.log("ANALISTA", `Non riesco a leggere le candele di ${sym}: ${e?.message ?? e}`, "error")
      }
    }

    const stale: string[] = []
    for (const sym of pairs) {
      const cs = market[sym]?.[0]
      const age = cs?.length ? (this.now - (cs[cs.length - 1].t + cfg.interval_min * 60)) / 60 : Infinity
      if (!cs || cs.length < MIN_CANDLES || age > cfg.interval_min * 1.5) stale.push(sym)
    }
    Object.assign(this.scoutInfo, { candles_ok: pairs.length - stale.length, stale })
    this.log("SCOUT", `Prezzi bid/ask ${prOk.length}/${pairs.length} · candele 4h aggiornate ${pairs.length - stale.length}/${pairs.length}` +
      (stale.length ? ` · vecchie o incomplete: ${stale.join(", ")} (niente ingressi lì)` : ""), stale.length || prOk.length < pairs.length ? "warn" : "info")

    // TRADER · posizioni aperte (LIVE prima: soldi veri)
    const panic = !!this.ctl.panic_close
    if (Object.keys(this.live.positions).length) {
      if (this.scoutStop) {
        this.log("TRADER", `Posizioni LIVE: nessuna vendita in questo turno → ${this.scoutStop}`, "warn")
      } else if (liveBroker && this.exitsLive) await this.manage(this.live, liveBroker, tickers, market, panic)
      else {
        this.log("TRADER", `${Object.keys(this.live.positions).length} posizioni LIVE aperte NON gestite (kill switch attivo): controllale su Revolut X.`, "error")
        this.errors.push("Posizioni LIVE non gestite: kill switch attivo")
      }
    }
    if (Object.keys(this.paper.positions).length) await this.manage(this.paper, paperBroker, tickers, market, panic)
    if (panic) {
      this.ctl.panic_close = false
      this.pause("Chiusura manuale eseguita: bot in pausa")
      this.log("TRADER", "Chiusura manuale completata. Ufficio in pausa finché non riattivi.", "warn")
    }

    // ANALISTA · scansione
    const signals: Signal[] = []
    for (const sym of pairs) {
      if (!market[sym]) continue
      const [cs, s] = market[sym]
      if (cs.length < 2) continue
      const tk = tickers[sym] ?? {}
      let spread: number | null = null
      if (tk.bid && tk.ask) {
        const b = Number(tk.bid), a = Number(tk.ask)
        spread = a > 0 && b > 0 ? ((a - b) / ((a + b) / 2)) * 100 : null
      }
      const sig = st.analyze(sym, cs, cfg, s, undefined, spread)
      sig.live_price = num(tk.last_price) || sig.price
      const ch = num(tk.price_change_24h, NaN), lp = num(tk.last_price, NaN)
      sig.change_24h_pct = Number.isFinite(ch) && lp && lp !== ch ? (ch / (lp - ch)) * 100 : null
      sig.candles = cs.length
      const staleMin = (this.now - (cs[cs.length - 1].t + cfg.interval_min * 60)) / 60
      const blocks: string[] = []
      if (cs.length < MIN_CANDLES) blocks.push(`Solo ${cs.length} candele chiuse (servono ${MIN_CANDLES})`)
      if (staleMin > cfg.interval_min * 1.5) blocks.push(`Dati vecchi: ultima candela chiusa ${staleMin.toFixed(0)} min fa`)
      if (spread === null) blocks.push("Prezzi bid/ask non disponibili")
      if (blocks.length && sig.action === "COMPRA") { sig.action = "EVITA"; sig.reasons = [...blocks, ...sig.reasons].slice(0, 6) }
      this.stats.analyst.scanned++
      signals.push(sig)
    }
    signals.sort((a, b) => b.score - a.score)
    for (const sig of signals) if (sig.action === "COMPRA") {
      this.stats.analyst.candidates++
      this.log("ANALISTA", `${sig.symbol} punteggio ${sig.score}/100 → COMPRA · ${sig.reasons[0] ?? ""}`)
    }
    const top = signals[0]
    if (top && top.action !== "COMPRA") this.log("ANALISTA", `Scansionate ${signals.length} coppie. Migliore ${top.symbol} ${top.score}/100: nessun ingresso.`)
    if (!signals.length) this.log("ANALISTA", "Nessuna coppia analizzabile in questo turno: nessun acquisto.", "warn")

    // RISK + TRADER
    const book = this.book
    const ref = book ?? emptyBook(cfg.budget_eur)
    let eq = Office.equity(ref, tickers)
    const gate = this.gate(ref, eq)
    for (const sig of signals) {
      if (sig.action !== "COMPRA") continue
      const sym = sig.symbol
      this.stats.risk.checked++
      if (gate) { this.blocked(sym, gate); continue }
      if (ref.positions[sym] || this.journal.items.some((o) => o.symbol === sym)) continue
      if (this.mode === "live" && this.pending(sym, "buy")) { this.log("RISK", `${sym}: proposta d'acquisto già in attesa della tua conferma`); continue }
      const pendingBuys = this.mode === "live" ? this.pendingAll("buy") : []
      if (Object.keys(ref.positions).length + pendingBuys.length >= cfg.max_open_positions) { this.blocked(sym, `già ${cfg.max_open_positions} posizioni aperte o proposte`); continue }
      if ((ref.cooldown[sym] ?? 0) > this.now) { this.blocked(sym, `in pausa dopo uno stop fino alle ${hhmm(ref.cooldown[sym])}`); continue }
      const exposure = Object.values(ref.positions).reduce((s, p) => s + p.cost, 0)
      let cash = ref.cash
      if (this.mode === "live") {
        if (!this.bal) { this.blocked(sym, "saldo EUR non confermato da Revolut X"); continue }
        cash = Math.min(cash, num(this.bal.EUR?.available)) - pendingBuys.reduce((s, p) => s + (p.amount_eur ?? 0), 0)
      }
      let [amount, why] = st.sizePosition(sig, cash, eq, cfg)
      const room = (eq * cfg.max_exposure_pct) / 100 - exposure
      if (amount > room) {
        amount = Math.round(Math.max(0, room) * 100) / 100
        why += ` · ridotto a ${amount.toFixed(2)}€ per il tetto di esposizione`
        if (amount < (cfg.min_trade_eur ?? 5)) amount = 0
      }
      if (amount <= 0) { this.blocked(sym, why); continue }
      const verdict = await this.ai(sig, cfg)
      sig.ai = verdict
      if (verdict) {
        this.stats.analyst.ai++
        this.log("ANALISTA", `IA su ${sym}: ${verdict.verdict} — ${verdict.reason}`, verdict.verdict === "VETO" ? "warn" : "info")
        if (verdict.verdict !== "APPROVA") { this.stats.risk.blocked++; this.stats.risk.last = `${sym}: veto IA`; continue }
      }
      this.stats.risk.last = `${sym}: via libera`
      const riskEur = sig.ind.atr && sig.price ? (amount * cfg.stop_atr * sig.ind.atr) / sig.price : null
      this.log("RISK", `${sym}: controlli superati · importo ${eur(amount)}${riskEur !== null ? ` · perdita massima allo stop ≈ ${eur(riskEur)}` : ""} · ${why}`)
      if (this.mode === "shadow") { this.shadow(sig, amount, why, tickers[sym] ?? {}); continue }
      if (this.mode === "live") { this.proposeBuy(sig, amount, why, tickers[sym] ?? {}, market[sym]?.[0] ?? []); continue }
      const broker = this.mode === "live" ? liveBroker! : paperBroker
      if (!(await this.buy(book!, broker, sig, amount, tickers[sym], why))) break
      eq = Office.equity(book!, tickers)
    }

    for (const b of [this.paper, this.live]) {
      if (b === book || Object.keys(b.positions).length) {
        b.equity.push([this.now, Math.round(Office.equity(b, tickers) * 1e4) / 1e4])
        b.equity = b.equity.slice(-MAX_EQUITY)
      }
    }
    this.state.runs = (this.state.runs ?? 0) + 1
    this.state.last_run = this.now
    return this.snapshot(tickers, signals)
  }

  gate(b: Book, eq: number): string | null {
    const cfg = this.cfg
    const [daily, weekly] = this.periods(b)
    b.peak = Math.max(b.peak ?? eq, eq)
    const dd = b.peak ? ((b.peak - eq) / b.peak) * 100 : 0
    if (this.ctl.kill_switch) return "Kill switch attivo"
    if (b === this.live && this.scoutStop) return `Scout: ${this.scoutStop}`
    if (this.ctl.paused) return "Ufficio in pausa" + (this.ctl.pause_reason ? ` (${this.ctl.pause_reason})` : "")
    if (this.journal.items.length) return "Ordine LIVE in sospeso da verificare"
    if (daily.realized <= -cfg.daily_loss_limit_eur) return `Stop giornaliero raggiunto (${eur(daily.realized)}): niente acquisti fino a mezzanotte`
    if (weekly.realized <= -cfg.weekly_loss_limit_eur) return `Stop settimanale raggiunto (${eur(weekly.realized)}): niente acquisti fino a lunedì`
    if (dd >= cfg.max_drawdown_pct) {
      const r = `Drawdown ${dd.toFixed(1)}% oltre il limite del ${cfg.max_drawdown_pct}%: pausa di sicurezza`
      this.pause(r)
      this.events.push(`🛑 <b>Pausa di sicurezza</b>\n${esc(r)}`)
      return r
    }
    return null
  }

  // ------------------------------------------------------------ SCOUT · controllore dati
  /** Saldo confermato dal broker e registro = conto. Se no: niente ordini LIVE in questo turno. */
  async scout() {
    try { this.bal = await this.c.balances() } catch (e: any) {
      this.scoutStop = `Revolut X non conferma il saldo (${e?.message ?? e})`
      this.errors.push(this.scoutStop)
      this.log("SCOUT", `${this.scoutStop}: mi fermo, nessuna proposta e nessuna vendita LIVE in questo turno.`, "error")
      return
    }
    this.scoutInfo.checked_at = this.now
    const desync = desyncOf(this.live, this.bal)
    this.scoutInfo.desync = desync
    const coins = Object.keys(this.live.positions).map((s) => s.split("-")[0])
    this.log("SCOUT", `Saldo confermato da Revolut X alle ${hhmm(this.now)} · EUR disponibili ${eur(num(this.bal.EUR?.available))}` +
      coins.map((c) => ` · ${c} ${balTotal(this.bal!, c)}`).join(""))
    if (!desync.length) { this.state.desync_seen = ""; return }
    this.scoutStop = "registro e conto Revolut X non coincidono"
    const msg = `Registro e conto non coincidono → ${desync.join(" · ")}. Probabile vendita o prelievo fatto fuori dal desk. ` +
      `Nessuna proposta e nessuna vendita finché non allinei il registro (Comandi → Allinea al conto).`
    this.errors.push(`Scout: ${desync.join(" · ")}`)
    this.log("SCOUT", msg, "error")
    const key = desync.join("|")
    if (this.state.desync_seen !== key) { // un solo avviso per la stessa differenza
      this.state.desync_seen = key
      this.events.push(`🛑 <b>Scout: registro e conto non coincidono</b>\n${desync.map((d) => "• " + esc(d)).join("\n")}\nNessun ordine finché non premi <b>Allinea al conto</b> sul sito.`)
    }
  }

  // ------------------------------------------------------------ PROPOSTE (LIVE: parte solo con la tua conferma)
  get proposals(): Proposal[] { return (this.state.proposals = this.state.proposals ?? []) }
  pending(sym: string, side: "buy" | "sell") { return this.proposals.find((p) => p.status === "in attesa" && p.symbol === sym && p.side === side) }
  pendingAll(side: "buy" | "sell") { return this.proposals.filter((p) => p.status === "in attesa" && p.side === side) }
  expireProposals() {
    for (const p of this.proposals) if (p.status === "in attesa" && this.now > p.expires) {
      p.status = "scaduta"; p.decided = this.now
      this.log("TRADER", `Proposta ${p.side === "buy" ? "d'acquisto" : "di vendita"} ${p.symbol} scaduta senza conferma: nessun ordine inviato.`)
    }
    this.state.proposals = this.proposals.slice(-30)
  }
  private addProposal(p: Proposal) {
    this.proposals.push(p); this.state.proposals = this.proposals.slice(-30)
    this.newProposals.push(p); this.stats.trader.proposed++
  }

  proposeBuy(sig: Signal, amount: number, why: string, tk: Ticker, cs: st.Candle[]) {
    const cfg = this.cfg, px = num(tk.ask) || sig.price, a = sig.ind.atr
    const stop = px - cfg.stop_atr * a, tp = px + cfg.tp_atr * a
    const riskEur = (amount * (px - stop)) / px
    const spread = sig.spread_pct ?? null
    const costs = amount * cfg.taker_fee * 2 + (spread !== null ? (amount * spread) / 100 : 0)
    const last = cs[cs.length - 1]
    const closed = this.live.closed.length
    const p: Proposal = {
      id: this.uuid(), side: "buy", symbol: sig.symbol, status: "in attesa", created: this.now, expires: this.now + PROPOSAL_TTL_S,
      ref_price: px, amount_eur: amount, reason: "INGRESSO", score: sig.score, atr: a, why,
      contract: {
        mercato: "Revolut X · spot (niente leva)",
        fonte: `Revolut X: candele 4h chiuse fino alle ${last ? hhmm(last.t + cfg.interval_min * 60) : "—"}, bid/ask letti alle ${hhmm(this.now)}`,
        strategia: `${STRATEGY_VERSION} · soglia ${cfg.min_score} · stop ${cfg.stop_atr} ATR · target ${cfg.tp_atr} ATR`,
        fatti: [`Punteggio regole ${sig.score}/100`, ...sig.reasons.slice(0, 4),
          `RSI ${g6(sig.ind.rsi ?? NaN)} · ADX ${g6(sig.ind.adx ?? NaN)} · ATR ${g6(sig.ind.atr_pct ?? NaN)}%`],
        ipotesi: ["Il trend di fondo 4h resta rialzista (EMA50 sopra EMA200)", "La correzione in corso si esaurisce vicino ai livelli attuali"],
        controtesi: [`Chiusura sotto lo stop ${g6(stop)} (−${(((px - stop) / px) * 100).toFixed(1)}%)`, "EMA50 che scende sotto EMA200: trend rotto, uscita",
          `Alla conferma il prezzo è salito oltre ${g6(px * (1 + MAX_DRIFT_PCT / 100))}: la proposta si annulla da sola`],
        costi: `≈ ${eur(costs)} (commissioni entrata+uscita${spread !== null ? ` + spread ${spread.toFixed(3)}%` : ""})`,
        quantita: `${eur(amount)} a mercato ≈ ${g6(amount / px)} ${sig.symbol.split("-")[0]} · stop ${g6(stop)} · target ${g6(tp)}`,
        rischio: `perdita massima allo stop ≈ ${eur(riskEur)} (senza slippage) · ${why}`,
        mancano: ["Nessuna fonte di notizie collegata", ...(this.opts.aiEnabled ? [] : ["Revisione IA non attiva"]),
          `Confidenza non calibrata: solo ${closed} operazioni LIVE chiuse, nessuna percentuale mostrata`],
      },
    }
    this.addProposal(p)
    this.log("TRADER", `PROPOSTA acquisto ${sig.symbol} ${eur(amount)} @ ≈${g6(px)} · stop ${g6(stop)} · in attesa della tua conferma (scade alle ${hhmm(p.expires)})`)
  }

  proposeSell(sym: string, pos: Position, tk: Ticker, reason: string) {
    const bid = num(tk.bid)
    if (this.pending(sym, "sell")) { this.log("TRADER", `${sym}: ${reason} · vendita già proposta, in attesa della tua conferma`, "warn"); return }
    const base = sym.split("-")[0], have = num(this.bal?.[base]?.available)
    const qty = Math.min(pos.qty, have)
    if (qty <= 0) { this.log("TRADER", `${sym}: ${reason} ma sul conto non ci sono ${base} disponibili: nessuna proposta di vendita`, "warn"); return }
    const pnl = qty * bid * (1 - this.cfg.taker_fee) - pos.cost * (qty / pos.qty)
    const p: Proposal = {
      id: this.uuid(), side: "sell", symbol: sym, status: "in attesa", created: this.now, expires: this.now + PROPOSAL_TTL_S,
      ref_price: bid, qty, reason,
      contract: {
        mercato: "Revolut X · spot", fonte: `Revolut X: bid letto alle ${hhmm(this.now)}, saldo ${base} confermato alle ${hhmm(this.now)}`,
        strategia: STRATEGY_VERSION,
        fatti: [`Motivo d'uscita: ${reason}`, `Entrata ${g6(pos.entry)} · ora ${g6(bid)} (${((bid / pos.entry - 1) * 100).toFixed(2)}%)`, `Stop ${g6(pos.stop)} · target ${g6(pos.tp)}`],
        ipotesi: [], controtesi: ["Se non confermi, la posizione resta aperta e la proposta si ripete al prossimo turno"],
        costi: `≈ ${eur(qty * bid * this.cfg.taker_fee)} di commissione`,
        quantita: `${g6(qty)} ${base} a mercato (disponibili sul conto ${have})`,
        rischio: `risultato stimato ${pnl >= 0 ? "+" : ""}${eur(pnl)}`,
        mancano: ["Il prezzo d'esecuzione può differire dal bid letto"],
      },
    }
    this.addProposal(p)
    this.log("TRADER", `PROPOSTA vendita ${sym} (${reason}) ${g6(qty)} @ ≈${g6(bid)} · in attesa della tua conferma`, "warn")
  }

  /** Decisione del titolare. Prima di inviare: Scout di nuovo (saldo, prezzo), limiti, prezzo non scappato. */
  async decide(id: string, approve: boolean): Promise<{ ok: boolean; text: string }> {
    const p = this.proposals.find((x) => x.id === id)
    if (!p) return { ok: false, text: "Proposta non trovata" }
    const what = `${p.side === "buy" ? "acquisto" : "vendita"} ${p.symbol}`
    if (p.status !== "in attesa") return { ok: false, text: `Proposta di ${what} già ${p.status}` }
    p.decided = this.now
    if (!approve) { p.status = "rifiutata"; this.log("TRADER", `Proposta di ${what} rifiutata dal titolare: nessun ordine.`); return { ok: true, text: `Rifiutata: nessun ordine per ${p.symbol}.` } }
    if (this.now > p.expires) { p.status = "scaduta"; return { ok: false, text: `Proposta di ${what} scaduta: nessun ordine.` } }
    const stop = (why: string) => {
      p.status = "annullata"; p.result = why
      this.log("TRADER", `Proposta di ${what} annullata prima dell'invio: ${why}`, "warn")
      return { ok: false, text: `Annullata, nessun ordine: ${why}` }
    }
    try { this.bal = await this.c.balances() } catch (e: any) { return stop(`Revolut X non conferma il saldo (${e?.message ?? e})`) }
    const desync = desyncOf(this.live, this.bal)
    if (desync.length) return stop(`registro e conto non coincidono (${desync.join(" · ")})`)
    let tk: Ticker
    try { tk = (await this.c.tickers([p.symbol]))[p.symbol] ?? {} } catch (e: any) { return stop(`prezzo non leggibile (${e?.message ?? e})`) }
    if (!tk.bid || !tk.ask) return stop("prezzo bid/ask non disponibile")
    const broker = new LiveBroker(this.c, await this.c.pairs(), this.cfg.taker_fee, this.journal, this.uuid)
    const base = p.symbol.split("-")[0]
    if (p.side === "buy") {
      if (this.mode !== "live") return stop(`LIVE non attivo (${this.liveBlocks.join("; ") || this.mode})`)
      const g = this.gate(this.live, Office.equity(this.live, { [p.symbol]: tk }))
      if (g) return stop(g)
      if (this.live.positions[p.symbol]) return stop("posizione già aperta")
      const ask = num(tk.ask)
      if (ask > p.ref_price * (1 + MAX_DRIFT_PCT / 100)) return stop(`prezzo salito a ${g6(ask)} (+${((ask / p.ref_price - 1) * 100).toFixed(2)}% dalla proposta, massimo ${MAX_DRIFT_PCT}%)`)
      const avail = num(this.bal.EUR?.available)
      const amount = Math.floor(Math.min(p.amount_eur ?? 0, avail, this.live.cash) * 100) / 100
      if (amount < (this.cfg.min_trade_eur ?? 5)) return stop(`EUR disponibili ${eur(avail)}: sotto il minimo di ${eur(this.cfg.min_trade_eur ?? 5)}`)
      const sig = { symbol: p.symbol, score: p.score ?? 0, price: p.ref_price, ind: { atr: p.atr ?? ask * 0.02 } } as unknown as Signal
      const ok = await this.buy(this.live, broker, sig, amount, tk, `${p.why ?? ""} · confermato dal titolare`)
      p.status = ok ? "eseguita" : "fallita"
      p.result = ok ? `Comprato per ${eur(this.live.positions[p.symbol]?.cost ?? amount)}` : (this.errors.at(-1) ?? "ordine non riuscito")
    } else {
      if (!this.exitsLive) return stop("kill switch attivo")
      const pos = this.live.positions[p.symbol]
      if (!pos) return stop("posizione non più nel registro")
      if (num(this.bal[base]?.available) <= 0) return stop(`sul conto non ci sono ${base} disponibili`)
      await this.sell(this.live, broker, p.symbol, pos, tk, `${p.reason} · confermato dal titolare`)
      const ok = !this.live.positions[p.symbol]
      p.status = ok ? "eseguita" : "fallita"
      p.result = ok ? "Venduto" : (this.errors.at(-1) ?? "vendita non riuscita")
    }
    return { ok: p.status === "eseguita", text: `${p.status === "eseguita" ? "Eseguito" : "Non riuscito"}: ${what} · ${p.result}` }
  }

  /** Solo su comando del titolare: riporta il registro LIVE al saldo reale di Revolut X.
   *  Posizioni non più sul conto → chiuse come "uscita fuori dal desk" (prezzo stimato sul bid);
   *  EUR in più o in meno → versamento o prelievo (non è un guadagno né una perdita). Ritorna il nuovo budget. */
  async alignToBroker(): Promise<{ notes: string[]; budget: number }> {
    const bal = await this.c.balances()
    const syms = Object.keys(this.live.positions)
    const tk = syms.length ? await this.c.tickers(syms) : {}
    const notes: string[] = []
    for (const sym of syms) {
      const pos = this.live.positions[sym], base = sym.split("-")[0], have = balTotal(bal, base)
      if (have >= pos.qty * DESYNC_QTY) continue
      const bid = num(tk[sym]?.bid) || pos.entry
      if (have <= 0) {
        const proceeds = pos.qty * bid * (1 - this.cfg.taker_fee)
        this.close(this.live, sym, pos, bid, proceeds, pos.qty * bid * this.cfg.taker_fee, "USCITA FUORI DAL DESK (prezzo stimato)", true)
        notes.push(`${sym}: non più sul conto, chiusa come uscita fuori dal desk a ≈${g6(bid)} (stima)`)
      } else {
        const f = have / pos.qty
        pos.cost *= f; pos.qty = have
        notes.push(`${sym}: quantità ridotta a ${have} ${base} come sul conto`)
      }
    }
    const d = balTotal(bal, "EUR") - this.live.cash
    if (Math.abs(d) >= 0.005) {
      this.live.start += d; this.live.cash += d
      this.live.equity = (this.live.equity ?? []).map(([t, v]) => [t, Math.round((v + d) * 1e4) / 1e4] as [number, number])
      this.live.peak = (this.live.peak ?? this.live.start - d) + d
      notes.push(`EUR: ${d > 0 ? "versamento" : "prelievo"} di ${eur(Math.abs(d))} registrato (non è un risultato di trading)`)
    }
    this.state.desync_seen = ""
    const budget = Math.max(0.01, Math.round(this.live.start * 100) / 100)
    this.log("SCOUT", notes.length ? `Registro allineato al conto su comando del titolare: ${notes.join(" · ")}` : "Registro già allineato al conto: nessuna modifica.", notes.length ? "warn" : "info")
    return { notes, budget }
  }

  blocked(sym: string, why: string) {
    this.stats.trader.blocked++; this.stats.risk.blocked++
    this.stats.risk.last = `${sym}: ${why}`
    this.log("RISK", `${sym}: segnale valido ma bloccato → ${why}`, "warn")
  }

  async manage(b: Book, broker: Broker, tk: Record<string, Ticker>, market: Record<string, [st.Candle[], st.Computed]>, panic: boolean) {
    for (const sym of Object.keys(b.positions)) {
      const pos = b.positions[sym], t = tk[sym] ?? {}
      if (!t.bid) { this.log("TRADER", `${sym}: prezzo non disponibile, controllo rimandato`, "warn"); continue }
      const bid = Number(t.bid)
      let e50: number | null = null, e200: number | null = null
      if (market[sym]?.[0].length) { const s = market[sym][1]; e50 = s.ema50[s.ema50.length - 1]; e200 = s.ema200[s.ema200.length - 1] }
      const ex: [string, number] | null = panic ? ["CHIUSURA MANUALE", bid] : st.checkExit(pos, { o: bid, h: bid, l: bid, c: bid }, e50, e200, this.now, this.cfg)
      if (ex && broker.live && !panic) this.proposeSell(sym, pos, t, ex[0])
      else if (ex) { if (!(await this.sell(b, broker, sym, pos, t, ex[0]))) break }
      else this.log("TRADER", `Tengo ${sym} (${broker.live ? "LIVE" : "PAPER"}): ${((bid / pos.entry - 1) * 100).toFixed(2)}% · stop ${g6(pos.stop)} · target ${g6(pos.tp)}`)
    }
  }

  shadow(sig: Signal, amount: number, why: string, tk: Ticker) {
    const a = sig.ind.atr, px = num(tk.ask) || sig.price
    const j = (this.state.shadow = this.state.shadow ?? [])
    j.push({ t: this.now, symbol: sig.symbol, score: sig.score, eur: amount, price: px, stop: px - this.cfg.stop_atr * a, tp: px + this.cfg.tp_atr * a, why })
    this.state.shadow = j.slice(-MAX_SHADOW)
    this.stats.trader.shadow++
    this.log("TRADER", `SHADOW · avrei comprato ${sig.symbol} per ${eur(amount)} @ ${g6(px)} · ${why}`, "trade")
  }

  async buy(b: Book, broker: Broker, sig: Signal, amount: number, tk: Ticker, why: string): Promise<boolean> {
    const sym = sig.symbol
    try {
      const [qty, fill, spent, fee] = await broker.buy(sym, amount, tk, { atr: sig.ind.atr, score: sig.score, mode: this.mode })
      this.open(b, sig, qty, fill, spent, fee, why, broker.live)
      return true
    } catch (e: any) {
      if (e instanceof OrderUncertain) {
        this.pause(`Ordine ${sym} non confermato: verifico al prossimo turno`)
        this.errors.push(e.message); this.log("TRADER", e.message, "error")
        this.events.push(`⚠️ <b>Ordine non confermato</b>\n${esc(e.message)}\nUfficio in pausa: niente nuovi acquisti.`)
      } else {
        this.errors.push(`Acquisto ${sym}: ${e?.message ?? e}`)
        this.log("TRADER", `Acquisto ${sym} FALLITO: ${e?.message ?? e}`, "error")
        this.events.push(`⚠️ Acquisto ${esc(sym)} fallito: ${esc(e?.message ?? e)}`)
      }
      return false
    }
  }

  open(b: Book, sig: Signal, qty: number, fill: number, spent: number, fee: number, why: string, live: boolean) {
    const pos = st.newPosition(sig, qty, fill, spent, live ? "live" : "paper", this.cfg, this.now)
    b.positions[sig.symbol] = pos
    b.cash -= spent
    b.fees = (b.fees ?? 0) + fee
    this.stats.trader.buys++
    this.log("TRADER", `COMPRATO ${sig.symbol} ${g6(qty)} @ ${g6(fill)} per ${eur(spent)} · ${why}`, "trade")
    this.events.push(`🟢 <b>${live ? "LIVE" : "PAPER"} · COMPRA ${esc(sig.symbol)}</b>\n${eur(spent)} @ ${g6(fill)}\nStop ${g6(pos.stop)} · Target ${g6(pos.tp)}\nPunteggio ${sig.score}/100`)
  }

  async sell(b: Book, broker: Broker, sym: string, pos: Position, tk: Ticker, reason: string): Promise<boolean> {
    try {
      const [px, proceeds, fee] = await broker.sell(sym, pos.qty, tk, { reason, mode: broker.live ? "live" : "paper" })
      this.close(b, sym, pos, px, proceeds, fee, reason, broker.live)
      return true
    } catch (e: any) {
      if (e instanceof OrderUncertain) {
        this.pause(`Vendita ${sym} non confermata: verifico al prossimo turno`)
        this.errors.push(e.message); this.log("TRADER", e.message, "error")
        this.events.push(`⚠️ <b>Vendita non confermata</b>\n${esc(e.message)}`)
        return false
      }
      this.errors.push(`Vendita ${sym}: ${e?.message ?? e}`)
      this.log("TRADER", `Vendita ${sym} FALLITA (${reason}): ${e?.message ?? e}`, "error")
      this.events.push(`⚠️ Vendita ${esc(sym)} fallita: ${esc(e?.message ?? e)}`)
      return true
    }
  }

  close(b: Book, sym: string, pos: Position, px: number, proceeds: number, fee: number, reason: string, live: boolean) {
    const pnl = proceeds - pos.cost
    b.cash += proceeds
    b.fees = (b.fees ?? 0) + fee
    const [daily, weekly] = this.periods(b)
    daily.realized += pnl; weekly.realized += pnl
    const closed = { ...pos, exit: px, proceeds, pnl, pnl_pct: pos.cost ? (pnl / pos.cost) * 100 : 0, reason, closed_at: this.now }
    b.closed = [...b.closed, closed].slice(-MAX_CLOSED)
    delete b.positions[sym]
    if (reason === "STOP") b.cooldown[sym] = this.now + this.cfg.cooldown_hours * 3600
    this.stats.trader.sells++
    this.log("TRADER", `VENDUTO ${sym} @ ${g6(px)} · ${reason} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} € (${closed.pnl_pct.toFixed(2)}%)`, "trade")
    this.events.push(`${pnl >= 0 ? "🟢" : "🔴"} <b>${live ? "LIVE" : "PAPER"} · VENDE ${esc(sym)}</b> · ${esc(reason)}\n${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} € (${closed.pnl_pct.toFixed(2)}%)`)
  }

  /** Ritrova gli ordini LIVE incerti per client_order_id. Mai reinviare. */
  async reconcile(tk: Record<string, Ticker>) {
    for (const item of [...this.journal.items]) {
      const { client_order_id: coid, symbol: sym, side } = item
      let o: any
      try { o = await this.c.findOrder(coid, sym, item.created_ms) } catch (e: any) {
        this.log("SISTEMA", `Non riesco a verificare l'ordine ${side} ${sym}: ${e?.message ?? e}. Resto in pausa.`, "error"); continue
      }
      const age = this.now - item.created_ms / 1000
      if (!o) {
        if (age > PENDING_GIVE_UP_S) {
          await this.journal.remove(coid)
          this.log("SISTEMA", `Ordine ${side} ${sym} mai arrivato a Revolut X dopo ${(age / 60).toFixed(0)} min: lo considero non inviato. Controlla l'app e poi premi Riprendi.`, "warn")
          this.pause(`Verifica manuale ordine ${side} ${sym} (non trovato)`)
        }
        continue
      }
      if (!FINAL_STATES.includes(orderStatus(o))) { this.log("SISTEMA", `Ordine ${side} ${sym} ancora aperto su Revolut X (${orderStatus(o)}): attendo.`, "warn"); continue }
      await this.journal.remove(coid)
      if (num(o.filled_quantity) <= 0) { this.log("SISTEMA", `Ordine ${side} ${sym} chiuso senza esecuzione (${orderStatus(o)}).`, "warn"); continue }
      const base = sym.split("-")[0], t = tk[sym] ?? {}
      if (side === "buy") {
        const [qty, avg, spent, fee] = fillFromOrder(o, "buy", base, num(t.ask), this.cfg.taker_fee)
        const meta = item.meta ?? {}
        const sig = { symbol: sym, score: meta.score ?? 0, ind: { atr: meta.atr || avg * 0.02 } } as unknown as Signal
        this.open(this.live, sig, qty, avg, spent, fee, "recuperato dalla riconciliazione", true)
        this.log("SISTEMA", `Ordine d'acquisto ${sym} ritrovato ed eseguito: posizione registrata.`, "warn")
      } else {
        const [, avg, proceeds, fee] = fillFromOrder(o, "sell", base, num(t.bid), this.cfg.taker_fee)
        const pos = this.live.positions[sym]
        if (pos) this.close(this.live, sym, pos, avg, proceeds, fee, item.meta?.reason ?? "VENDITA", true)
        this.log("SISTEMA", `Ordine di vendita ${sym} ritrovato ed eseguito: posizione chiusa.`, "warn")
      }
    }
  }

  bookView(b: Book, tk: Record<string, Ticker>) {
    const cfg = this.cfg, eq = Office.equity(b, tk), closed = b.closed
    const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0)
    let peak = b.start, mdd = 0
    for (const [, e] of b.equity) { peak = Math.max(peak, e); mdd = Math.max(mdd, peak ? ((peak - e) / peak) * 100 : 0) }
    const positions = Object.entries(b.positions).map(([s, p]) => {
      const bid = num(tk[s]?.bid) || p.entry
      return { ...p, price: bid, value: p.qty * bid, pnl: p.qty * bid * (1 - cfg.taker_fee) - p.cost, pnl_pct: (bid / p.entry - 1) * 100 }
    })
    const [daily, weekly] = this.periods(b)
    const n = closed.length, lossSum = losses.reduce((s, c) => s + c.pnl, 0)
    return {
      kpi: {
        equity: eq, start: b.start, cash: b.cash, exposure: positions.reduce((s, p) => s + p.value, 0),
        pnl_total: eq - b.start, pnl_pct: b.start ? (eq / b.start - 1) * 100 : 0, pnl_today: daily.realized, pnl_week: weekly.realized,
        trades: n, win_rate: n ? (wins.length / n) * 100 : null, expectancy: n ? closed.reduce((s, c) => s + c.pnl, 0) / n : null,
        profit_factor: losses.length && lossSum < 0 ? wins.reduce((s, c) => s + c.pnl, 0) / -lossSum : null,
        sample: n < 100 ? "INCONCLUSIVO" : "sufficiente", realized: closed.reduce((s, c) => s + c.pnl, 0), fees: b.fees ?? 0, max_dd_pct: mdd,
      },
      positions, closed: [...closed.slice(-40)].reverse(), equity: b.equity.slice(-400),
    }
  }

  snapshot(tk: Record<string, Ticker>, signals: Signal[]) {
    const cfg = this.cfg
    const view = this.book ? this.bookView(this.book, tk) : { kpi: {}, positions: [], closed: [], equity: [] }
    const liveView = (Object.keys(this.live.positions).length || this.live.closed.length) && this.book !== this.live ? this.bookView(this.live, tk) : null
    const { analyst: a, trader: t, risk: r } = this.stats
    const paused = !!this.ctl.paused, best = signals[0]
    const keys = ["pairs", "interval_min", "style", "budget_eur", "paper_start_eur", "risk_per_trade_eur", "max_risk_pct", "max_position_pct",
      "max_exposure_pct", "max_open_positions", "daily_loss_limit_eur", "weekly_loss_limit_eur", "max_drawdown_pct", "min_score", "stop_atr", "tp_atr"]
    return {
      generated_at: this.now, company: cfg.company, desk: cfg.desk, mode: this.mode, requested_mode: this.ctl.mode ?? "shadow",
      live_blocks: this.liveBlocks, live_armed: !!this.ctl.live_armed, kill_switch: !!this.ctl.kill_switch, paused, pause_reason: this.ctl.pause_reason ?? "",
      pending_orders: this.journal.items.map((o) => ({ symbol: o.symbol, side: o.side, created_ms: o.created_ms })),
      proposals: [...this.proposals].reverse().slice(0, 12),
      scout: { ...this.scoutInfo, stop: this.scoutStop },
      ai_enabled: !!this.opts.aiEnabled, telegram: !!this.opts.telegram, runs: this.state.runs ?? 0,
      config: Object.fromEntries(keys.map((k) => [k, cfg[k]])),
      agents: [
        { id: "scout", name: "Scout", role: "Controlla saldo sul broker, registro = conto, prezzi e candele freschi", status: this.scoutStop ? "STOP" : "VIGILE", metric: this.scoutInfo.candles_ok, unit: "coppie con dati freschi", detail: this.scoutStop ?? (this.scoutInfo.checked_at ? `Saldo confermato alle ${hhmm(this.scoutInfo.checked_at)}` : "Saldo non richiesto (niente LIVE)") },
        { id: "analyst", name: "Analista", role: "Scansiona il mercato su candele chiuse e propone gli ingressi", status: paused ? "IN PAUSA" : a.candidates ? "SEGNALE" : "SCANSIONE", metric: a.scanned, unit: "coppie analizzate", detail: best ? `Migliore: ${best.symbol} ${best.score}/100` : "Nessun dato", ai_reviews: a.ai },
        { id: "risk", name: "Risk", role: "Limiti di perdita, esposizione, dati mancanti, veto IA", status: paused ? "IN PAUSA" : r.blocked ? "BLOCCO" : "VIGILE", metric: r.checked, unit: "controlli", detail: r.last || "Nessun candidato in questo turno" },
        { id: "trader", name: "Trader", role: "Prepara ordini e uscite; in LIVE li invia solo dopo la tua conferma", status: paused ? "IN PAUSA" : t.buys || t.sells || t.shadow ? "OPERATIVO" : "VIGILE", metric: view.positions.length, unit: "posizioni aperte", detail: `${t.proposed} proposte · ${t.buys} acquisti · ${t.sells} vendite · ${t.shadow} simulati in shadow · ${t.blocked} bloccati` },
      ],
      ...view, live_book: liveView, shadow: [...(this.state.shadow ?? []).slice(-30)].reverse(),
      signals: signals.map(({ ind, ...s }) => ({ ...s, rsi: ind.rsi ?? null, atr_pct: ind.atr_pct ?? null, adx: ind.adx ?? null, ema50: ind.ema50 ?? null, ema200: ind.ema200 ?? null })),
      log: [...(this.state.log ?? []).slice(-80)].reverse(), errors: this.errors,
    }
  }
}

/** Verifica di sola lettura. Con arm=true e tutto verde e mode=live, arma il LIVE. */
export async function selftest(c: MarketClient, cfgIn: Cfg, ctl: safety.Control, state: State, now: number, arm: boolean) {
  const [cfg] = safety.clampConfig(cfgIn)
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try { const [ok, detail] = await fn(); checks.push({ name, ok, detail }) } catch (e: any) { checks.push({ name, ok: false, detail: `${e?.name ?? "Errore"}: ${e?.message ?? e}` }) }
  }
  const pairs: string[] = cfg.pairs.map(toDash)
  let bal: Record<string, any> = {}
  await check("Firma e chiavi (saldi)", async () => { bal = await c.balances(); return [true, `EUR disponibili ${num(bal.EUR?.available).toFixed(2)}`] })
  await check("Coppie configurate", async () => {
    const p = await c.pairs()
    const miss = pairs.filter((s) => String(p[s.replace("-", "/")]?.status ?? "").toLowerCase() !== "active")
    return [!miss.length, miss.length ? `non attive/assenti: ${miss.join(", ")}` : "tutte attive"]
  })
  await check("Prezzi in tempo reale", async () => {
    const tk = await c.tickers(pairs)
    const bad = pairs.filter((s) => !(tk[s]?.bid && tk[s]?.ask))
    return [!bad.length, bad.length ? `senza prezzi: ${bad.join(", ")}` : "bid/ask presenti"]
  })
  for (const sym of pairs) {
    await check(`Candele ${sym}`, async () => {
      const cs = st.closedOnly(st.normalize(await c.candles(sym, cfg.interval_min, cfg.candles ?? 300)), cfg.interval_min, now)
      const age = cs.length ? (now - (cs[cs.length - 1].t + cfg.interval_min * 60)) / 60 : 1e9
      return [cs.length >= MIN_CANDLES && age <= cfg.interval_min * 1.5, `${cs.length} candele chiuse, ultima ${age.toFixed(0)} min fa`]
    })
  }
  const pend = state.pending_orders?.length ?? 0
  await check("Nessun ordine in sospeso", async () => [!pend, `${pend} in sospeso`])
  if (ctl.mode === "live") {
    await check("Saldo per operare", async () => [num(bal.EUR?.available) >= (cfg.min_trade_eur ?? 5), `minimo ${cfg.min_trade_eur ?? 5} €`])
    await check("Kill switch spento", async () => [!ctl.kill_switch, ctl.kill_switch ? "ACCESO" : "spento"])
  }
  const green = checks.every((x) => x.ok)
  let armed = false
  if (arm && ctl.mode === "live") {
    armed = green
    Object.assign(ctl, { live_armed: armed, armed_key: armed ? c.fingerprint : null, armed_at: armed ? now : null })
  } else if (arm) Object.assign(ctl, { live_armed: false, armed_key: null, armed_at: null })
  return { t: now, green, armed, requested_mode: ctl.mode ?? "shadow", checks,
    note: "Il permesso di trading della API key si verifica solo con un ordine vero: il primo acquisto LIVE è anche il test finale." }
}
