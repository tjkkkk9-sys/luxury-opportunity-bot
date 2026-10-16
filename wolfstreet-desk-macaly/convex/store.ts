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

export const saveKV = internalMutation({
  args: { key: v.string(), value: v.string() },
  handler: async (ctx, { key, value }) => {
    if (!["lab_variants"].includes(key)) throw new Error("chiave non prevista")
    await putKV(ctx, key, value)
  },
})
const STRATEGY_KEYS = ["pairs", "min_score", "min_adx", "ema50_slope_bars", "stop_atr", "tp_atr"]
/** Cambia SOLO i parametri di strategia (mai limiti di perdita, budget o tetti). Salva prima la versione precedente. */
export const applyStrategy = internalMutation({
  args: { patch: v.string(), note: v.string() },
  handler: async (ctx, { patch, note }) => {
    const p = parse(patch, {})
    for (const k of Object.keys(p)) if (!STRATEGY_KEYS.includes(k)) throw new Error(`Campo non modificabile: ${k}`)
    const cur = parse(await getKV(ctx, "config"), {})
    const eff = { ...DEFAULT_CONFIG, ...cur }
    const prev = Object.fromEntries(STRATEGY_KEYS.map((k) => [k, eff[k] ?? null]))
    await putKV(ctx, "config_prev", JSON.stringify({ t: Math.floor(Date.now() / 1000), values: prev, replaced_by: note }))
    const next = { ...cur, ...Object.fromEntries(STRATEGY_KEYS.map((k) => [k, null])), ...p }
    for (const k of STRATEGY_KEYS) if (next[k] === null) next[k] = (DEFAULT_CONFIG as any)[k] ?? null
    await putKV(ctx, "config", JSON.stringify({ ...next, strategy_note: note }))
  },
})
export const rollbackStrategy = internalMutation({
  args: {},
  handler: async (ctx) => {
    const prev = parse(await getKV(ctx, "config_prev"), null)
    if (!prev?.values) return { ok: false, text: "Nessuna configurazione precedente da ripristinare" }
    const cur = parse(await getKV(ctx, "config"), {})
    await putKV(ctx, "config", JSON.stringify({ ...cur, ...prev.values, strategy_note: "ripristinata la configurazione precedente" }))
    await putKV(ctx, "config_prev", "")
    return { ok: true, text: `Strategia riportata a com'era prima di: ${prev.replaced_by}` }
  },
})
export const readTracking = internalQuery({
  args: {},
  handler: async (ctx) => ({ tracking: parse(await getKV(ctx, "tracking"), []) as string[], variants: parse(await getKV(ctx, "lab_variants"), null) }),
})
export const setTracking = internalMutation({
  args: { id: v.string(), on: v.boolean() },
  handler: async (ctx, { id, on }) => {
    const cur: string[] = parse(await getKV(ctx, "tracking"), [])
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)
    await putKV(ctx, "tracking", JSON.stringify(next))
    return next
  },
})
/** Riparazione una tantum (16/10/2026): l'allineamento aveva SPOSTATO la curva LIVE di d invece di ridurla in proporzione.
 *  Riporta i punti fino a beforeT alla scala giusta e ricalcola il massimo. Non tocca cassa, posizioni né control. */
export const repairWithdrawalScale = internalMutation({
  args: { d: v.number(), beforeT: v.number() },
  handler: async (ctx, { d, beforeT }) => {
    const st = parse(await getKV(ctx, "state"), {})
    const L = st?.books?.live
    if (!L || d >= 0 || L.eq_scale_fix) return { ok: false, why: "niente da riparare" }
    const f = L.cash / (L.cash - d)
    L.equity = (L.equity ?? []).map(([t, val]: [number, number]) => (t <= beforeT ? [t, Math.round((val - d) * f * 1e6) / 1e6] : [t, val]))
    L.peak = Math.max(...L.equity.map((e: [number, number]) => e[1]), L.cash)
    L.eq_scale_fix = true
    await putKV(ctx, "state", JSON.stringify(st))
    return { ok: true, peak: L.peak, f }
  },
})
export const readLab = internalQuery({ args: {}, handler: async (ctx) => parse(await getKV(ctx, "lab"), null) })
export const saveLab = internalMutation({ args: { lab: v.string() }, handler: async (ctx, { lab }) => { await putKV(ctx, "lab", lab) } })

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
      variants: parse(await getKV(ctx, "lab_variants"), null),
      tracking: parse(await getKV(ctx, "tracking"), []),
      configPrev: parse(await getKV(ctx, "config_prev"), null),
      strategyNote: parse(await getKV(ctx, "config"), {})?.strategy_note ?? null,
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

/** Stessi campi di saveConfig, usabile solo dall'amministratore del deployment (CLI), non dal sito. */
export const adminConfig = internalMutation({
  args: { patch: v.string() },
  handler: async (ctx, { patch }) => {
    const allowed = ["budget_eur", "paper_start_eur", "risk_per_trade_eur", "daily_loss_limit_eur", "weekly_loss_limit_eur", "max_drawdown_pct", "min_score", "pairs"]
    const p = parse(patch, {})
    for (const k of Object.keys(p)) if (!allowed.includes(k)) throw new Error(`Campo non modificabile: ${k}`)
    const cur = parse(await getKV(ctx, "config"), {})
    await putKV(ctx, "config", JSON.stringify({ ...cur, ...p }))
    return { ...cur, ...p }
  },
})

// ---------------------------------------------------------- comandi da Telegram (solo la chat del titolare)
export const readOffice = internalQuery({
  args: {},
  handler: async (ctx) => ({
    office: parse(await getKV(ctx, "office"), null),
    control: { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) },
  }),
})
/** Solo comandi che riducono il rischio o lo riportano normale: il LIVE e il kill switch restano sul sito. */
export const telegramCommand = internalMutation({
  args: { cmd: v.string() },
  handler: async (ctx, { cmd }) => {
    const c: Record<string, any> = { ...DEFAULT_CONTROL, ...parse(await getKV(ctx, "control"), {}) }
    if (cmd === "pause") Object.assign(c, { paused: true, pause_reason: "Pausa da Telegram" })
    else if (cmd === "resume") Object.assign(c, { paused: false, pause_reason: "" })
    else if (cmd === "panic") Object.assign(c, { panic_close: true })
    else throw new Error("Comando non permesso da Telegram")
    await putKV(ctx, "control", JSON.stringify(c))
    return c
  },
})
