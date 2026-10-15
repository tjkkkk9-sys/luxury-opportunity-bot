"use node"
// Motore del desk: turno automatico, verifica, salvataggio chiavi. Tutto lato server.
import Anthropic from "@anthropic-ai/sdk"
import { v } from "convex/values"
import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { internal } from "./_generated/api"
import { action, internalAction } from "./_generated/server"
import type { ActionCtx } from "./_generated/server"
import { esc, Office, selftest as runSelftest } from "./lib/office"
import type { AiReview } from "./lib/office"
import { keyFingerprint, normalizePem, RevolutX } from "./lib/revolutx"
import { analyzeCfd, byId, clampP500, followIdea, parseYahoo } from "./lib/plus500"
import type { CfdSignal, Idea } from "./lib/plus500"
import type { Candle } from "./lib/strategy"

// ------------------------------------------------------------- segreti cifrati
// La chiave AES deriva (HKDF) da JWT_PRIVATE_KEY, un segreto che esiste solo tra le variabili del
// deployment Convex e non nel codice né nel database. Se quel segreto venisse rigenerato, le chiavi
// salvate non sarebbero più leggibili: il desk si ferma (fail-closed) e basta reinserirle.
function encKey(): Buffer {
  const master = process.env.DESK_ENC_KEY || process.env.JWT_PRIVATE_KEY || ""
  if (master.length < 32) throw new Error("Segreto di cifratura del server mancante: il desk non può proteggere le chiavi")
  return Buffer.from(hkdfSync("sha256", master, "wolfstreet-desk", "secrets-v1", 32))
}
async function putSecret(ctx: ActionCtx, name: string, value: string) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", encKey(), iv)
  const data = Buffer.concat([c.update(value, "utf8"), c.final()])
  await ctx.runMutation(internal.store.putSecretRow, { name, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") })
}
async function getSecret(ctx: ActionCtx, name: string): Promise<string | null> {
  const row = await ctx.runQuery(internal.store.getSecretRow, { name })
  if (!row) return null
  const d = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(row.iv, "base64"))
  d.setAuthTag(Buffer.from(row.tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(row.data, "base64")), d.final()]).toString("utf8")
}
async function requireOwner(ctx: ActionCtx) {
  if (!(await ctx.runQuery(internal.store.isOwner, {}))) throw new Error("Accesso riservato al titolare del desk")
}

// ------------------------------------------------------------- IA (solo veto, fail-closed)
const AI_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["APPROVA", "VETO"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
  additionalProperties: false,
}
function makeAi(key: string | null, enabled: boolean): AiReview {
  return async (sig, cfg) => {
    if (!key || !enabled) return null
    const veto = (reason: string) => ({ verdict: "VETO", reason })
    const data = { prezzo: sig.price, punteggio_regole: sig.score, motivi: sig.reasons, ...sig.ind, spread_pct: sig.spread_pct }
    try {
      const client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 2 })
      const res = await client.messages.create({
        model: cfg.ai_model ?? "claude-haiku-5-5",
        max_tokens: 1024,
        output_config: { effort: "low", format: { type: "json_schema", schema: AI_SCHEMA } },
        messages: [{
          role: "user",
          content: `Sei il risk reviewer di un piccolo desk crypto spot (solo acquisti, niente leva).
Il bot Analista propone un ACQUISTO su ${sig.symbol} (candele ${cfg.interval_min / 60}h).
Dati calcolati dal codice sull'ultima candela chiusa (numeri reali, non modificarli):
${JSON.stringify(data)}
Valuta solo con questi dati se l'ingresso è coerente con lo stile "compra la correzione in trend rialzista".
In caso di dubbio scegli VETO. Motivo: massimo 18 parole, in italiano.`,
        }],
      } as any)
      if (res.stop_reason === "refusal") return veto("IA ha rifiutato la richiesta: veto prudenziale")
      const text = (res.content as any[]).find((b) => b.type === "text")?.text ?? ""
      const out = JSON.parse(text)
      if (out.verdict !== "APPROVA" && out.verdict !== "VETO") return veto("Risposta IA illeggibile: veto prudenziale")
      return { verdict: out.verdict, reason: String(out.reason ?? "").slice(0, 160) }
    } catch (e: any) {
      return veto(`IA non disponibile (${e?.name ?? "errore"}): veto prudenziale`)
    }
  }
}

