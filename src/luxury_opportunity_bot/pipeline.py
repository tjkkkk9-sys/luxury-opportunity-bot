from __future__ import annotations

import os

from apscheduler.schedulers.blocking import BlockingScheduler
from dotenv import load_dotenv

from .notify import TelegramNotifier, notify
from .scraper import MarketplaceScraper
from .storage import claim_unnotified, make_session_factory, save_opportunities

load_dotenv()


def run_pipeline(factory) -> int:
    urls = [url.strip() for url in os.getenv("SCRAPE_URLS", "").split(",") if url.strip()]
    found = []
    for url in urls:
        found.extend(MarketplaceScraper().fetch(url, source=url))
    saved = save_opportunities(factory, found)
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat = os.getenv("TELEGRAM_CHAT_ID", "")
    if token and chat:
        selected = claim_unnotified(factory, float(os.getenv("MIN_PROFIT", "100")), float(os.getenv("MIN_ROI_PERCENT", "20")))
        if selected:
            notify(selected, TelegramNotifier(token, chat, int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))))
    return saved


def run_scheduler(factory):
    scheduler = BlockingScheduler(timezone="UTC")
    minutes = max(1, int(os.getenv("SCRAPE_INTERVAL_MINUTES", "60")))
    scheduler.add_job(lambda: run_pipeline(factory), "interval", minutes=minutes, id="marketplace-scan", max_instances=1, coalesce=True)
    print(f"Pipeline attiva: ogni {minutes} minuti")
    run_pipeline(factory)
    scheduler.start()
