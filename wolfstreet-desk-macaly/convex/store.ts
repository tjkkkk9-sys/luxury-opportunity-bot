import { getAuthUserId } from "@convex-dev/auth/server"
import { v } from "convex/values"
import { internalMutation, internalQuery, mutation, query } from "./_generated/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import { DEFAULT_CONFIG } from "./lib/safety"

// ------------------------------------------------------------------ helper
async function getKV(ctx: QueryCtx, key: string): Promise<string | null> {
  const row = await ctx.db.query("kv").withIndex("key", (q) => q.eq("key", key)).unique()
  return row ? row.value : null
}
async function putKV(ctx: MutationCtx, key: string, value: string) {
  const row = await ctx.db.query("kv").withIndex("key", (q) => q.eq("key", key)).unique()
  if (row) await ctx.db.patch(row._id, { value })
  else await ctx.db.insert("kv", { key, value })
}
const parse = (s: string | null, d: any) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const DEFAULT_CONTROL = { mode: "shadow", paused: false, pause_reason: "", panic_close: false, kill_switch: false, live_armed: false, armed_key: null, armed_at: null }

/** Solo il titolare (DESK_OWNER_EMAIL) può vedere il desk e dare comandi. */
export async function ownerEmail(ctx: QueryCtx): Promise<string | null> {
  const id = await getAuthUserId(ctx)
  if (!id) return null
  const user = await ctx.db.get(id)
  const owner = (process.env.DESK_OWNER_EMAIL ?? "").trim().toLowerCase()
  const email = (user?.email ?? "").trim().toLowerCase()
  return owner && email === owner ? email : null
}
async function requireOwner(ctx: QueryCtx) {
  if (!(await ownerEmail(ctx))) throw new Error("Accesso riservato al titolare del desk")
}

// ---------------------------------------------------------- uso interno
export const readAll = internalQuery({
  args: {},
  handler: async (ctx) => ({
    config: { ...DEFAULT_CONFIG, ...parse(await getKV(ctx, "config"), {}) },
    control: { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) },
    state: parse(await getKV(ctx, "state"), {}),
  }),
})

/** Salva stato e control. Il control viene fuso campo per campo con quello attuale, così un comando
 *  arrivato dal telefono durante il turno (pausa, kill switch, modalità) non viene sovrascritto. */
export const saveTurn = internalMutation({
  args: { state: v.string(), control: v.optional(v.string()), base: v.optional(v.string()), office: v.optional(v.string()), selftest: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await putKV(ctx, "state", a.state)
    if (a.control !== undefined) {
      const current = { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) }
      const base = parse(a.base ?? null, {})
      const next = parse(a.control, {})
      const merged: Record<string, any> = { ...current }
      for (const [k, val] of Object.entries(next)) {
        // il turno vince solo sui campi che il telefono non ha cambiato nel frattempo
        if (JSON.stringify(current[k as keyof typeof current]) === JSON.stringify(base[k])) merged[k] = val
      }
      if (merged.mode !== "live") Object.assign(merged, { live_armed: false, armed_key: null, armed_at: null })
      await putKV(ctx, "control", JSON.stringify(merged))
    }
    if (a.office !== undefined) await putKV(ctx, "office", a.office)
    if (a.selftest !== undefined) await putKV(ctx, "selftest", a.selftest)
  },
})

export const lock = internalMutation({
  args: { now: v.number(), release: v.optional(v.boolean()) },
  handler: async (ctx, { now, release }) => {
    if (release) { await putKV(ctx, "lock", "0"); return true }
    const held = Number((await getKV(ctx, "lock")) ?? 0)
    if (held && now - held < 9 * 60) return false // un turno è già in corso (max 9 minuti)
    await putKV(ctx, "lock", String(now))
    return true
  },
})

export const getSecretRow = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ctx.db.query("secrets").withIndex("name", (q) => q.eq("name", name)).unique(),
})
export const putSecretRow = internalMutation({
  args: { name: v.string(), iv: v.string(), tag: v.string(), data: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("secrets").withIndex("name", (q) => q.eq("name", a.name)).unique()
    const doc = { ...a, updatedAt: Date.now() }
    if (row) await ctx.db.patch(row._id, doc)
    else await ctx.db.insert("secrets", doc)
  },
})
export const deleteSecretRow = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = await ctx.db.query("secrets").withIndex("name", (q) => q.eq("name", name)).unique()
    if (row) await ctx.db.delete(row._id)
  },
})
export const isOwner = internalQuery({ args: {}, handler: async (ctx) => !!(await ownerEmail(ctx)) })

// ---------------------------------------------------------- pubblico (solo titolare)
export const me = query({
  args: {},
  handler: async (ctx) => {
    const id = await getAuthUserId(ctx)
    if (!id) return { signedIn: false, owner: false }
    return { signedIn: true, owner: !!(await ownerEmail(ctx)) }
  },
})

