import { describe, expect, it } from "vitest"
import { fmtWait, salaState } from "../src/components/sala-state"

const T = 1_792_120_622
const base = (over: any = {}) => ({
  generated_at: T, mode: "live", live_armed: true, kill_switch: false, paused: false, errors: [],
  log: [
    { t: T, bot: "ANALISTA", text: "BTC-EUR 62/100 → nessun ingresso", level: "info" },
    { t: T, bot: "TRADER", text: "BTC-EUR tenuto, stop 70727", level: "info" },
    { t: T, bot: "SISTEMA", text: "turno completato", level: "info" },
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
    const E = salaState(base({ log: [{ t: T, bot: "SISTEMA", text: "Revolut X non risponde", level: "error" }] }), T + 60)
    expect(E.roles.SISTEMA.status).toBe("errore")
    expect(E.events.errors).toBe(true)
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