// ------------------------------------------------------------- Telegram (facoltativo)
async function telegram(ctx: ActionCtx, text: string) {
  const token = await getSecret(ctx, "telegram_token"), chat = await getSecret(ctx, "telegram_chat")
  if (!token || !chat) return
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) })
    if (r.status === 400) {
      const plain = text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: plain }) })
    }
  } catch { /* gli avvisi non fermano il desk */ }
}

async function buildClient(ctx: ActionCtx): Promise<RevolutX> {
  const apiKey = await getSecret(ctx, "revx_api_key"), pem = await getSecret(ctx, "revx_private_key")
  if (!apiKey || !pem) throw new Error("Chiavi Revolut X non ancora inserite: vai su Comandi → Chiavi")
  return new RevolutX(apiKey, pem)
}

// ------------------------------------------------------------- turno automatico (cron)
export const runTurn = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Math.floor(Date.now() / 1000)
    if (!(await ctx.runMutation(internal.store.lock, { now }))) return { skipped: "turno già in corso" }
    try {
      const { config, control, state } = await ctx.runQuery(internal.store.readAll, {})
      const base = JSON.stringify(control)
      let client: RevolutX
      try { client = await buildClient(ctx) } catch (e: any) {
        await ctx.runMutation(internal.store.saveTurn, {
          state: JSON.stringify(state),
          office: JSON.stringify({ generated_at: now, company: config.company, desk: config.desk, mode: "spento", requested_mode: control.mode,
            paused: true, pause_reason: "Chiavi Revolut X mancanti", errors: [e.message], agents: [], kpi: {}, signals: [], positions: [], closed: [], equity: [],
            log: [{ t: now, bot: "SISTEMA", text: `DESK SPENTO (nessun ordine): ${e.message}`, level: "warn" }] }),
        })
        return { ok: false, reason: "chiavi mancanti" }
      }
      const anthropicKey = await getSecret(ctx, "anthropic_key")
      const persist = async () => {
        await ctx.runMutation(internal.store.saveTurn, { state: JSON.stringify(state), control: JSON.stringify(control), base })
      }
      const office = new Office(client, config, control, state, now, {
        persist, ai: makeAi(anthropicKey, config.ai_review !== false), uuid: randomUUID,
        aiEnabled: !!anthropicKey && config.ai_review !== false, telegram: !!(await getSecret(ctx, "telegram_token")),
      })
      let snap: any
      try {
        snap = await office.run()
        if (office.mode === "live" || Object.keys(office.live.positions).length) {
          try {
            const bal = await client.balances()
            const keep = new Set(["EUR", ...office.cfg.pairs.map((p: string) => p.split("-")[0])])
            snap.balances = Object.fromEntries(Object.entries(bal).filter(([k]) => keep.has(k)))
          } catch (e: any) { snap.errors.push(`Saldi: ${e.message}`) }
        }
      } catch (e: any) {
        office.log("SISTEMA", `Turno interrotto: ${e?.message ?? e}`, "error")
        office.events.push(`⚠️ Turno interrotto: ${esc(e?.message ?? e)}`)
        snap = { generated_at: now, company: config.company, desk: config.desk, mode: office.mode, requested_mode: control.mode, paused: !!control.paused,
          errors: [String(e?.message ?? e)], agents: [], kpi: {}, signals: [], positions: [], closed: [], equity: [], log: [...(state.log ?? [])].slice(-80).reverse() }
      }
      await ctx.runMutation(internal.store.saveTurn, { state: JSON.stringify(state), control: JSON.stringify(control), base, office: JSON.stringify(snap) })
      if (office.events.length) await telegram(ctx, `🐺 <b>${esc(config.company)}</b>\n\n${office.events.join("\n\n")}`)
      return { ok: true, mode: office.mode }
    } finally {
      await ctx.runMutation(internal.store.lock, { now, release: true })
    }
  },
})

// ------------------------------------------------------------- comandi del titolare
export const runNow = action({
  args: {},
  handler: async (ctx) => { await requireOwner(ctx); return await ctx.runAction(internal.desk.runTurn, {}) },
})

