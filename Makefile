SHELL := /bin/sh

.PHONY: up down logs ps db-shell api-shell test lint smoke

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
