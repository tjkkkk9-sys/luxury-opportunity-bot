from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable

from sqlalchemy import Boolean, DateTime, Numeric, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .domain import Opportunity


class Base(DeclarativeBase):
    pass


class UserRecord(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    role: Mapped[str] = mapped_column(String(30), default="viewer")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


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
        return Opportunity(
            title=self.title,
            brand=self.brand,
            url=self.url,
            purchase_price=Decimal(self.purchase_price),
            estimated_sale_price=Decimal(self.estimated_sale_price),
            shipping_cost=Decimal(self.shipping_cost or 0),
            platform_fee_percent=Decimal(self.platform_fee_percent or 0),
            tax_percent=Decimal(self.tax_percent or 0),
            source=self.source,
            currency=self.currency,
        )


def make_session_factory(database_url: str | None = None):
    engine = create_engine(database_url or os.getenv("DATABASE_URL", "sqlite:///luxury_opportunities.db"), pool_pre_ping=True)
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def ensure_admin(factory=None):
    from .auth import hash_password

    username = os.getenv("ADMIN_USERNAME", "")
    password = os.getenv("ADMIN_PASSWORD", "")
    if not username or not password:
        return
    factory = factory or make_session_factory()
    with factory.begin() as session:
        user = session.scalar(select(UserRecord).where(UserRecord.username == username))
        if user is None:
            session.add(UserRecord(username=username, password_hash=hash_password(password), role="admin"))


def save_opportunities(factory, opportunities: Iterable[Opportunity]) -> int:
    saved = 0
    with factory.begin() as session:
        for item in opportunities:
            exists = session.scalar(select(OpportunityRecord).where(OpportunityRecord.url == item.url))
            if exists:
                continue
            session.add(
                OpportunityRecord(
                    title=item.title,
                    brand=item.brand,
                    url=item.url,
                    purchase_price=item.purchase_price,
                    estimated_sale_price=item.estimated_sale_price,
                    shipping_cost=item.shipping_cost,
                    platform_fee_percent=item.platform_fee_percent,
                    tax_percent=item.tax_percent,
                    source=item.source,
                    currency=item.currency,
                )
            )
            saved += 1
    return saved


def list_opportunities(factory, limit: int = 100, offset: int = 0, brand: str | None = None,
                      source: str | None = None, min_profit: float = 0, min_roi: float = 0):
    with factory() as session:
        rows = session.scalars(
            select(OpportunityRecord).order_by(OpportunityRecord.created_at.desc()).offset(offset).limit(limit)
        ).all()
        filtered = []
        for row in rows:
            item = row.as_opportunity()
            if brand and brand.lower() not in row.brand.lower():
                continue
            if source and row.source != source:
                continue
            if item.net_profit < Decimal(str(min_profit)):
                continue
            if item.roi_percent < Decimal(str(min_roi)):
                continue
            filtered.append(row)
        return filtered


def count_opportunities(factory) -> int:
    with factory() as session:
        return session.scalar(select(func.count()).select_from(OpportunityRecord)) or 0


def claim_unnotified(factory, min_profit: float, min_roi: float, limit: int = 100):
    with factory.begin() as session:
        rows = session.scalars(
            select(OpportunityRecord).where(OpportunityRecord.notified_at.is_(None)).limit(limit)
        ).all()
        selected = []
        now = datetime.now(timezone.utc)
        for row in rows:
            item = row.as_opportunity()
            if item.net_profit >= Decimal(str(min_profit)) and item.roi_percent >= Decimal(str(min_roi)):
                row.notified_at = now
                selected.append(item)
        return selected