/** Verifica di sola lettura; con arm=true, se tutto è verde e hai chiesto LIVE, arma il LIVE. */
export const selftest = action({
  args: { arm: v.boolean() },
  handler: async (ctx, { arm }) => {
    await requireOwner(ctx)
    const now = Math.floor(Date.now() / 1000)
    const { config, control, state } = await ctx.runQuery(internal.store.readAll, {})
    const base = JSON.stringify(control)
    let report: any
    try {
      report = await runSelftest(await buildClient(ctx), config, control, state, now, arm)
    } catch (e: any) {
      if (arm) Object.assign(control, { live_armed: false, armed_key: null, armed_at: null })
      report = { t: now, green: false, armed: false, requested_mode: control.mode, checks: [{ name: "Chiavi Revolut X", ok: false, detail: e.message }], note: "" }
    }
    await ctx.runMutation(internal.store.saveTurn, { state: JSON.stringify(state), control: JSON.stringify(control), base, selftest: JSON.stringify(report) })
    await telegram(ctx, `🐺 <b>Verifica desk</b>: ${report.green ? "VERDE" : "ROSSA"}${report.armed ? " · <b>LIVE ARMATO</b>" : ""}` +
      report.checks.map((c: any) => `\n${c.ok ? "✅" : "❌"} ${esc(c.name)}: ${esc(c.detail)}`).join(""))
    return report
  },
})

/** Salva le chiavi Revolut X generate sul telefono. La privata viene solo cifrata, mai restituita. */
export const saveRevxKeys = action({
  args: { apiKey: v.string(), privateKey: v.string() },
  handler: async (ctx, { apiKey, privateKey }) => {
    await requireOwner(ctx)
    const key = apiKey.trim()
    if (!/^[A-Za-z0-9_\-]{20,128}$/.test(key)) throw new Error("La API key non sembra valida: copiala di nuovo da Revolut X")
    let pem: string
    try {
      pem = normalizePem(privateKey)
      if (createPrivateKey(pem).asymmetricKeyType !== "ed25519") throw new Error("tipo")
    } catch { throw new Error("La chiave privata non è una chiave Ed25519 valida") }
    await putSecret(ctx, "revx_api_key", key)
    await putSecret(ctx, "revx_private_key", pem)
    await ctx.runMutation(internal.store.setFingerprint, { fp: keyFingerprint(key) })
    return { ok: true, fingerprint: keyFingerprint(key) }
  },
})

const OPTIONAL = ["anthropic_key", "telegram_token", "telegram_chat"] as const
export const saveOptionalSecret = action({
  args: { name: v.string(), value: v.string() },
  handler: async (ctx, { name, value }) => {
    await requireOwner(ctx)
    if (!(OPTIONAL as readonly string[]).includes(name)) throw new Error("Chiave non prevista")
    if (value.trim()) await putSecret(ctx, name, value.trim())
    else await ctx.runMutation(internal.store.deleteSecretRow, { name })
    return { ok: true }
  },
})

