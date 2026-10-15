"use node"
// Motore del desk: turno automatico, verifica, salvataggio chiavi. Tutto lato server.
import Anthropic from "@anthropic-ai/sdk"
import { v } from "convex/values"
import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { internal } from "./_generated/api"
import { action, internalAction } from "./_generated/server"
import type { ActionCtx } from "./_generated/server"
import { esc, Office, selftest as runSelftest } from "./lib/office"
import type { AiReview } from "./lib/office"
import { keyFingerprint, normalizePem, RevolutX } from "./lib/revolutx"

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
