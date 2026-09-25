from __future__ import annotations

import argparse
import os
import sys
from dotenv import load_dotenv
from .io import eligible, load_opportunities
from .notify import ConsoleNotifier, TelegramNotifier, WebhookNotifier, notify


def notifier(mode):
    timeout = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))
    if mode == "console": return ConsoleNotifier()
    if mode == "telegram": return TelegramNotifier(os.getenv("TELEGRAM_BOT_TOKEN", ""), os.getenv("TELEGRAM_CHAT_ID", ""), timeout)
    if mode == "webhook": return WebhookNotifier(os.getenv("WEBHOOK_URL", ""), timeout)
    return _Both(notifier("console"), notifier("telegram" if mode == "both-telegram" else "webhook"))

class _Both:
    def __init__(self, *items): self.items = items
    def send(self, opportunity):
        for item in self.items: item.send(opportunity)

def main():
    load_dotenv(); parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="command", required=True)
    for name in ("demo", "web", "scheduler"): sub.add_parser(name)
    run = sub.add_parser("run"); run.add_argument("file"); run.add_argument("--notify", default=os.getenv("NOTIFICATION_MODE", "console"), choices=("console", "telegram", "webhook", "both-telegram", "both"))
    args = parser.parse_args()
    try:
        if args.command == "web":
            import uvicorn; uvicorn.run("luxury_opportunity_bot.web:app", host=os.getenv("WEB_HOST", "127.0.0.1"), port=int(os.getenv("WEB_PORT", "8000"))); return 0
        from .storage import make_session_factory
        factory = make_session_factory()
        if args.command == "scheduler":
            from .pipeline import run_scheduler; run_scheduler(factory); return 0
        path = "examples/opportunities.json" if args.command == "demo" else args.file
        items = load_opportunities(path); selected = eligible(items, float(os.getenv("MIN_PROFIT", "100")), float(os.getenv("MIN_ROI_PERCENT", "20")))
        print(f"{notify(selected, notifier('console' if args.command == 'demo' else args.notify))} opportunità idonee su {len(items)} analizzate."); return 0
    except (OSError, ValueError) as exc: print(f"Errore: {exc}", file=sys.stderr); return 2

if __name__ == "__main__": raise SystemExit(main())
