"""Notifiche Telegram sul telefono (facoltative: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)."""
from __future__ import annotations

import os
import re

import requests


def esc(text) -> str:
    """Escape per parse_mode HTML: va applicato a ogni testo variabile (simboli, errori, motivi)."""
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def telegram(text: str) -> bool:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        r = requests.post(url, json={"chat_id": chat, "text": text, "parse_mode": "HTML",
                                     "disable_web_page_preview": True}, timeout=15)
        if r.status_code == 400:  # HTML rifiutato: reinvia in testo semplice
            plain = re.sub(r"<[^>]+>", "", text).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
            r = requests.post(url, json={"chat_id": chat, "text": plain, "disable_web_page_preview": True}, timeout=15)
        return r.ok
    except requests.RequestException:
        return False
