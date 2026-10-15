import { authTables } from "@convex-dev/auth/server"
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  ...authTables,
  // Utenti di Convex Auth. role/isActive restano opzionali per compatibilità con gli account già esistenti.
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    role: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  }).index("email", ["email"]).index("phone", ["phone"]),

  // Memoria del desk: config, control, state, office (istantanea), selftest, lock del turno.
  kv: defineTable({ key: v.string(), value: v.string() }).index("key", ["key"]),

  // Chiavi Revolut X / Claude / Telegram cifrate con AES-256-GCM (chiave in DESK_ENC_KEY, mai nel database).
  // Nessuna query pubblica legge questa tabella.
  secrets: defineTable({ name: v.string(), iv: v.string(), tag: v.string(), data: v.string(), updatedAt: v.number() }).index("name", ["name"]),
})