export const view = query({
  args: {},
  handler: async (ctx) => {
    if (!(await ownerEmail(ctx))) return null
    const names = ["revx_api_key", "revx_private_key", "anthropic_key", "telegram_token", "telegram_chat"]
    const keys: Record<string, boolean> = {}
    for (const n of names) keys[n] = !!(await ctx.db.query("secrets").withIndex("name", (q) => q.eq("name", n)).unique())
    return {
      office: parse(await getKV(ctx, "office"), null),
      selftest: parse(await getKV(ctx, "selftest"), null),
      control: { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) },
      keys,
      keyFingerprint: (await getKV(ctx, "key_fingerprint")) ?? null,
    }
  },
})

export const setFingerprint = internalMutation({
  args: { fp: v.union(v.string(), v.null()) },
  handler: async (ctx, { fp }) => { await putKV(ctx, "key_fingerprint", fp ?? "") },
})

const COMMANDS = ["pause", "resume", "shadow", "paper", "live", "kill", "unkill", "panic"] as const
export const command = mutation({
  args: { cmd: v.string(), confirm: v.optional(v.string()) },
  handler: async (ctx, { cmd, confirm }) => {
    await requireOwner(ctx)
    if (!(COMMANDS as readonly string[]).includes(cmd)) throw new Error("Comando sconosciuto")
    const c: Record<string, any> = { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) }
    const disarm = { live_armed: false, armed_key: null, armed_at: null }
    if (cmd === "pause") Object.assign(c, { paused: true, pause_reason: "Pausa manuale dal telefono" })
    if (cmd === "resume") Object.assign(c, { paused: false, pause_reason: "" })
    if (cmd === "shadow" || cmd === "paper") Object.assign(c, { mode: cmd, ...disarm })
    if (cmd === "live") {
      if ((confirm ?? "").trim().toUpperCase() !== "SOLDI VERI") throw new Error("Per chiedere il LIVE scrivi esattamente SOLDI VERI")
      Object.assign(c, { mode: "live", ...disarm })
    }
    if (cmd === "kill") Object.assign(c, { kill_switch: true, ...disarm })
    if (cmd === "unkill") Object.assign(c, { kill_switch: false })
    if (cmd === "panic") Object.assign(c, { panic_close: true })
    await putKV(ctx, "control", JSON.stringify(c))
    return c
  },
})

export const saveConfig = mutation({
  args: { patch: v.string() },
  handler: async (ctx, { patch }) => {
    await requireOwner(ctx)
    const allowed = ["budget_eur", "paper_start_eur", "risk_per_trade_eur", "daily_loss_limit_eur", "weekly_loss_limit_eur", "max_drawdown_pct", "min_score", "pairs"]
    const p = parse(patch, {})
    const cur = parse(await getKV(ctx, "config"), {})
    for (const k of Object.keys(p)) if (!allowed.includes(k)) throw new Error(`Campo non modificabile: ${k}`)
    await putKV(ctx, "config", JSON.stringify({ ...cur, ...p }))
  },
})

// ---------------------------------------------------------- Plus500 (solo segnali, nessun ordine)
export const readP500 = internalQuery({
  args: {},
  handler: async (ctx) => ({ config: parse(await getKV(ctx, "p500_config"), {}), state: parse(await getKV(ctx, "p500_state"), {}) }),
})
export const saveP500 = internalMutation({
  args: { state: v.string(), view: v.string() },
  handler: async (ctx, a) => { await putKV(ctx, "p500_state", a.state); await putKV(ctx, "p500_view", a.view) },
})
export const p500View = query({
  args: {},
  handler: async (ctx) => {
    if (!(await ownerEmail(ctx))) return null
    const has = async (n: string) => !!(await ctx.db.query("secrets").withIndex("name", (q) => q.eq("name", n)).unique())
    const tg = (await has("telegram_token")) && (await has("telegram_chat"))
    return { view: parse(await getKV(ctx, "p500_view"), null), config: parse(await getKV(ctx, "p500_config"), {}), telegram: tg, telegramToken: await has("telegram_token") }
  },
})
export const saveP500Config = mutation({
  args: { patch: v.string() },
  handler: async (ctx, { patch }) => {
    await requireOwner(ctx)
    const allowed = ["enabled", "capital_eur", "risk_pct", "max_margin_pct", "min_score"]
    const p = parse(patch, {})
    for (const k of Object.keys(p)) if (!allowed.includes(k)) throw new Error(`Campo non modificabile: ${k}`)
    const cur = parse(await getKV(ctx, "p500_config"), {})
    await putKV(ctx, "p500_config", JSON.stringify({ ...cur, ...p }))
  },
})
