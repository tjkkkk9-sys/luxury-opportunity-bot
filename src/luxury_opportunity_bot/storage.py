from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable

from sqlalchemy import DateTime, Numeric, String, create_engine, or_, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .domain import Opportunity


class Base(DeclarativeBase):
    pass


class OpportunityRecord(Base):
    __tablename__ = "opportunities"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    brand: Mapped[str] = mapped_column(String(120), index=True)
    url: Mapped[str] = mapped_column(String(1000), unique=True, index=True)
    purchase_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    estimated_sale_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    shipping_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    platform_fee_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    tax_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    source: Mapped[str] = mapped_column(String(120), default="unknown", index=True)
    currency: Mapped[str] = mapped_column(String(3), default="EUR")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def as_opportunity(self) -> Opportunity:
        return Opportunity(title=self.title, brand=self.brand, url=self.url,
            purchase_price=Decimal(self.purchase_price), estimated_sale_price=Decimal(self.estimated_sale_price),
            shipping_cost=Decimal(self.shipping_cost or 0), platform_fee_percent=Decimal(self.platform_fee_percent or 0),
            tax_percent=Decimal(self.tax_percent or 0), source=self.source, currency=self.currency)


def make_session_factory(database_url: str | None = None):
    engine = create_engine(database_url or os.getenv("DATABASE_URL", "sqlite:///luxury_opportunities.db"), pool_pre_ping=True)
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def save_opportunities(factory, opportunities: Iterable[Opportunity]) -> int:
    saved = 0
    with factory.begin() as session:
        for item in opportunities:
            if session.scalar(select(OpportunityRecord).where(OpportunityRecord.url == item.url)):
                continue
            session.add(OpportunityRecord(**{field: getattr(item, field) for field in (
                "title", "brand", "url", "purchase_price", "estimated_sale_price", "shipping_cost",
                "platform_fee_percent", "tax_percent", "source", "currency")}))
            saved += 1
    return saved


def list_opportunities(factory, limit=100, offset=0, brand=None, source=None):
    with factory() as session:
        query = select(OpportunityRecord)
        if brand: query = query.where(OpportunityRecord.brand.ilike(f"%{brand}%"))
        if source: query = query.where(OpportunityRecord.source == source)
        return list(session.scalars(query.order_by(OpportunityRecord.created_at.desc()).offset(offset).limit(limit)))


def claim_unnotified(factory, min_profit: float, min_roi: float, limit=100):
    with factory.begin() as session:
        rows = list(session.scalars(select(OpportunityRecord).where(OpportunityRecord.notified_at.is_(None)).limit(limit)))
        selected = [row for row in rows if row.as_opportunity().net_profit >= Decimal(str(min_profit)) and row.as_opportunity().roi_percent >= Decimal(str(min_roi))]
        now = datetime.now(timezone.utc)
        for row in selected: row.notified_at = now
        return [row.as_opportunity() for row in selected]
