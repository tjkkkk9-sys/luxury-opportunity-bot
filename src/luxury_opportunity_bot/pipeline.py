from __future__ import annotations

import os
from apscheduler.schedulers.blocking import BlockingScheduler
from dotenv import load_dotenv

from .io import eligible
from .notify import TelegramNotifier, notify
from .scraper import MarketplaceScraper
from .storage import claim_unnotified, save_opportunities


def run_pipeline(factory) -> int:
    found = []
    for url in (value.strip() for value in os.getenv("SCRAPE_URLS", "").split(",")):
        if url: found.extend(MarketplaceScraper().fetch(url, source=url))
    saved = save_opportunities(factory, found)
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN", ""), os.getenv("TELEGRAM_CHAT_ID", "")
    if token and chat:
        selected = claim_unnotified(factory, float(os.getenv("MIN_PROFIT", "100")), float(os.getenv("MIN_ROI_PERCENT", "20")))
        if selected: notify(selected, TelegramNotifier(token, chat, int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))))
    return saved


def run_scheduler(factory):
    scheduler = BlockingScheduler(timezone="UTC")
    minutes = max(1, int(os.getenv("SCRAPE_INTERVAL_MINUTES", "60")))
    scheduler.add_job(lambda: run_pipeline(factory), "interval", minutes=minutes, id="marketplace-scan", max_instances=1, coalesce=True)
    run_pipeline(factory)  # first scan immediately, then every X minutes
    print(f"Pipeline attiva: ogni {minutes} minuti")
    scheduler.start()
