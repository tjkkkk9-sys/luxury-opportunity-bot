// Regole di sicurezza NON modificabili da configurazione o dashboard.
//
// SHADOW (predefinita): calcola e registra, nessun ordine e nessun portafoglio.
// PAPER: portafoglio virtuale su prezzi veri Revolut X.
// LIVE: ordini veri, solo se valgono TUTTE insieme:
//   mode = "live", kill_switch spento, live_armed = true (scritto SOLO da una verifica verde)
//   e legato all'impronta della API key in uso (chiave cambiata → disarmato).
// Altrimenti il turno gira in SHADOW (fail-closed). Le USCITE delle posizioni LIVE già aperte
// restano attive anche se disarmato; si fermano solo con il kill switch.
import type { Cfg } from "./strategy"

export const MODES = ["shadow", "paper", "live"] as const

export const HARD = {
  max_risk_pct: 1.5,        // rischio massimo per operazione, % del patrimonio
  max_position_pct: 30,     // peso massimo di una posizione
  max_open_positions: 2,    // posizioni contemporanee
  max_exposure_pct: 60,     // somma delle posizioni
  min_stop_atr: 1,          // stop mai più stretto di 1 ATR
}

export function clampConfig(cfg: Cfg): [Cfg, string[]] {
  const out: Cfg = { ...cfg }
  const notes: string[] = []
  for (const k of ["max_risk_pct", "max_position_pct", "max_open_positions", "max_exposure_pct"] as const) {
    const cap = HARD[k]
    const v = out[k]
    if (v === undefined || v === null || v > cap) {
      out[k] = cap
      if (v !== undefined && v !== null) notes.push(`${k}=${v} oltre il tetto di sicurezza: uso ${cap}`)
    }
  }
  if (!(out.stop_atr >= HARD.min_stop_atr)) {
    notes.push(`stop_atr=${out.stop_atr} troppo stretto: uso ${HARD.min_stop_atr}`)
    out.stop_atr = HARD.min_stop_atr
  }
  for (const k of ["daily_loss_limit_eur", "weekly_loss_limit_eur", "risk_per_trade_eur", "budget_eur"]) {
    if (typeof out[k] !== "number" || out[k] <= 0) throw new Error(`configurazione: '${k}' mancante o non valido`)
  }
  return [out, notes]
}

export type Control = {
  mode?: string; paused?: boolean; pause_reason?: string; panic_close?: boolean; kill_switch?: boolean
  live_armed?: boolean; armed_key?: string | null; armed_at?: number | null
}

export function resolveMode(ctl: Control, keyFp: string | null): [string, string[]] {
  const requested = String(ctl.mode ?? "shadow").toLowerCase()
  if (!(MODES as readonly string[]).includes(requested)) return ["shadow", [`modalità '${requested}' sconosciuta: uso SHADOW`]]
  if (requested !== "live") return [requested, []]
  const why: string[] = []
  if (ctl.kill_switch) why.push("kill switch attivo")
  if (!ctl.live_armed) why.push("LIVE non armato: esegui 'Verifica e arma LIVE'")
  else if (!keyFp || ctl.armed_key !== keyFp) why.push("la API key è cambiata dopo l'armamento: riesegui la verifica")
  return why.length ? ["shadow", why] : ["live", []]
}

export function liveExitsAllowed(ctl: Control): boolean {
  return !ctl.kill_switch
}

export const DEFAULT_CONFIG: Cfg = {
  company: "Wolf Street Capital", desk: "Desk Revolut X",
  pairs: ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"], interval_min: 240, candles: 300, style: "pullback",
  paper_start_eur: 40, budget_eur: 40, min_trade_eur: 5, risk_per_trade_eur: 0.6, max_risk_pct: 1.5,
  max_position_pct: 30, max_exposure_pct: 60, max_open_positions: 2, daily_loss_limit_eur: 2,
  weekly_loss_limit_eur: 4, max_drawdown_pct: 10, min_score: 80, pullback_rsi: 42, max_below_ema50_pct: 3,
  max_spread_pct: 0.3, min_atr_pct: 0.35, max_atr_pct: 8.0, stop_atr: 3.0, tp_atr: 4.0, trail_trigger_atr: 3.0,
  trail_atr: 3.0, time_stop_hours: 384, cooldown_hours: 6, taker_fee: 0.0009, ai_review: true,
  ai_model: "claude-haiku-5-5",
}
