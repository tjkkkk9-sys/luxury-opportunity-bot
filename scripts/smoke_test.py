#!/usr/bin/env python3
"""Basic integration checks for a running local API.

Usage: BASE_URL=http://localhost:8000 ADMIN_USERNAME=admin ADMIN_PASSWORD=... python scripts/smoke_test.py
"""
from __future__ import annotations

import os
import sys

import requests


base = os.getenv("BASE_URL", "http://localhost:8000").rstrip("/")
username = os.getenv("ADMIN_USERNAME", "admin")
password = os.getenv("ADMIN_PASSWORD", "")

health = requests.get(f"{base}/health", timeout=10)
health.raise_for_status()
assert health.json().get("status") == "ok"

if not password:
    print("OK: health. Imposta ADMIN_PASSWORD per completare i test autenticati.")
    raise SystemExit(0)

token_response = requests.post(
    f"{base}/api/auth/token",
    data={"username": username, "password": password},
    timeout=10,
)
token_response.raise_for_status()
token = token_response.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

for path in ("/api/auth/me", "/api/opportunities", "/api/opportunities/export"):
    response = requests.get(f"{base}{path}", headers=headers, timeout=10)
    response.raise_for_status()

print("OK: health, login JWT, profilo, opportunità ed export CSV")
