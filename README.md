# Enterprise: PostgreSQL + JWT + admin + filtri avanzati

## Avvio

```bash
cp .env.example .env
# cambia i secret e le password prima del primo avvio
# allinea anche DATABASE_URL alla stessa password usata nel docker-compose.yml
docker compose up --build
```

- Dashboard: `http://localhost:8000`
- OpenAPI: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

Il primo avvio crea l'utente admin definito da `ADMIN_USERNAME` e `ADMIN_PASSWORD`. Il login usa JWT Bearer; l'endpoint token è disponibile tramite `POST /api/auth/token` e le API protette richiedono un token valido.

## Funzioni enterprise

- PostgreSQL con indici su brand, source, URL e data.
- API protetta: `/api/opportunities`, `/api/opportunities/export`, `/api/auth/me` richiedono JWT.
- Ruoli `admin` e `viewer`; solo admin può creare utenti e avviare la pipeline manualmente.
- Dashboard responsive con login, filtri brand/fonte/profitto/ROI, paginazione ed export CSV.
- Worker separato: scraping immediato all'avvio, poi alert Telegram ogni `SCRAPE_INTERVAL_MINUTES`; una opportunità viene notificata una sola volta tramite `notified_at`.

## Sicurezza prima della produzione

Usa secret manager, password casuali, HTTPS, `CORS_ORIGINS` ristretto e reverse proxy. Per deployment con più repliche aggiungere migrazioni Alembic e un lock distribuito per lo scheduler. Non committare `.env`; lo scraping deve rispettare termini, robots.txt e rate limit del marketplace.
