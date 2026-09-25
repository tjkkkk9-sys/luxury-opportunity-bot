from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable

from sqlalchemy import DateTime, Numeric, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .domain import Opportunity


class Base(DeclarativeBase):
    pass


class OpportunityRecord(Base):
    __tablename__ = "opportunities"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    brand: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(String(1000), unique=True, index=True)
    purchase_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    estimated_sale_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    shipping_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    platform_fee_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    tax_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    source: Mapped[str] = mapped_column(String(120), default="unknown")
    currency: Mapped[str] = mapped_column(String(3), default="EUR")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


def make_session_factory(database_url: str | None = None):
    engine = create_engine(database_url or os.getenv("DATABASE_URL", "sqlite:///luxury_opportunities.db"))
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def save_opportunities(factory, opportunities: Iterable[Opportunity]) -> int:
    saved = 0
    with factory.begin() as session:
        for item in opportunities:
            exists = session.scalar(select(OpportunityRecord).where(OpportunityRecord.url == item.url))
            if exists:
                continue
            session.add(OpportunityRecord(**{field: getattr(item, field) for field in (
                "title", "brand", "url", "purchase_price", "estimated_sale_price",
                "shipping_cost", "platform_fee_percent", "tax_percent", "source", "currency")}))
            saved += 1
    return saved


def list_opportunities(factory, limit: int = 100) -> list[OpportunityRecord]:
    with factory() as session:
        return list(session.scalars(select(OpportunityRecord).order_by(OpportunityRecord.created_at.desc()).limit(limit)))
