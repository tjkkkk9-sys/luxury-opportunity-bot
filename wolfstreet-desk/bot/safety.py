"""Regole di sicurezza NON modificabili da config.json, control.json o dalla dashboard.

Modalità:
- SHADOW (predefinita): calcola e registra le decisioni, nessun ordine e nessun portafoglio;
- PAPER: portafoglio virtuale su prezzi veri Revolut X;
- LIVE: ordini veri. Si attiva solo se valgono TUTTE insieme:
    1. control.json  mode = "live"
    2. control.json  kill_switch = false
    3. control.json  live_armed = true, scritto SOLO da `--selftest` riuscito,
       e legato all'impronta della API key in uso (chiave cambiata → disarmato)
    4. secret GitHub LIVE_TRADING = "SI"
  Se manca anche una sola condizione il turno gira in SHADOW (fail-closed).

Le USCITE delle posizioni LIVE già aperte (stop, target, trend) restano attive anche se il
desk è disarmato, perché lasciare una posizione vera senza stop è più rischioso; si fermano
solo con il kill switch o senza il secret LIVE_TRADING.
"""
from __future__ import annotations

MODES = ("shadow", "paper", "live")

# Tetti massimi: config.json può solo essere più prudente di così.
HARD = {
    "max_risk_pct": 1.5,          # rischio massimo per operazione, % del patrimonio
    "max_position_pct": 30.0,     # peso massimo di una posizione, % del patrimonio
    "max_open_positions": 2,      # posizioni contemporanee
    "max_exposure_pct": 60.0,     # somma delle posizioni, % del patrimonio
    "min_stop_atr": 1.0,          # lo stop non può essere più stretto di 1 ATR
}


def clamp_config(cfg: dict) -> tuple[dict, list[str]]:
    """Ritorna una copia di cfg con i valori riportati dentro i tetti, e l'elenco delle correzioni."""
    out, notes = dict(cfg), []
    caps = {
        "max_risk_pct": HARD["max_risk_pct"],
        "max_position_pct": HARD["max_position_pct"],
        "max_open_positions": HARD["max_open_positions"],
        "max_exposure_pct": HARD["max_exposure_pct"],
    }
    for k, cap in caps.items():
        v = out.get(k, cap)
        if v is None or v > cap:
            out[k] = cap
            if v is not None:
                notes.append(f"{k}={v} oltre il tetto di sicurezza: uso {cap}")
    if out.get("stop_atr", 0) < HARD["min_stop_atr"]:
        notes.append(f"stop_atr={out.get('stop_atr')} troppo stretto: uso {HARD['min_stop_atr']}")
        out["stop_atr"] = HARD["min_stop_atr"]
    for k in ("daily_loss_limit_eur", "weekly_loss_limit_eur", "risk_per_trade_eur", "budget_eur"):
        if not isinstance(out.get(k), (int, float)) or out[k] <= 0:
            raise ValueError(f"config.json: '{k}' mancante o non valido")
    return out, notes


def resolve_mode(control: dict, live_secret: bool, key_fp: str | None) -> tuple[str, list[str]]:
    """Modalità effettiva del turno e motivi per cui LIVE non è attivo (lista vuota se lo è)."""
    requested = str(control.get("mode", "shadow")).lower()
    if requested not in MODES:
        return "shadow", [f"modalità '{requested}' sconosciuta: uso SHADOW"]
    if requested != "live":
        return requested, []
    why = []
    if control.get("kill_switch"):
        why.append("kill switch attivo")
    if not live_secret:
        why.append("manca il secret LIVE_TRADING = SI")
    if not control.get("live_armed"):
        why.append("LIVE non armato: esegui 'Verifica e arma LIVE'")
    elif not key_fp or control.get("armed_key") != key_fp:
        why.append("la API key è cambiata dopo l'armamento: riesegui la verifica")
    return ("live", []) if not why else ("shadow", why)


def live_exits_allowed(control: dict, live_secret: bool) -> bool:
    return live_secret and not control.get("kill_switch")