// ------------------------------------------------------------- Plus500: analista + avvisi (esecuzione manuale)
async function yahoo1h(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1h&range=120d`
  let last = ""
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (WolfStreetDesk)" }, signal: AbortSignal.timeout(20_000) })
      if (!r.ok) { last = `HTTP ${r.status}`; continue }
      return parseYahoo(await r.json()).candles
    } catch (e: any) { last = e?.message ?? String(e) }
  }
  throw new Error(`dati ${symbol} non disponibili (${last})`)
}
const fp = (n: number | undefined | null) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { maximumSignificantDigits: 6 }))

export const runPlus500 = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Math.floor(Date.now() / 1000)
    const { config, state } = await ctx.runQuery(internal.store.readP500, {})
    const cfg = clampP500(config)
    const ideas: Record<string, Idea> = state.ideas ?? {}
    const alerted: Record<string, number> = state.alerted ?? {}
    const log: any[] = state.log ?? []
    const events: string[] = [], errors: string[] = []
    let eurUsd: number | null = null
    const data: Record<string, Candle[]> = {}
    for (const id of new Set(["eurusd", ...cfg.enabled, ...Object.keys(ideas)])) {
      const inst = byId(id)
      if (!inst) continue
      try { data[id] = await yahoo1h(inst.yahoo) } catch (e: any) { errors.push(`${inst.name}: ${e.message}`) }
    }
    const fx = data.eurusd?.at(-1)?.c
    if (fx && now - (data.eurusd.at(-1)!.t) < 4 * 86400) eurUsd = fx
    const signals: CfdSignal[] = []
    for (const id of cfg.enabled) {
      const inst = byId(id)!
      const sig = analyzeCfd(inst, data[id] ?? [], now, eurUsd, cfg)
      signals.push(sig)
      if ((sig.side === "LONG" || sig.side === "SHORT") && !ideas[id] && alerted[id] !== sig.t && sig.plan && sig.t) {
        alerted[id] = sig.t
        ideas[id] = { id, side: sig.side, entry: sig.price!, stop: sig.stop!, target: sig.target!, atr: sig.ind.atr, t: sig.t, opened: now, be: false }
        const verb = sig.side === "LONG" ? "COMPRA" : "VENDI"
        log.push({ t: now, id, text: `${verb} ${inst.name} a ${fp(sig.price)} · stop ${fp(sig.stop)} · limite ${fp(sig.target)} · punteggio ${sig.score}`, level: "signal" })
        events.push(`${sig.side === "LONG" ? "🟢" : "🔴"} <b>${verb} ${esc(inst.name)}</b> (${sig.side}) · punteggio ${sig.score}/100
Prezzo ${fp(sig.price)} · Stop ${fp(sig.stop)} · Limite ${fp(sig.target)}
Valore posizione ≈ ${sig.plan.exposure_eur.toFixed(0)} € · margine ≈ ${sig.plan.margin_eur.toFixed(0)} €
Se scatta lo stop perdi ≈ ${sig.plan.risk_eur.toFixed(2)} €, al limite guadagni ≈ ${sig.plan.reward_eur.toFixed(2)} €
${sig.reasons.slice(0, 3).map((r) => "• " + esc(r)).join("\n")}
➜ Su Plus500: ${verb === "COMPRA" ? "Compra" : "Vendi"}, imposta Stop Loss e Take Profit ai livelli sopra. Il desk non apre ordini.`)
      }
    }
    for (const [id, idea] of Object.entries(ideas)) {
      const inst = byId(id)
      const bars = data[id]
      if (!inst || !bars?.length) continue
      const sig = signals.find((x) => x.id === id)
      const r = followIdea(idea, bars, sig?.ind && Object.keys(sig.ind).length ? sig.ind : null, now, cfg)
      if (r.move_be) {
        idea.be = true; idea.stop = idea.entry
        log.push({ t: now, id, text: `${inst.name}: porta lo stop a pareggio (${fp(idea.entry)})`, level: "info" })
        events.push(`🛡️ <b>${esc(inst.name)}</b>: il prezzo è andato a favore di ${cfg.breakeven_atr} ATR. Se sei dentro, sposta lo Stop Loss a pareggio: <b>${fp(idea.entry)}</b>`)
      }
      if (r.close) {
        delete ideas[id]
        const d = idea.side === "LONG" ? 1 : -1
        const pct = r.px ? ((r.px - idea.entry) / idea.entry) * 100 * d : 0
        log.push({ t: now, id, text: `${inst.name} ${idea.side}: ${r.close} a ${fp(r.px)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% sul prezzo)`, level: pct >= 0 ? "win" : "loss" })
        const manual = r.close === "TREND ROTTO" || r.close === "TEMPO SCADUTO"
        events.push(`${pct >= 0 ? "✅" : "⛔"} <b>${esc(inst.name)} ${idea.side}</b>: ${r.close} a ${fp(r.px)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)${manual ? "\n➜ Se sei ancora dentro, valuta di chiudere su Plus500." : "\n➜ Su Plus500 la posizione si chiude da sola se avevi impostato Stop/Limite."}`)
      }
    }
    const view = { generated_at: now, eur_usd: eurUsd, signals, ideas: Object.values(ideas), log: log.slice(-60).reverse(), errors, config: cfg }
    await ctx.runMutation(internal.store.saveP500, { state: JSON.stringify({ ideas, alerted, log: log.slice(-200) }), view: JSON.stringify(view) })
    if (events.length) await telegram(ctx, `🐺 <b>Plus500 · Wolf Street</b>\n\n${events.join("\n\n")}`)
    return { ok: true, signals: signals.map((x) => `${x.id}:${x.side}:${x.score}`), errors }
  },
})

export const plus500Now = action({
  args: {},
  handler: async (ctx) => { await requireOwner(ctx); return await ctx.runAction(internal.desk.runPlus500, {}) },
})

// ------------------------------------------------------------- Telegram: collegamento guidato
/** Salva il token del bot (preso da @BotFather) e controlla subito che sia valido. */
export const telegramSetToken = action({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireOwner(ctx)
    const t = token.trim()
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(t)) throw new Error("Il token non sembra giusto: copialo intero dal messaggio di BotFather (numeri:lettere)")
    const r = await fetch(`https://api.telegram.org/bot${t}/getMe`, { signal: AbortSignal.timeout(15_000) })
    const j: any = await r.json().catch(() => ({}))
    if (!j.ok) throw new Error("Telegram non riconosce questo token: ricontrollalo su BotFather")
    await putSecret(ctx, "telegram_token", t)
    return { ok: true, bot: j.result?.username as string }
  },
})

