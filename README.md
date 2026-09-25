# Luxury Opportunity Bot

Bot per trovare prodotti di lusso in asta o sconto, calcolare margini e inviare segnalazioni con link e dettagli.

## Setup locale con Docker

### Requisiti

- Docker
- Docker Compose
- make
- Python 3.11 (solo per eseguire test/smoke in locale senza usare i container)

### 1) Clona il repository

```bash
git clone https://github.com/tjkkkk9-sys/luxury-opportunity-bot.git
cd luxury-opportunity-bot
```

### 2) Crea il file di ambiente

```bash
cp .env.example .env
```

Apri `.env` e verifica i valori principali:

```dotenv
PYTHONUNBUFFERED=1
MIN_PROFIT=100
MIN_ROI_PERCENT=20
ALLOWED_BRANDS=
DATABASE_URL=postgresql+psycopg://luxury:change-me@db:5432/luxury
JWT_SECRET=change-this-to-a-long-random-secret-min-32-chars
JWT_EXPIRE_MINUTES=60
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
REQUEST_TIMEOUT_SECONDS=10
SCRAPE_URLS=
SCRAPE_INTERVAL_MINUTES=60
WEB_HOST=127.0.0.1
WEB_PORT=8000
CORS_ORIGINS=http://localhost:8000
```

Nota: in produzione usa password e secret casuali. Non committare `.env`.

### 3) Avvia i servizi

```bash
make up
make ps
```

Questo avvia:
- PostgreSQL su `localhost:5432`
- API FastAPI su `http://localhost:8000`
- worker scheduler in background

### 4) Verifica il sistema

Apri nel browser:

- Dashboard: http://localhost:8000
- OpenAPI: http://localhost:8000/docs
- Health: http://localhost:8000/health

Oppure verifica da terminale:

```bash
curl http://localhost:8000/health
```

Risposta attesa:

```json
{"status":"ok"}
```

### 5) Login amministratore

Il primo avvio crea automaticamente l'utente admin definito da `ADMIN_USERNAME` e `ADMIN_PASSWORD`.

Per ottenere un token JWT:

```bash
curl -X POST http://localhost:8000/api/auth/token \
  -d "username=admin&password=change-this-password"
```

L'API risponderà con un JSON contenente `access_token`, `token_type` e `expires_in`.

### 6) Smoke test

Dopo aver avviato il servizio e impostato la password corretta nel file `.env`, esegui:

```bash
ADMIN_PASSWORD='change-this-password' make smoke
```

Questo verifica:
- health check
- login JWT
- endpoint `/api/auth/me`
- elenco opportunità
- export CSV

### 7) Comandi utili

```bash
make logs
make down
make ps
make db-shell
make test
make lint
make smoke
```

#### Vedere i log

```bash
docker compose logs -f --tail=100
```

#### Aprire il database PostgreSQL

```bash
make db-shell
```

Dentro `psql` puoi verificare le tabelle:

```sql
\dt
SELECT * FROM opportunities LIMIT 10;
```

Oppure senza entrare nel container:

```bash
docker compose exec db psql -U luxury -d luxury -c '\dt'
docker compose exec db psql -U luxury -d luxury -c 'SELECT * FROM opportunities LIMIT 10;'
```

## Struttura del progetto

```text
src/
  luxury_opportunity_bot/
    __init__.py
    auth.py
    pipeline.py
    scheduler.py
    storage.py
    web.py
    static/
scripts/
  smoke_test.py
Dockerfile
docker-compose.yml
Makefile
pyproject.toml
README.md
.env.example
```

## Endpoint principali

- `GET /health`
- `POST /api/auth/token`
- `GET /api/auth/me`
- `GET /api/opportunities`
- `GET /api/opportunities/export`
- `POST /api/pipeline/run`

## Produzione

Prima di esporre il servizio in produzione:

- usa password casuali e secret manager
- configura HTTPS e reverse proxy
- limita CORS a domini fidati
- usa backup PostgreSQL
- aggiungi rate limiting e audit log
- monitora il scraping per evitare blocchi o richieste abusive

## Note

Il repository è pensato per un backend Python con FastAPI, PostgreSQL e un worker di scraping in background. L'API è usata per autenticazione JWT, gestione opportunità e export CSV, mentre il worker elabora i dati e invia notifiche Telegram se configurate.
