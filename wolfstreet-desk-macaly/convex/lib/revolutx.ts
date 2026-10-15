// Client Revolut X (porting di bot/revolutx.py). Usa node:crypto: importare SOLO da file "use node".
// Firma Ed25519 su timestamp(ms) + METODO + /api/1.0/path + query(senza ?) + body(JSON minificato).
// - un ordine non viene mai ritentato: il client_order_id lo genera e lo salva chi chiama, prima dell'invio;
// - un 404 subito dopo l'ordine è normale: si riprova e poi si cerca per client_order_id.
// - l'API restituisce al massimo 100 candele per richiesta: si leggono finestre consecutive.
import { createHash, createPrivateKey, sign as edSign } from "node:crypto"
import { ApiError, FINAL_STATES, orderStatus, toDash } from "./office"
import type { MarketClient, Ticker } from "./office"

const BASE = "https://revx.revolut.com"
const CANDLES_PER_REQUEST = 100

export function normalizePem(raw: string): string {
  const body = raw.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "")
  if (!body) throw new Error("Chiave privata Revolut X mancante")
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`
}

export const keyFingerprint = (apiKey: string) => createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 12)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class RevolutX implements MarketClient {
  apiKey: string; key: ReturnType<typeof createPrivateKey>; fingerprint: string
  constructor(apiKey: string, privatePem: string) {
    if (!apiKey?.trim()) throw new Error("API key Revolut X mancante")
    this.apiKey = apiKey.trim()
    this.key = createPrivateKey(normalizePem(privatePem))
    if (this.key.asymmetricKeyType !== "ed25519") throw new Error("La chiave privata non è Ed25519")
    this.fingerprint = keyFingerprint(this.apiKey)
  }

  async request(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>, body?: unknown, retries = 3): Promise<any> {
    const items = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const query = items.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    const bodyStr = body === undefined ? "" : JSON.stringify(body)
    const full = `/api/1.0${path}`
    let last: ApiError | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ts = String(Date.now())
      const sig = edSign(null, Buffer.from(ts + method + full + query + bodyStr, "utf8"), this.key).toString("base64")
      let r: Response
      try {
        r = await fetch(BASE + full + (query ? `?${query}` : ""), {
          method, body: bodyStr || undefined,
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Revx-API-Key": this.apiKey, "X-Revx-Timestamp": ts, "X-Revx-Signature": sig },
        })
      } catch (e: any) {
        last = new ApiError(0, e?.name ?? "rete")
        if (attempt < retries) await sleep(1500 * (attempt + 1))
        continue
      }
      const text = await r.text()
      if (r.status === 429 || r.status >= 500) {
        last = new ApiError(r.status, text.slice(0, 200))
        if (attempt < retries) await sleep(Math.min(r.status === 429 ? Number(r.headers.get("Retry-After") ?? 1000) : 1500 * (attempt + 1), 10000))
        continue
      }
      if (!r.ok) {
        let msg = text
        try { msg = JSON.parse(text).message ?? text } catch { /* testo semplice */ }
        throw new ApiError(r.status, String(msg).slice(0, 300))
      }
      return text ? JSON.parse(text) : null
    }
    throw last ?? new ApiError(0, "richiesta fallita")
  }
  private data(p: any) { return p && typeof p === "object" && "data" in p ? p.data : p }

  async balances() {
    const out: Record<string, any> = {}
    for (const b of this.data(await this.request("GET", "/balances")) ?? []) out[b.currency] = b
    return out
  }
  async pairs() { return this.data(await this.request("GET", "/configuration/pairs")) ?? {} }
  async tickers(symbols: string[]) {
    const out: Record<string, Ticker> = {}
    for (const t of this.data(await this.request("GET", "/tickers", { symbols: symbols.map(toDash).join(",") })) ?? []) out[toDash(t.symbol)] = t
    return out
  }
  async candles(symbol: string, interval = 240, count = 300) {
    let until = Date.now()
    const step = CANDLES_PER_REQUEST * interval * 60_000
    const out = new Map<number, any>()
    for (let i = 0; i < Math.ceil(count / CANDLES_PER_REQUEST); i++) {
      const since = until - step
      const rows = this.data(await this.request("GET", `/candles/${toDash(symbol)}`, { interval, since, until })) ?? []
      for (const c of rows) out.set(Number(c.start), c)
      if (!rows.length) break
      until = since
    }
    return [...out.keys()].sort((a, b) => a - b).map((k) => out.get(k))
  }
  async marketOrder(symbol: string, side: "buy" | "sell", coid: string, size: { quote_size?: string; base_size?: string }) {
    if (!coid) throw new Error("client_order_id obbligatorio")
    if (!!size.quote_size === !!size.base_size) throw new Error("serve esattamente uno tra quote_size e base_size")
    const body = { client_order_id: coid, symbol: toDash(symbol), side, order_configuration: { market: size.quote_size ? { quote_size: size.quote_size } : { base_size: size.base_size } } }
    return this.data(await this.request("POST", "/orders", undefined, body, 0)) ?? {}
  }
  async getOrder(id: string) { return this.data(await this.request("GET", `/orders/${id}`)) ?? {} }
  async findOrder(coid: string, symbol: string, sinceMs: number) {
    const sym = toDash(symbol)
    const windows: [string, Record<string, unknown>][] = [
      ["/orders/active", { symbols: sym }],
      ["/orders/historical", { symbols: sym, start_date: Math.max(0, sinceMs - 60_000), end_date: Math.min(sinceMs + 7 * 86_400_000 - 1, Date.now() + 60_000) }],
    ]
    for (const [path, params] of windows) {
      let cursor: string | undefined
      for (let i = 0; i < 10; i++) {
        const payload = await this.request("GET", path, { ...params, ...(cursor ? { cursor } : {}) })
        const hit = (this.data(payload) ?? []).find((o: any) => o.client_order_id === coid)
        if (hit) return hit
        cursor = payload?.metadata?.next_cursor || undefined
        if (!cursor) break
      }
    }
    return null
  }
  async waitFinal(venueId: string | null, coid: string, symbol: string, sinceMs: number, tries = 8) {
    for (let i = 0; i < tries; i++) {
      let o: any = null
      try { o = venueId ? await this.getOrder(venueId) : await this.findOrder(coid, symbol, sinceMs) } catch (e: any) {
        if (!(e instanceof ApiError) || ![0, 404].includes(e.status)) throw e
      }
      if (o && FINAL_STATES.includes(orderStatus(o))) return o
      await sleep(Math.min(1000 * (1 + i), 5000))
    }
    try {
      const f = await this.findOrder(coid, symbol, sinceMs)
      if (f && FINAL_STATES.includes(orderStatus(f))) return f
    } catch { /* resta incerto */ }
    return null
  }
}
