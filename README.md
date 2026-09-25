# Backend Postgres + dashboard + pipeline Telegram

## Avvio locale

```bash
cp .env.example .env
# avvia PostgreSQL: docker compose up -d db
pip install -e ".[dev]"
python -m luxury_opportunity_bot web       # API/dashboard su :8000
python -m luxury_opportunity_bot scheduler # scraping immediato + ogni X minuti
```

Imposta `DATABASE_URL=postgresql+psycopg://luxury:luxury@localhost:5432/luxury`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SCRAPE_URLS` e `SCRAPE_INTERVAL_MINUTES`. Il worker salva le opportunità nuove e invia una sola notifica Telegram per ciascuna opportunità idonea.

## API

- `GET /health`
- `GET /api/opportunities?brand=Rolex&source=...&min_profit=100&min_roi=20&limit=50&offset=0`
- `POST /api/pipeline/run` per una scansione manuale

La dashboard è una UI responsive con tabella, filtri brand/fonte/profitto/ROI e link al marketplace. `docker compose up --build` avvia database, backend e worker.

## Configurazione sicurezza

Non committare `.env`. In produzione usa una password Postgres forte, secret manager, autenticazione per le API, CORS ristretto e HTTPS. Lo scraper deve rispettare termini di servizio, robots.txt e rate limit del marketplace; non implementa bypass di CAPTCHA o accessi autenticati.
