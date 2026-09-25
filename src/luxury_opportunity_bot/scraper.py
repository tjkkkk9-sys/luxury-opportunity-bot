from __future__ import annotations

import re
from dataclasses import dataclass

import requests
from bs4 import BeautifulSoup

from .domain import Opportunity, ValidationError


@dataclass(frozen=True, slots=True)
class MarketplaceSelectors:
    item: str = "article, .product, .listing, [data-product]"
    title: str = "[data-title], .title, .product-title, h2, h3"
    brand: str = "[data-brand], .brand, .product-brand"
    price: str = "[data-price], .price, .product-price"
    url: str = "a[href]"


class MarketplaceScraper:
    """Scraper generico configurabile per pagine HTML pubbliche.

    Va usato solo su marketplace che consentono l'accesso automatico e nel rispetto
    di robots.txt, termini di servizio, rate limit e autenticazione richiesta.
    """

    def __init__(self, selectors: MarketplaceSelectors | None = None, timeout: int = 15):
        self.selectors, self.timeout = selectors or MarketplaceSelectors(), timeout

    def fetch(self, url: str, source: str = "marketplace") -> list[Opportunity]:
        response = requests.get(url, timeout=self.timeout, headers={"User-Agent": "luxury-opportunity-bot/0.2"})
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results: list[Opportunity] = []
        for node in soup.select(self.selectors.item):
            title = self._text(node, self.selectors.title)
            brand = self._text(node, self.selectors.brand) or "Unknown"
            price_text = self._text(node, self.selectors.price)
            link = node.select_one(self.selectors.url)
            if not title or not price_text or not link or not link.get("href"):
                continue
            try:
                price = self._price(price_text)
                results.append(Opportunity.from_dict({
                    "title": title, "brand": brand, "url": link["href"],
                    "purchase_price": price, "estimated_sale_price": price,
                    "source": source,
                }))
            except ValidationError:
                continue
        return results

    @staticmethod
    def _text(node, selector: str) -> str:
        found = node.select_one(selector)
        return found.get_text(" ", strip=True) if found else ""

    @staticmethod
    def _price(value: str) -> Decimal:
        from decimal import Decimal
        cleaned = re.sub(r"[^0-9,.-]", "", value).replace(".", "").replace(",", ".")
        return Decimal(cleaned)