/** Trova da solo il tuo chat ID dal messaggio che hai mandato al bot, lo salva e manda un messaggio di prova. */
export const telegramLink = action({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx)
    const t = await getSecret(ctx, "telegram_token")
    if (!t) throw new Error("Prima salva il token del bot")
    await fetch(`https://api.telegram.org/bot${t}/deleteWebhook`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    const r = await fetch(`https://api.telegram.org/bot${t}/getUpdates?allowed_updates=%5B%22message%22%5D`, { signal: AbortSignal.timeout(15_000) })
    const j: any = await r.json().catch(() => ({}))
    if (!j.ok) throw new Error(`Telegram non risponde (${j.description ?? r.status})`)
    const chats = (j.result ?? []).map((u: any) => u.message?.chat).filter((c: any) => c && c.type === "private")
    const chat = chats.at(-1)
    if (!chat) throw new Error("Non vedo ancora il tuo messaggio: apri il bot su Telegram, premi AVVIA (o scrivi ciao) e poi riprova")
    await putSecret(ctx, "telegram_chat", String(chat.id))
    await registerWebhook(ctx, t)
    await telegram(ctx, "🐺 <b>Wolf Street Capital</b>\nTelegram collegato. Da adesso ricevi qui gli avvisi del desk. Scrivi /aiuto per i comandi.")
    return { ok: true, name: chat.first_name ?? chat.username ?? "" }
  },
})

export const telegramTest = action({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx)
    if (!(await getSecret(ctx, "telegram_chat"))) throw new Error("Telegram non ancora collegato")
    await telegram(ctx, "🐺 Prova avvisi Wolf Street: funziona.")
    return { ok: true }
  },
})

// ------------------------------------------------------------- Telegram: comandi dal telefono
async function registerWebhook(ctx: ActionCtx, token: string) {
  const site = process.env.CONVEX_SITE_URL
  if (!site) throw new Error("Indirizzo del server non disponibile")
  const secret = randomBytes(24).toString("hex")
  await putSecret(ctx, "telegram_hook", secret)
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ url: `${site}/telegram`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(`Telegram non accetta il collegamento dei comandi (${j.description ?? r.status})`)
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ commands: [
      { command: "stato", description: "Saldo, posizioni e risultato" },
      { command: "mercato", description: "Punteggi delle crypto" },
      { command: "turno", description: "Analizza adesso" },
      { command: "pausa", description: "Stop nuovi acquisti" },
      { command: "riprendi", description: "Riattiva gli acquisti" },
      { command: "chiudi", description: "Vendi tutto e metti in pausa" },
      { command: "aiuto", description: "Elenco comandi" },
    ] }),
  }).catch(() => null)
}

/** Attiva i comandi Telegram sul bot già collegato (usata dall'amministratore). */
export const telegramEnableCommands = internalAction({
  args: {},
  handler: async (ctx) => {
    const t = await getSecret(ctx, "telegram_token")
    if (!t || !(await getSecret(ctx, "telegram_chat"))) throw new Error("Telegram non collegato")
    await registerWebhook(ctx, t)
    await telegram(ctx, "🐺 Comandi attivi. Scrivi /aiuto per l'elenco.")
    return { ok: true }
  },
})

const eur = (n: unknown) => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(2).replace(".", ",")} €` : "—")
const sgn = (n: unknown) => (Number(n) > 0 ? "+" : "") + eur(n)
const AIUTO = `🐺 <b>Comandi Wolf Street</b>
/stato — saldo, posizioni aperte e risultato
/mercato — punteggi BTC, ETH, SOL, XRP
/turno — il desk analizza adesso
/pausa — stop ai nuovi acquisti (stop e target restano attivi)
/riprendi — riattiva gli acquisti
/chiudi — vende tutto e mette in pausa (chiede conferma)

