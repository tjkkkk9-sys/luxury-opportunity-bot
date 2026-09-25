# Luxury Opportunity Bot

Bot modulare in Python per raccogliere opportunità di prodotti di lusso, calcolare costi e margini e inviare segnalazioni.

## Funzionalità

- Importazione di opportunità da JSON o CSV.
- Calcolo del costo totale, profitto netto e ROI.
- Filtri per margine minimo, ROI minimo e brand consentiti.
- Notifiche su console e, opzionalmente, webhook Discord/Slack compatibili.
- Configurazione tramite variabili d'ambiente o file `.env`.
- Modalità `demo` per verificare il progetto senza credenziali esterne.

## Requisiti

- Python 3.11+
- `pip` oppure `uv`

## Installazione

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\\Scripts\\activate
pip install -e ".[dev]"
cp .env.example .env
```

## Avvio rapido

```bash
python -m luxury_opportunity_bot demo
python -m luxury_opportunity_bot run examples/opportunities.json
python -m luxury_opportunity_bot run examples/opportunities.csv --notify console
```

Il comando `run` restituisce un codice diverso da zero se il file di input non è valido o non contiene opportunità idonee.

## Formato dati

Campi obbligatori: `title`, `brand`, `url`, `purchase_price`, `estimated_sale_price`.
Campi opzionali: `shipping_cost`, `platform_fee_percent`, `tax_percent`, `source`, `currency`.

```json
[
  {
    "title": "Borsa esempio",
    "brand": "Brand Demo",
    "url": "https://example.com/item/1",
    "purchase_price": 1000,
    "estimated_sale_price": 1600,
    "shipping_cost": 25,
    "platform_fee_percent": 12,
    "tax_percent": 0,
    "source": "demo"
  }
]
```

## Configurazione

Vedi `.env.example`. Le soglie predefinite sono `MIN_PROFIT=100` e `MIN_ROI_PERCENT=20`.
`NOTIFICATION_MODE` può essere `console`, `webhook` o `both`. Per `webhook` impostare `WEBHOOK_URL`.

## Sviluppo

```bash
pytest
ruff check .
```

Il progetto separa dominio, importazione, notifiche e CLI per rendere semplice aggiungere in seguito connettori per marketplace o Telegram.
