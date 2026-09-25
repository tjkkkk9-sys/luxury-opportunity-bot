# Luxury Opportunity Bot

Bot per trovare prodotti di lusso in asta o sconto, calcolare margini e inviare segnalazioni con link e dettagli.

## Configurazione locale con Docker

### Requisiti

- Docker
- Docker Compose
- make
- Python 3.11 (solo se vuoi eseguire test locali senza usare Docker)

### 1) Clona il repository e apri la cartella

```bash
git clone https://github.com/tjkkkk9-sys/luxury-opportunity-bot.git
cd luxury-opportunity-bot
```

### 2) Crea il file di ambiente

```bash
cp .env.example .env
```

Quindi aggiorna i valori principali nel file `.env`:

```dotenv
JWT_SECRET=change-this-to-a-long-random-secret-min-32-chars
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
DATABASE_URL=postgresql+psycopg://luxury:change-me@db:5432/luxury
```

Per un setup locale rapido puoi usare valori di esempio, ma in produzione usa password e secret casuali.

### 3) Avvia i servizi

```bash
make up
make ps
```

Questo avvia:
- PostgreSQL su `localhost:5432`
- API FastAPI su `http://localhost:8000`
- worker scheduler in background

### 4) Verifica che il servizio sia attivo

Apri nel browser:

- Dashboard: http://localhost:8000
- OpenAPI: http://localhost:8000/docs
- Health: http://localhost:8000/health

Oppure verifica via terminale:

```bash
curl http://localhost:8000/health
```

Il risultato atteso è:

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

L'API risponderà con un JSON contenente `access_token` e `token_type`.

### 6) Smoke test

Dopo aver avviato il servizio e impostato la password corretta nel file `.env`, esegui:

```bash
ADMIN_PASSWORD='change-this-password' make smoke
```

Questo verifica:
- health check
- login JWT
- endpoint profilo utente
- lista opportunità
- export CSV

### 7) Comandi utili

```bash
make logs
make down
make db-shell
make test
make lint
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

## Verifica PostgreSQL

```bash
make ps
make db-shell
# dentro psql:
\dt
SELECT * FROM opportunities LIMIT 10;
```

Oppure:

```bash
docker compose exec db psql -U luxury -d luxury -c '\dt'
docker compose exec db psql -U luxury -d luxury -c 'SELECT * FROM opportunities LIMIT 10;'
```

## Smoke test

```bash
ADMIN_PASSWORD='la-password-del-tuo-.env' make smoke
```

Il test verifica health, login JWT, `/api/auth/me`, lista opportunità ed export CSV. Telegram viene verificato dalla pipeline: configura token/chat e usa il pulsante admin oppure `make logs` per controllare l'esecuzione.

## Comandi Make

- `make up`, `make down`, `make ps`, `make logs`
- `make db-shell`, `make test`, `make lint`, `make smoke`

## Produzione

Usa password casuali, secret manager, HTTPS/reverse proxy, CORS ristretto e backup PostgreSQL. Prima di esporre il servizio aggiungi rate limiting e audit log; non committare `.env`. Lo scraping dei siti deve essere limitato e monitorato, così da evitare blocchi o richieste abusive.
