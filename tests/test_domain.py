from decimal import Decimal

from luxury_opportunity_bot.domain import Opportunity
from luxury_opportunity_bot.io import eligible


def test_profit_and_roi():
    item = Opportunity.from_dict({"title": "x", "brand": "A", "url": "https://x", "purchase_price": 100,
                                 "estimated_sale_price": 200, "shipping_cost": 10,
                                 "platform_fee_percent": 10})
    assert item.total_cost == Decimal("130.00")
    assert item.net_profit == Decimal("70.00")
    assert item.roi_percent == Decimal("53.85")


def test_filters_profit_roi_and_brand():
    item = Opportunity.from_dict({"title": "x", "brand": "A", "url": "https://x", "purchase_price": 100,
                                 "estimated_sale_price": 200})
    assert eligible([item], 50, 90, {"a"}) == []
    assert eligible([item], 50, 90, {"b"}) == []
    assert eligible([item], 50, 90, {"a"}) == [item]
