# Enterprise: PostgreSQL + JWT + admin + filtri avanzati

## Avvio

```bash
cp .env.example .env
# cambia JWT_SECRET, ADMIN_PASSWORD e password Postgres
# allinea DATABASE_URL alla password configurata in docker-compose.yml
make up
make ps
```

- Dashboard: http://localhost:8000
- OpenAPI: http://localhost:8000/docs
- Health: http://localhost:8000/health

Il primo avvio crea l'utente admin definito da `ADMIN_USERNAME` e `ADMIN_PASSWORD`.

## Verifica PostgreSQL

```bash
make ps
make db-shell
# dentro psql:
\\dt
SELECT * FROM opportunities LIMIT 10;
```

Oppure, senza entrare nella shell:

```bash
docker compose exec db psql -U luxury -d luxury -c '\\dt'
docker compose exec db psql -U luxury -d luxury -c 'SELECT * FROM opportunities LIMIT 10;'
```

## Smoke test

```bash
ADMIN_PASSWORD='la-password-del-tuo-.env' make smoke
```

Il test verifica health, login JWT, `/api/auth/me`, lista opportunità ed export CSV. Telegram viene verificato dalla pipeline: configura token/chat e usa il pulsante admin oppure `make logs` per controllare il worker.

## Comandi Make

- `make up`, `make down`, `make ps`, `make logs`
- `make db-shell`, `make test`, `make lint`, `make smoke`

## Produzione

Usa password casuali, secret manager, HTTPS/reverse proxy, CORS ristretto e backup PostgreSQL. Prima di esporre il servizio aggiungi rate limiting e audit log; non committare `.env`. Lo scraping deve rispettare termini di servizio, robots.txt e rate limit.
