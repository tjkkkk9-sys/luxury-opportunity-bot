from __future__ import annotations

import os
from contextlib import asynccontextmanager
from decimal import Decimal

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .pipeline import run_pipeline
from .storage import list_opportunities, make_session_factory

factory = make_session_factory()

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

app = FastAPI(title="Luxury Opportunity API", version="0.3.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


def serialize(row):
    item = row.as_opportunity()
    return {"id": row.id, "title": row.title, "brand": row.brand, "url": row.url, "source": row.source,
            "currency": row.currency, "purchase_price": float(item.purchase_price), "sale_price": float(item.estimated_sale_price),
            "profit": float(item.net_profit), "roi": float(item.roi_percent), "created_at": row.created_at.isoformat()}

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/api/opportunities")
def opportunities(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
                    brand: str | None = None, source: str | None = None, min_profit: float = 0, min_roi: float = 0):
    rows = list_opportunities(factory, limit, offset, brand, source)
    return [item for item in map(serialize, rows) if item["profit"] >= min_profit and item["roi"] >= min_roi]

@app.post("/api/pipeline/run")
def pipeline_run(): return {"saved": run_pipeline(factory)}

@app.get("/", response_class=HTMLResponse)
def dashboard():
    return open(os.path.join(os.path.dirname(__file__), "static", "index.html"), encoding="utf-8").read()
