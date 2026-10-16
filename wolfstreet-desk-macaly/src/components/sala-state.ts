// Stato della Sala 3D ricavato SOLO dai dati del backend (istantanea "office" dell'ultimo turno).
// Niente attività inventata: se un dato manca o è vecchio, il ruolo risulta inattivo o non connesso.

// Quattro robot con un compito preciso, nell'ordine reale del flusso. SISTEMA è infrastruttura, non un robot.
export const ROLE_IDS = ["SCOUT", "ANALISTA", "RISK", "TRADER"] as const
export type RoleId = (typeof ROLE_IDS)[number]
export type RoleStatus = "attivo" | "in attesa" | "errore" | "non connesso"
export type LogEntry = { t: number; bot: string; text: string; level?: string }

export const ROLE_INFO: Record<RoleId, { title: string; job: string }> = {
  SCOUT: { title: "Scout", job: "Controlla che saldo e posizioni siano confermati da Revolut X e che prezzi e candele siano freschi" },
  ANALISTA: { title: "Analista", job: "Applica la strategia documentata alle candele 4h e spiega perché entrare o no" },
  RISK: { title: "Risk", job: "Controlla saldo libero, esposizione e limiti di perdita; può solo ridurre o bloccare" },
  TRADER: { title: "Trader", job: "Prepara l'ordine e lo invia solo dopo la tua conferma, poi verifica l'esito" },
}

/** Un turno ogni 30 minuti: oltre 40 minuti senza turni il desk risulta non connesso. */
export const STALE_AFTER_S = 40 * 60
export const TURN_S = 30 * 60

export type RoleState = {
  id: RoleId
  status: RoleStatus
  turnEntries: LogEntry[] // voci di questo bot nell'ultimo turno
  last: LogEntry | null // ultima voce in assoluto di questo bot
  error: LogEntry | null // prima voce d'errore del turno, se c'è
}

export type SalaState = {
  connected: boolean
  reason: string // perché non connesso, oppure ""
  turnAt: number | null
  ageS: number | null
  nextInS: number | null // secondi al prossimo turno atteso; negativo = in ritardo
  modeLabel: string // mai "LIVE" se il backend non lo conferma
  liveConfirmed: boolean
  paused: boolean
  killSwitch: boolean
  roles: Record<RoleId, RoleState>
  system: { entries: LogEntry[]; error: LogEntry | null } // infrastruttura: registro, modalità, ordini incerti
  pendingProposals: number // proposte LIVE in attesa della tua conferma (dal backend)
  events: { trade: boolean; sold: boolean; riskBlock: boolean; buySignal: boolean; avoidOnly: boolean; proposal: boolean; scoutStop: boolean; errors: boolean }
}

const isRole = (b: unknown): b is RoleId => (ROLE_IDS as readonly string[]).includes(String(b))
const isBot = (b: unknown) => isRole(b) || b === "SISTEMA"

export function salaState(D: any, nowS: number): SalaState {
  const turnAt = Number.isFinite(Number(D?.generated_at)) && Number(D?.generated_at) > 0 ? Number(D.generated_at) : null
  const ageS = turnAt === null ? null : Math.max(0, nowS - turnAt)
  let reason = ""
  if (!D || turnAt === null) reason = "Nessun turno ricevuto dal desk"
  else if (String(D.mode ?? "").toLowerCase() === "spento") reason = D.pause_reason || "Desk spento"
  else if ((ageS ?? 0) > STALE_AFTER_S) reason = `Ultimo turno ${Math.round((ageS ?? 0) / 60)} minuti fa`
  const connected = reason === ""

  const log: LogEntry[] = Array.isArray(D?.log) ? D.log.filter((l: any) => l && isBot(l.bot) && Number.isFinite(Number(l.t))) : []
  const turnLog = turnAt === null ? [] : log.filter((l) => Number(l.t) === turnAt)

  const roles = Object.fromEntries(ROLE_IDS.map((id) => {
    const turnEntries = turnLog.filter((l) => l.bot === id)
    const last = log.find((l) => l.bot === id) ?? null // il registro arriva dal più recente
    const error = turnEntries.find((l) => l.level === "error") ?? null
    let status: RoleStatus = "non connesso"
    if (connected) status = error ? "errore" : turnEntries.length ? "attivo" : "in attesa"
    return [id, { id, status, turnEntries, last, error }]
  })) as Record<RoleId, RoleState>

  const killSwitch = D?.kill_switch === true
  const paused = D?.paused === true
  // LIVE solo se il backend ha lavorato davvero in LIVE in questo turno E il controllo risulta armato.
  const liveConfirmed = connected && String(D?.mode) === "live" && D?.live_armed === true && !killSwitch
  let modeLabel: string
  if (!connected) modeLabel = "NON CONNESSO"
  else if (killSwitch) modeLabel = "KILL SWITCH"
  else if (liveConfirmed) modeLabel = "LIVE · ARMATO"
  // "live" senza conferma di armamento non viene mai mostrato come LIVE
  else if (String(D?.mode) === "live") modeLabel = "MODALITÀ NON CONFERMATA"
  else modeLabel = String(D?.mode ?? "sconosciuto").toUpperCase()
  if (connected && paused && !killSwitch) modeLabel += " · IN PAUSA"

  const tr = roles.TRADER.turnEntries, an = roles.ANALISTA.turnEntries
  const events = {
    trade: tr.some((l) => l.level === "trade" && /COMPRATO/.test(l.text)),
    sold: tr.some((l) => l.level === "trade" && /VENDUTO/.test(l.text)),
    riskBlock: roles.RISK.turnEntries.some((l) => /bloccato/.test(l.text)),
    buySignal: an.some((l) => /→ COMPRA/.test(l.text)),
    avoidOnly: an.some((l) => /nessun ingresso/.test(l.text)),
    proposal: tr.some((l) => /^PROPOSTA/.test(l.text)),
    scoutStop: roles.SCOUT.turnEntries.some((l) => l.level === "error"),
    errors: turnLog.some((l) => l.level === "error") || (Array.isArray(D?.errors) && D.errors.length > 0),
  }
  return {
    connected, reason, turnAt, ageS, nextInS: turnAt === null ? null : turnAt + TURN_S - nowS,
    modeLabel, liveConfirmed, paused, killSwitch, roles, events,
    system: { entries: turnLog.filter((l) => l.bot === "SISTEMA"), error: turnLog.find((l) => l.bot === "SISTEMA" && l.level === "error") ?? null },
    pendingProposals: connected && Array.isArray(D?.proposals)
      ? D.proposals.filter((p: any) => p?.status === "in attesa" && Number(p.expires) > nowS).length : 0,
  }
}

export function fmtWait(s: number | null): string {
  if (s === null) return "—"
  if (s < 0) return `in ritardo di ${Math.ceil(-s / 60)} min`
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}
