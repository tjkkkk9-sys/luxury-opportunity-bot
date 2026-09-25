from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select

from .storage import UserRecord, make_session_factory

ALGORITHM = "HS256"
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


def _secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET deve contenere almeno 32 caratteri")
    return secret


def hash_password(password: str) -> str:
    if len(password) < 12:
        raise ValueError("La password deve contenere almeno 12 caratteri")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, iterations, salt_hex, digest_hex = encoded.split("$")
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations))
        return scheme == "pbkdf2_sha256" and hmac.compare_digest(actual.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def create_token(user: UserRecord) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "iat": now,
        "exp": now + timedelta(minutes=int(os.getenv("JWT_EXPIRE_MINUTES", "60"))),
    }
    return jwt.encode(payload, _secret(), algorithm=ALGORITHM)


def current_user(token: str = Depends(oauth2_scheme)) -> UserRecord:
    credentials = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token non valido",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError, RuntimeError) as exc:
        raise credentials from exc

    factory = make_session_factory()
    with factory() as session:
        user = session.get(UserRecord, user_id)
        if not user or not user.active:
            raise credentials
        return user


def admin_required(user: UserRecord = Depends(current_user)) -> UserRecord:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Permessi admin richiesti")
    return user