LIVE e kill switch solo dal sito, per sicurezza.`

function statoText(o: any, c: any): string {
  if (!o) return "Nessun turno ancora eseguito."
  const k = o.kpi ?? {}
  const pos = (o.positions ?? []).map((p: any) =>
    `• <b>${esc(p.symbol)}</b> ${esc(p.qty)} @ ${esc(p.entry)} · ora ${esc(p.price ?? "—")} · ${sgn(p.pnl)}\n   stop ${Number(p.stop).toFixed(2)} · target ${Number(p.tp).toFixed(2)}`).join("\n")
  const stato = c.kill_switch ? "KILL SWITCH" : c.paused ? `IN PAUSA${c.pause_reason ? " (" + esc(c.pause_reason) + ")" : ""}` : "operativo"
  return `🐺 <b>Stato desk</b> · ${esc(String(o.mode).toUpperCase())} · ${stato}
Turno delle ${new Date(o.generated_at * 1000).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}
EUR liberi: ${eur(o.balances?.EUR?.available ?? k.cash)}
Patrimonio: ${eur(k.equity)} · oggi ${sgn(k.pnl_today)} · settimana ${sgn(k.pnl_week)}
${pos ? "<b>Posizioni</b>\n" + pos : "Nessuna posizione aperta."}`
}
function mercatoText(o: any): string {
  if (!o?.signals?.length) return "Nessuna analisi disponibile."
  return "📊 <b>Mercato</b> (soglia " + (o.config?.min_score ?? "—") + ")\n" + o.signals.map((s: any) =>
    `• <b>${esc(s.symbol)}</b> ${esc(s.action)} ${s.score}/100 · ${esc(s.live_price ?? s.price)} €\n   ${esc((s.reasons ?? [])[0] ?? "")}`).join("\n")
}

export const telegramUpdate = internalAction({
  args: { secret: v.string(), body: v.string() },
  handler: async (ctx, { secret, body }) => {
    const hook = await getSecret(ctx, "telegram_hook")
    if (!hook || secret.length !== hook.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(hook))) return
    let msg: any
    try { msg = JSON.parse(body)?.message } catch { return }
    const chat = await getSecret(ctx, "telegram_chat")
    if (!msg?.chat || !chat || String(msg.chat.id) !== chat) return // solo la chat del titolare
    const text = String(msg.text ?? "").trim().toLowerCase().replace(/@\w+/, "")
    const [cmd, arg] = text.split(/\s+/)
    const read = () => ctx.runQuery(internal.store.readOffice, {})
    try {
      if (cmd === "/stato") { const { office, control } = await read(); await telegram(ctx, statoText(office, control)) }
      else if (cmd === "/mercato") { const { office } = await read(); await telegram(ctx, mercatoText(office)) }
      else if (cmd === "/turno") {
        await telegram(ctx, "⏳ Analizzo…")
        const r: any = await ctx.runAction(internal.desk.runTurn, {})
        const { office, control } = await read()
        await telegram(ctx, r?.skipped ? `Turno già in corso, riprova tra poco.` : `${mercatoText(office)}\n\n${statoText(office, control)}`)
      } else if (cmd === "/pausa") { await ctx.runMutation(internal.store.telegramCommand, { cmd: "pause" }); await telegram(ctx, "⏸️ In pausa: niente nuovi acquisti. Stop e target delle posizioni aperte restano attivi.") }
      else if (cmd === "/riprendi") { await ctx.runMutation(internal.store.telegramCommand, { cmd: "resume" }); await telegram(ctx, "▶️ Ripreso: il desk torna a cercare ingressi.") }
      else if (cmd === "/chiudi" && arg === "conferma") {
        await ctx.runMutation(internal.store.telegramCommand, { cmd: "panic" })
        await ctx.runMutation(internal.store.telegramCommand, { cmd: "pause" })
        await telegram(ctx, "🔴 Chiudo tutte le posizioni…")
        await ctx.runAction(internal.desk.runTurn, {})
        const { office, control } = await read()
        await telegram(ctx, statoText(office, control))
      } else if (cmd === "/chiudi") await telegram(ctx, "Vuoi vendere tutte le posizioni del desk e metterlo in pausa?\nPer confermare scrivi: <b>/chiudi conferma</b>")
      else await telegram(ctx, AIUTO)
    } catch (e: any) {
      await telegram(ctx, `⚠️ Comando non riuscito: ${esc(e?.message ?? e)}`)
    }
  },
})
