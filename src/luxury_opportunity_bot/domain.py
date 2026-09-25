from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation


class ValidationError(ValueError):
    """Raised when an opportunity contains invalid data."""


def _money(value: object, field: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValidationError(f"{field} deve essere un numero") from exc
    if result < 0:
        raise ValidationError(f"{field} non può essere negativo")
    return result.quantize(Decimal("0.01"))


@dataclass(frozen=True, slots=True)
class Opportunity:
    title: str
    brand: str
    url: str
    purchase_price: Decimal
    estimated_sale_price: Decimal
    shipping_cost: Decimal = Decimal("0")
    platform_fee_percent: Decimal = Decimal("0")
    tax_percent: Decimal = Decimal("0")
    source: str = "unknown"
    currency: str = "EUR"

    @classmethod
    def from_dict(cls, data: dict) -> "Opportunity":
        required = ("title", "brand", "url", "purchase_price", "estimated_sale_price")
        missing = [name for name in required if not str(data.get(name, "")).strip()]
        if missing:
            raise ValidationError(f"campi mancanti: {', '.join(missing)}")
        fee = _money(data.get("platform_fee_percent", 0), "platform_fee_percent")
        tax = _money(data.get("tax_percent", 0), "tax_percent")
        if fee > 100 or tax > 100:
            raise ValidationError("le percentuali devono essere comprese tra 0 e 100")
        return cls(
            title=str(data["title"]).strip(), brand=str(data["brand"]).strip(),
            url=str(data["url"]).strip(), purchase_price=_money(data["purchase_price"], "purchase_price"),
            estimated_sale_price=_money(data["estimated_sale_price"], "estimated_sale_price"),
            shipping_cost=_money(data.get("shipping_cost", 0), "shipping_cost"),
            platform_fee_percent=fee, tax_percent=tax,
            source=str(data.get("source", "unknown")).strip(),
            currency=str(data.get("currency", "EUR")).strip().upper(),
        )

    @property
    def platform_fee(self) -> Decimal:
        return (self.estimated_sale_price * self.platform_fee_percent / 100).quantize(Decimal("0.01"))

    @property
    def tax(self) -> Decimal:
        return (self.estimated_sale_price * self.tax_percent / 100).quantize(Decimal("0.01"))

    @property
    def total_cost(self) -> Decimal:
        return self.purchase_price + self.shipping_cost + self.platform_fee + self.tax

    @property
    def net_profit(self) -> Decimal:
        return (self.estimated_sale_price - self.total_cost).quantize(Decimal("0.01"))

    @property
    def roi_percent(self) -> Decimal:
        if self.total_cost == 0:
            return Decimal("0")
        return (self.net_profit / self.total_cost * 100).quantize(Decimal("0.01"))
