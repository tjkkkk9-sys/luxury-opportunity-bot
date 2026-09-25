from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

from .io import eligible, load_opportunities
from .notify import ConsoleNotifier, WebhookNotifier, notify


def _notifier(mode: str):
    console = ConsoleNotifier()
    if mode == "console":
        return console
    url = os.getenv("WEBHOOK_URL", "")
    if not url:
        raise ValueError("WEBHOOK_URL è obbligatorio per la modalità webhook")
    webhook = WebhookNotifier(url, int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10")))
    return webhook if mode == "webhook" else _Both(console, webhook)


class _Both:
    def __init__(self, *notifiers): self.notifiers = notifiers
    def send(self, opportunity):
        for notifier in self.notifiers: notifier.send(opportunity)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Trova opportunità di lusso profittevoli")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo")
    demo.add_argument("--notify", default="console", choices=("console", "webhook", "both"))
    run = sub.add_parser("run")
    run.add_argument("file")
    run.add_argument("--notify", default=os.getenv("NOTIFICATION_MODE", "console"), choices=("console", "webhook", "both"))
    args = parser.parse_args()
    path = "examples/opportunities.json" if args.command == "demo" else args.file
    try:
        opportunities = load_opportunities(path)
        brands = {b.strip().lower() for b in os.getenv("ALLOWED_BRANDS", "").split(",") if b.strip()}
        selected = eligible(opportunities, float(os.getenv("MIN_PROFIT", "100")),
                            float(os.getenv("MIN_ROI_PERCENT", "20")), brands)
        count = notify(selected, _notifier(args.notify))
        print(f"{count} opportunità idonee su {len(opportunities)} analizzate.")
        return 0
    except (OSError, ValueError) as exc:
        print(f"Errore: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
