from __future__ import annotations

import csv
import io
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import select

from .auth import admin_required, create_token, current_user, hash_password, verify_password
from .pipeline import run_pipeline
from .storage import UserRecord, count_opportunities, ensure_admin, list_opportunities, make_session_factory

factory = make_session_factory()
ensure_admin(factory)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Luxury Opportunity Enterprise API", version="0.4.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:8000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=12)
    role: str = Field(default="viewer", pattern="^(viewer|admin)$")


def serialize(row):
    item = row.as_opportunity()
    return {
        "id": row.id,
        "title": row.title,
        "brand": row.brand,
        "url": row.url,
        "source": row.source,
        "currency": row.currency,
        "purchase_price": float(item.purchase_price),
        "sale_price": float(item.estimated_sale_price),
        "profit": float(item.net_profit),
        "roi": float(item.roi_percent),
        "created_at": row.created_at.isoformat(),
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/token")
def login(form: OAuth2PasswordRequestForm = Depends()):
    with factory() as session:
        user = session.scalar(select(UserRecord).where(UserRecord.username == form.username))
    if not user or not user.active or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Credenziali non valide")
    return {
        "access_token": create_token(user),
        "token_type": "bearer",
        "expires_in": int(os.getenv("JWT_EXPIRE_MINUTES", "60")) * 60,
    }


@app.get("/api/auth/me")
def me(user: UserRecord = Depends(current_user)):
    return {"id": user.id, "username": user.username, "role": user.role}


@app.get("/api/opportunities")
def opportunities(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    brand: str | None = None,
    source: str | None = None,
    min_profit: float = Query(0, ge=0),
    min_roi: float = Query(0, ge=0),
    _user: UserRecord = Depends(current_user),
):
    rows = list_opportunities(factory, limit, offset, brand, source, min_profit, min_roi)
    return {
        "items": [serialize(row) for row in rows],
        "total": count_opportunities(factory),
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/opportunities/export")
def export_csv(
    brand: str | None = None,
    source: str | None = None,
    min_profit: float = 0,
    min_roi: float = 0,
    _user: UserRecord = Depends(current_user),
):
    rows = list_opportunities(factory, 5000, 0, brand, source, min_profit, min_roi)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=["id", "title", "brand", "url", "source", "purchase_price", "sale_price", "profit", "roi"])
    writer.writeheader()
    for row in rows:
        writer.writerow({key: value for key, value in serialize(row).items() if key in writer.fieldnames})
    buffer.seek(0)
    return StreamingResponse(iter([buffer.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=opportunities.csv"})


@app.post("/api/pipeline/run")
def pipeline_run(_admin: UserRecord = Depends(admin_required)):
    return {"saved": run_pipeline(factory)}


@app.post("/api/admin/users", status_code=201)
def create_user(data: UserCreate, _admin: UserRecord = Depends(admin_required)):
    with factory.begin() as session:
        existing = session.scalar(select(UserRecord).where(UserRecord.username == data.username))
        if existing:
            raise HTTPException(status_code=409, detail="Username già esistente")
        session.add(UserRecord(username=data.username, password_hash=hash_password(data.password), role=data.role))
    return {"username": data.username, "role": data.role}


@app.get("/", response_class=HTMLResponse)
def dashboard():
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html"), encoding="utf-8") as stream:
        return stream.read()
