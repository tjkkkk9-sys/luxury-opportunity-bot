from __future__ import annotations

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
        text = format_opportunity(opportunity)
        response = requests.post(self.url, json={"content": text}, timeout=self.timeout)
        response.raise_for_status()


class TelegramNotifier:
    """Invia notifiche usando la Bot API ufficiale di Telegram."""

    def __init__(self, token: str, chat_id: str, timeout: int = 10) -> None:
        if not token or not chat_id:
            raise ValueError("TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID sono obbligatori")
        self.endpoint = f"https://api.telegram.org/bot{token}/sendMessage"
        self.chat_id, self.timeout = chat_id, timeout

    def send(self, opportunity: Opportunity) -> None:
        response = requests.post(
            self.endpoint,
            json={"chat_id": self.chat_id, "text": format_opportunity(opportunity), "disable_web_page_preview": False},
            timeout=self.timeout,
        )
        response.raise_for_status()


def format_opportunity(opportunity: Opportunity) -> str:
    return (f"💎 {opportunity.brand} — {opportunity.title}\n"
            f"Profitto netto: {opportunity.net_profit:.2f} {opportunity.currency}\n"
            f"ROI: {opportunity.roi_percent:.2f}%\n"
            f"Prezzo acquisto: {opportunity.purchase_price:.2f} {opportunity.currency}\n"
            f"Fonte: {opportunity.source}\n{opportunity.url}")


def notify(opportunities: list[Opportunity], notifier: Notifier) -> int:
    for opportunity in opportunities:
        notifier.send(opportunity)
    return len(opportunities)
