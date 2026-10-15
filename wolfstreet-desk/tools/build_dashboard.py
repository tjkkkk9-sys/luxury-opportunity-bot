"""Genera docs/index.html (l'ufficio per il telefono) da docs/ufficio.src.html.

I dati DEMO incorporati vengono rigenerati facendo girare il vero Office in PAPER sulle
candele reali Revolut X di tests/fixtures: nessun numero inventato, ma NON sono i tuoi conti
(la dashboard lo dice con l'etichetta DEMO finché non colleghi il repository).
Uso:  python tools/build_dashboard.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from test_desk import CFG, FakeRevolutX

from bot import office


def make_demo() -> dict:
    fake, state, ctl = FakeRevolutX(), {}, {"mode": "paper"}
    snap = None
    for t in [c["t"] for c in fake.data["BTC-EUR"]][300:]:
        fake.now = t + 1
        snap = office.Office(fake, CFG, ctl, state, now=t + 1, ai_review=lambda s, c: None).run()
    snap["demo"] = True
    return snap


demo = make_demo()
(ROOT / "docs" / "data" / "demo.json").write_text(json.dumps(demo, ensure_ascii=False, separators=(",", ":")))
src = (ROOT / "docs" / "ufficio.src.html").read_text()
body = src.replace("/*__DEMO__*/", json.dumps(demo, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"))
head = """<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111214">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111214'/%3E%3Cpath d='M7 9l4 14 5-10 5 10 4-14' fill='none' stroke='%23d2ad62' stroke-width='2.6' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>:root{padding-top:env(safe-area-inset-top,0px)}[hidden]{display:none!important}</style>
"""
html = head + body.replace('<div class="wrap">', '</head>\n<body>\n<div class="wrap">', 1) + "\n</body>\n</html>\n"
(ROOT / "docs" / "index.html").write_text(html)
print("ok", len(html), "byte · demo", demo["runs"], "turni,", demo["kpi"]["trades"], "operazioni")
