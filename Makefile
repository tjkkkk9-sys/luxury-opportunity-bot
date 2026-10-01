SHELL := /bin/sh

.DEFAULT_GOAL := check

.PHONY: install up down logs ps db-shell api-shell test lint smoke check distcheck

install:
	python -m pip install --upgrade pip
	python -m pip install -e ".[dev]"

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

db-shell:
	docker compose exec db psql -U luxury -d luxury

api-shell:
	docker compose exec api sh

test:
	pytest

lint:
	ruff check .

smoke:
	python scripts/smoke_test.py

check: lint test

distcheck:
	python -m compileall src
