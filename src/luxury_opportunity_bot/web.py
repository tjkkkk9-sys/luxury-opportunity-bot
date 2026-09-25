from __future__ import annotations

import os
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse

from .io import eligible
from .notify import ConsoleNotifier, TelegramNotifier, notify
from .scraper import MarketplaceScraper
from .storage import list_opportunities, make_session_factory, save_opportunities

load_dotenv()
factory = make_session_factory()
scheduler = BackgroundScheduler()


def scrape_and_notify() -> int:
    urls = [url.strip() for url in os.getenv("SCRAPE_URLS", "").split(",") if url.strip()]
    found = []
    for url in urls:
        found.extend(MarketplaceScraper().fetch(url, source=url))
    selected = eligible(found, float(os.getenv("MIN_PROFIT", "100")), float(os.getenv("MIN_ROI_PERCENT", "20")))
    saved = save_opportunities(factory, found)
    token, chat_id = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if token and chat_id:
        notify(selected, TelegramNotifier(token, chat_id, int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))))
    return saved


@asynccontextmanager
async def lifespan(app: FastAPI):
    minutes = max(1, int(os.getenv("SCRAPE_INTERVAL_MINUTES", "60")))
    if os.getenv("SCRAPE_URLS", "").strip():
        scheduler.add_job(scrape_and_notify, "interval", minutes=minutes, id="marketplace-scan", replace_existing=True)
        scheduler.start()
    yield
    if scheduler.running:
        scheduler.shutdown(wait=False)


app = FastAPI(title="Luxury Opportunity Bot", version="0.2.0", lifespan=lifespan)


@app.get("/api/opportunities")
def opportunities(limit: int = Query(100, ge=1, le=500)):
    return [{"id": row.id, "title": row.title, "brand": row.brand, "url": row.url,
             "purchase_price": float(row.purchase_price), "sale_price": float(row.estimated_sale_price),
             "source": row.source, "created_at": row.created_at.isoformat()} for row in list_opportunities(factory, limit)]


@app.get("/", response_class=HTMLResponse)
def dashboard():
    rows = opportunities(100)
    cards = "".join(f"<tr><td>{r['brand']}</td><td>{r['title']}</td><td>{r['purchase_price']:.2f}</td><td>{r['source']}</td><td><a href='{r['url']}' target='_blank'>Apri</a></td></tr>" for r in rows)
    return f"""<!doctype html><html lang='it'><head><meta charset='utf-8'><title>Luxury Opportunities</title><style>body{{font:16px system-ui;margin:2rem;background:#f7f7f7}}table{{background:white;border-collapse:collapse;width:100%}}td,th{{padding:.7rem;border-bottom:1px solid #ddd;text-align:left}}h1{{color:#222}}</style></head><body><h1>Luxury Opportunities</h1><p>{len(rows)} opportunità archiviate</p><table><tr><th>Brand</th><th>Titolo</th><th>Prezzo</th><th>Fonte</th><th>Link</th></tr>{cards}</table></body></html>"""
