from __future__ import annotations

import json
from typing import Protocol

import requests

from .domain import Opportunity


class Notifier(Protocol):
    def send(self, opportunity: Opportunity) -> None: ...


class ConsoleNotifier:
    def send(self, opportunity: Opportunity) -> None:
        print(f"✅ {opportunity.brand} — {opportunity.title}")
        print(f"   Profitto: {opportunity.net_profit:.2f} {opportunity.currency} | ROI: {opportunity.roi_percent:.2f}%")
        print(f"   {opportunity.url}")


class WebhookNotifier:
    def __init__(self, url: str, timeout: int = 10) -> None:
        self.url, self.timeout = url, timeout

    def send(self, opportunity: Opportunity) -> None:
        payload = {"content": (f"**{opportunity.brand} — {opportunity.title}**\\n"
                    f"Profitto: {opportunity.net_profit:.2f} {opportunity.currency} | "
                    f"ROI: {opportunity.roi_percent:.2f}%\\n{opportunity.url}")}
        response = requests.post(self.url, json=payload, timeout=self.timeout)
        response.raise_for_status()


def notify(opportunities: list[Opportunity], notifier: Notifier) -> int:
    for opportunity in opportunities:
        notifier.send(opportunity)
    return len(opportunities)
