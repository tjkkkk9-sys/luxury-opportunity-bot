"""Secondo parere IA (Claude) sui candidati all'acquisto.

Regole:
- l'IA può solo AGGIUNGERE un veto: non alza il rischio, non sceglie l'importo, non inventa numeri;
- se l'IA è attiva (ANTHROPIC_API_KEY presente e ai_review=true) ma non risponde, rifiuta
  o risponde in modo illeggibile → VETO (fail-closed);
- se l'IA non è configurata ritorna None e decidono solo le regole in codice.
Viene chiamata solo quando c'è un candidato: costo di pochi centesimi al mese.
"""
from __future__ import annotations

import json
import os

PROMPT = """Sei il risk reviewer di un piccolo desk crypto spot (solo acquisti, niente leva).
Il bot Analista propone un ACQUISTO su {symbol} (candele {interval}).
Dati calcolati dal codice sull'ultima candela chiusa (numeri reali, non modificarli):
{data}
Valuta solo con questi dati se l'ingresso è coerente con lo stile "compra la correzione in trend rialzista".
In caso di dubbio scegli VETO. Motivo: massimo 18 parole, in italiano."""

SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["APPROVA", "VETO"]},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}


def enabled(cfg: dict) -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip()) and bool(cfg.get("ai_review", True))


def _veto(reason: str) -> dict:
    return {"verdict": "VETO", "reason": reason[:160]}


def review(signal: dict, cfg: dict, client=None) -> dict | None:
    if not enabled(cfg):
        return None
    data = {
        "prezzo": signal["price"], "punteggio_regole": signal["score"], "motivi": signal["reasons"],
        **{k: round(v, 4) for k, v in signal["ind"].items() if isinstance(v, (int, float))},
        "spread_pct": signal.get("spread_pct"),
    }
    try:
        if client is None:
            import anthropic
            client = anthropic.Anthropic(timeout=30.0, max_retries=2)
        response = client.messages.create(
            model=os.getenv("AI_MODEL", cfg.get("ai_model", "claude-haiku-5-5")),
            max_tokens=1024,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": PROMPT.format(
                symbol=signal["symbol"], interval=f'{cfg["interval_min"] // 60}h',
                data=json.dumps(data, ensure_ascii=False))}],
        )
    except Exception as e:  # rete, chiave, limiti: nel dubbio non si compra
        return _veto(f"IA non disponibile ({type(e).__name__}): veto prudenziale")
    if response.stop_reason == "refusal":
        return _veto("IA ha rifiutato la richiesta: veto prudenziale")
    try:
        text = next(b.text for b in response.content if b.type == "text")
        out = json.loads(text)
        verdict = out["verdict"]
        if verdict not in ("APPROVA", "VETO"):
            raise ValueError(verdict)
    except Exception:
        return _veto("Risposta IA illeggibile: veto prudenziale")
    return {"verdict": verdict, "reason": str(out.get("reason", ""))[:160]}
