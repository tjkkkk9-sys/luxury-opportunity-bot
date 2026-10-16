import { describe, expect, it } from "vitest"
import { fmtWait, salaState } from "../src/components/sala-state"

const T = 1_792_120_622
const base = (over: any = {}) => ({
  generated_at: T, mode: "live", live_armed: true, kill_switch: false, paused: false, errors: [],
  log: [
    { t: T, bot: "ANALISTA", text: "BTC-EUR 62/100 → nessun ingresso", level: "info" },
    { t: T, bot: "TRADER", text: "BTC-EUR tenuto, stop 70727", level: "info" },
    { t: T, bot: "SISTEMA", text: "turno completato", level: "info" },
    { t: T, bot: "SCOUT", text: "Saldo confermato da Revolut X", level: "info" },
    { t: T - 1800, bot: "RISK", text: "segnale valido ma bloccato: limite giornaliero", level: "warn" },
  ],
  ...over,
})

describe("salaState", () => {
  it("mostra LIVE · ARMATO solo se il backend lo conferma", () => {
    expect(salaState(base(), T + 60).modeLabel).toBe("LIVE · ARMATO")
    expect(salaState(base({ live_armed: false }), T + 60).liveConfirmed).toBe(false)
    expect(salaState(base({ live_armed: false }), T + 60).modeLabel).toBe("MODALITÀ NON CONFERMATA")
    expect(salaState(base({ live_armed: undefined }), T + 60).modeLabel).not.toMatch(/LIVE|ARMATO/)
    expect(salaState(base({ mode: "paper" }), T + 60).modeLabel).toBe("PAPER")
    expect(salaState(base({ kill_switch: true }), T + 60).modeLabel).toBe("KILL SWITCH")
  })
  it("dati vecchi o mancanti = non connesso, mai LIVE", () => {
    for (const D of [null, {}, base({ generated_at: 0 }), base({ mode: "spento" })]) {
      const S = salaState(D, T + 60)
      expect(S.connected).toBe(false)
      expect(S.modeLabel).toBe("NON CONNESSO")
      expect(Object.values(S.roles).every((r) => r.status === "non connesso")).toBe(true)
    }
    const old = salaState(base(), T + 41 * 60)
    expect(old.connected).toBe(false)
    expect(old.liveConfirmed).toBe(false)
    expect(old.reason).toMatch(/41 minuti/)
  })
  it("stato di ogni ruolo dal registro dell'ultimo turno", () => {
    const S = salaState(base(), T + 60)
    expect(S.roles.ANALISTA.status).toBe("attivo")
    expect(S.roles.RISK.status).toBe("in attesa") // la sua voce è del turno prima
    expect(S.roles.RISK.last?.text).toMatch(/bloccato/)
    expect(S.roles.SCOUT.status).toBe("attivo")
    expect(Object.keys(S.roles)).toEqual(["SCOUT", "ANALISTA", "VERIFICATORE", "RISK", "TRADER"]) // Sistema non è un robot
    expect(S.system.entries[0].text).toBe("turno completato")
    const E = salaState(base({ log: [{ t: T, bot: "SCOUT", text: "Registro e conto non coincidono", level: "error" }, { t: T, bot: "SISTEMA", text: "Turno interrotto", level: "error" }] }), T + 60)
    expect(E.roles.SCOUT.status).toBe("errore")
    expect(E.roles.SCOUT.error?.text).toMatch(/non coincidono/)
    expect(E.events.scoutStop).toBe(true)
    expect(E.system.error?.text).toBe("Turno interrotto")
    expect(E.events.errors).toBe(true)
  })
  it("proposte in attesa dal backend, mai inventate", () => {
    const P = base({ proposals: [{ status: "in attesa", expires: T + 900 }, { status: "scaduta", expires: T - 1 }, { status: "in attesa", expires: T - 5 }],
      log: [{ t: T, bot: "TRADER", text: "PROPOSTA acquisto BTC-EUR 12,00 €", level: "info" }] })
    expect(salaState(P, T + 60).pendingProposals).toBe(1)
    expect(salaState(P, T + 60).events.proposal).toBe(true)
    expect(salaState({ ...P, generated_at: T - 7200 }, T + 60).pendingProposals).toBe(0)
  })
  it("eventi solo da voci reali", () => {
    const S = salaState(base(), T + 60)
    expect(S.events).toMatchObject({ trade: false, sold: false, riskBlock: false, buySignal: false, avoidOnly: true })
    const B = salaState(base({ log: [
      { t: T, bot: "ANALISTA", text: "ETH-EUR 80/100 → COMPRA", level: "info" },
      { t: T, bot: "TRADER", text: "COMPRATO ETH-EUR 0.003", level: "trade" },
    ] }), T + 60)
    expect(B.events.buySignal && B.events.trade).toBe(true)
  })
  it("conto alla rovescia del turno", () => {
    expect(salaState(base(), T + 600).nextInS).toBe(1200)
    expect(fmtWait(1200)).toBe("20:00")
    expect(fmtWait(-120)).toBe("in ritardo di 2 min")
    expect(fmtWait(null)).toBe("—")
  })
})
