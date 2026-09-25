from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

from .io import eligible, load_opportunities
from .notify import ConsoleNotifier, TelegramNotifier, WebhookNotifier, notify


def _notifier(mode: str):
    console = ConsoleNotifier()
    if mode == "console": return console
    timeout = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))
    if mode == "telegram": return TelegramNotifier(os.getenv("TELEGRAM_BOT_TOKEN", ""), os.getenv("TELEGRAM_CHAT_ID", ""), timeout)
    if mode == "webhook": return WebhookNotifier(os.getenv("WEBHOOK_URL", ""), timeout)
    return _Both(console, _notifier("telegram" if mode == "both-telegram" else "webhook"))


class _Both:
    def __init__(self, *notifiers): self.notifiers = notifiers
    def send(self, opportunity):
        for notifier in self.notifiers: notifier.send(opportunity)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Trova opportunità di lusso profittevoli")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo"); demo.add_argument("--notify", default="console", choices=("console", "telegram", "webhook", "both-telegram", "both"))
    run = sub.add_parser("run"); run.add_argument("file"); run.add_argument("--notify", default=os.getenv("NOTIFICATION_MODE", "console"), choices=("console", "telegram", "webhook", "both-telegram", "both"))
    sub.add_parser("scheduler"); sub.add_parser("web")
    args = parser.parse_args()
    if args.command == "web":
        import uvicorn
        uvicorn.run("luxury_opportunity_bot.web:app", host=os.getenv("WEB_HOST", "127.0.0.1"), port=int(os.getenv("WEB_PORT", "8000")))
        return 0
    if args.command == "scheduler":
        from .web import scheduler, scrape_and_notify
        from apscheduler.schedulers.blocking import BlockingScheduler
        blocking = BlockingScheduler(); blocking.add_job(scrape_and_notify, "interval", minutes=max(1, int(os.getenv("SCRAPE_INTERVAL_MINUTES", "60"))), next_run_time=None); print("Scheduler attivo; CTRL+C per uscire."); blocking.start(); return 0
    path = "examples/opportunities.json" if args.command == "demo" else args.file
    try:
        opportunities = load_opportunities(path)
        brands = {b.strip().lower() for b in os.getenv("ALLOWED_BRANDS", "").split(",") if b.strip()}
        selected = eligible(opportunities, float(os.getenv("MIN_PROFIT", "100")), float(os.getenv("MIN_ROI_PERCENT", "20")), brands)
        print(f"{notify(selected, _notifier(args.notify))} opportunità idonee su {len(opportunities)} analizzate.")
        return 0
    except (OSError, ValueError) as exc:
        print(f"Errore: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
