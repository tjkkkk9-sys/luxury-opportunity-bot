# Luxury Opportunity Bot

Bot Python per raccogliere opportunità di prodotti di lusso, calcolare margini/ROI, salvarle in SQLite, inviare alert Telegram e visualizzarle in una dashboard web.

## Installazione

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

## Comandi

```bash
python -m luxury_opportunity_bot demo
python -m luxury_opportunity_bot run examples/opportunities.json --notify telegram
python -m luxury_opportunity_bot web       # dashboard: http://127.0.0.1:8000
python -m luxury_opportunity_bot scheduler
pytest
```

## Telegram

Crea un bot con BotFather, inserisci `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` nel file `.env`, poi usa `--notify telegram`. Non committare mai il file `.env`.

## Scraping marketplace

Imposta `SCRAPE_URLS` con URL pubblici separati da virgola. Lo scraper usa selettori CSS configurabili in `scraper.py` e salva i risultati in SQLite evitando duplicati per URL. Usalo solo quando consentito dai termini del marketplace e da robots.txt, rispettando rate limit e privacy: non include bypass di login, CAPTCHA o restrizioni.

## Database e scheduler

Il database predefinito è `luxury_opportunities.db`; può essere cambiato con `DATABASE_URL` (anche PostgreSQL tramite il relativo driver). `SCRAPE_INTERVAL_MINUTES` controlla la frequenza. Il comando `scheduler` esegue la scansione periodica; la dashboard espone anche `GET /api/opportunities`.

## Configurazione

Le soglie sono `MIN_PROFIT` e `MIN_ROI_PERCENT`. Per gli alert di scansione automatica sono necessari token e chat Telegram. Per sicurezza la dashboard è pensata per uso locale: aggiungere autenticazione e HTTPS prima di esporla pubblicamente.
