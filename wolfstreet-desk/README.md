# Wolf Street Capital · Desk Revolut X

Un piccolo ufficio di trading con tre ruoli che lavorano sul tuo conto **Revolut X** ogni 30 minuti, gratis su GitHub, comandato dal **Galaxy Z Fold 7**.

| Ruolo | Cosa fa |
|---|---|
| **Analista** | Legge le candele reali Revolut X a 4 ore (BTC, ETH, SOL, XRP in euro), calcola EMA20/50/200, RSI, ATR, ADX e MACD e assegna un punteggio da 0 a 100. Strategia: compra la correzione dentro un trend rialzista. |
| **Risk** | Applica limiti che nessun file può allentare: rischio massimo 1,5% per operazione, 30% per posizione, al massimo 2 posizioni, stop di perdita giornaliero e settimanale, pausa se il calo supera il 10%. Blocca l'acquisto se i dati sono vecchi o mancano i prezzi. L'IA (Claude) può solo aggiungere un veto, e se non risponde il veto scatta. |
| **Trader** | Dimensiona l'ordine sul rischio e lo esegue. Gestisce stop a 3 ATR, target a 4 ATR, trailing stop, uscita quando il trend si rompe e uscita a tempo. Vende solo le quantità comprate dal bot. |

> ⚠️ **Nessun guadagno è garantito.** Le crypto possono perdere molto in poche ore. Usa solo soldi che puoi permetterti di perdere. Questo non è consulenza finanziaria.

## Le tre modalità

| Modalità | Ordini veri? | A cosa serve |
|---|---|---|
| **SHADOW** (predefinita) | no | Il bot calcola tutto e annota nel *Diario shadow* cosa avrebbe comprato. Non c'è nessun portafoglio. |
| **PAPER** | no | Portafoglio virtuale con prezzi veri, commissioni comprese. |
| **LIVE** | **sì** | Ordini veri sul tuo conto. |

**LIVE si attiva solo quando valgono tutte e quattro queste condizioni:**
1. dalla dashboard hai premuto **Passa a LIVE**;
2. il **kill switch** è spento;
3. **Verifica e arma LIVE** è risultata tutta verde (chiavi, saldi, prezzi, 220 o più candele per coppia, nessun ordine in sospeso);
4. su GitHub esiste il secret `LIVE_TRADING` = `SI`.

Se manca anche una sola condizione, il turno gira in SHADOW. Quando cambi la API key, cambi modalità o accendi il kill switch, il LIVE si disarma da solo.

Gli stop delle posizioni LIVE già aperte restano attivi anche se il desk viene disarmato: lasciare una posizione vera senza stop è più rischioso. Il **kill switch** blocca davvero tutto, stop compresi; a quel punto le posizioni le gestisci tu dall'app Revolut X.

## Installazione dal telefono (circa 20 minuti)

### 1 · Chiavi Revolut X
1. Apri la dashboard, vai su **Comandi** e premi **Genera nuova coppia**. La chiave privata resta sul telefono.
2. Su Revolut X apri il browser, vai su **Profilo → API**, crea una API key e incolla la **chiave pubblica**.
   - Per SHADOW e PAPER usa una chiave **solo lettura**.
   - Per LIVE serve una chiave **con trading abilitato e mai con i prelievi**.
3. Copia la **API key** di 64 caratteri.

### 2 · Repository privato su GitHub
1. Crea un repository **privato**, per esempio `wolfstreet-desk`, e carica il contenuto di questa cartella. Il file `.github/workflows/office.yml` deve trovarsi nella radice del repository.
2. Vai su **Settings → Secrets and variables → Actions** e aggiungi:

| Secret | Valore | Serve |
|---|---|---|
| `REVX_API_KEY` | API key Revolut X | sì |
| `REVX_PRIVATE_KEY` | chiave privata completa, comprese le righe BEGIN/END | sì |
| `ANTHROPIC_API_KEY` | chiave Claude (attiva il veto IA) | consigliato |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | avvisi sul telefono | facoltativo |
| `LIVE_TRADING` | `SI` | **solo quando decidi di andare LIVE** |

3. Vai su **Actions → Ufficio Wolf Street → Run workflow**, spunta **check** e avvia. Nel log devi leggere `OK` su ogni riga.

### 3 · L'ufficio sul Fold
1. Crea un secondo repository **pubblico** (per esempio `wolfstreet-ufficio`) e caricaci solo `docs/index.html`. Poi vai su **Settings → Pages**, scegli `main` e `/ (root)`.
2. Apri `https://TUO-UTENTE.github.io/wolfstreet-ufficio/` e dal menu di Chrome scegli **Aggiungi a schermata Home**.
3. Crea un token fine-grained: **Settings → Developer settings → Fine-grained tokens**, con accesso solo a `wolfstreet-desk` e i permessi **Contents** e **Actions** in lettura e scrittura.
4. Nella dashboard vai su **Comandi**, inserisci repository e token e premi **Salva e collega**. Finché non colleghi il repository, la dashboard mostra dati **DEMO**.

### 4 · Il percorso verso il LIVE
1. **SHADOW per 1–2 settimane.** Leggi il Registro e il Diario shadow e cerca di capire perché il bot vorrebbe comprare.
2. **PAPER per almeno 3–4 settimane.** Confronta i risultati con il backtest.
3. **LIVE.** Usa una API key con trading, aggiungi il secret `LIVE_TRADING = SI`, poi premi **Passa a LIVE** e infine **Verifica e arma LIVE**. Il primo acquisto vero è anche l'ultimo test: controllalo nell'app Revolut X.

## Numeri onesti

Backtest su candele reali Revolut X, 7 luglio – 9 ottobre 2026, 40 €. Entrata all'apertura della candela successiva, commissione 0,09% e slippage 0,05%:

| | Risultato | Operazioni | Vincenti | Profit factor | Calo massimo |
|---|---|---|---|---|---|
| Desk, costi normali | **+5,1%** | 27 | 48% | 1,67 | 3,9% |
| Desk, costi raddoppiati | +3,0% | 27 | — | 1,35 | 4,6% |
| Comprare e tenere le 4 coppie | **+34,5%** | — | — | — | più alto |

In un periodo molto rialzista comprare e tenere ha reso molto di più. Con 27 operazioni il risultato è **INCONCLUSIVO**: ne servono almeno 100 prima di trarre conclusioni. Puoi rifare il calcolo con `python -m bot.backtest tests/fixtures`.

## Comandi utili

```bash
pip install -r requirements.txt
python -m pytest -q              # 32 test: firma, idempotenza ordini, blocchi LIVE, IA fail-closed, backtest
python -m bot.office --check     # verifica chiavi e dati, nessun ordine
python tools/build_dashboard.py  # rigenera docs/index.html
```

## Costi
- GitHub Actions su repository privato: 2.000 minuti gratuiti al mese. Un turno ogni 30 minuti ne consuma circa 1.500; sui turni automatici i test vengono saltati per risparmiare minuti.
- Revolut X: 0% maker e 0,09% taker. Il bot usa ordini market (taker).
- Claude (`claude-haiku-5-5`): viene chiamato solo sui candidati all'acquisto, quindi costa pochi centesimi al mese.

## Se qualcosa non va

| Sintomo | Causa probabile |
|---|---|
| "LIVE richiesto ma non attivo" | Manca una delle quattro condizioni: il banner dice quale. |
| "Ordine … in attesa di conferma" | Revolut X non ha confermato un ordine. Il bot non lo ripete: al turno successivo lo cerca per `client_order_id`. Controlla l'app e poi premi **Riprendi**. |
| `HTTP 401` | La chiave pubblica su Revolut X non corrisponde alla privata su GitHub, oppure la API key ha una allowlist di IP: GitHub Actions usa IP che cambiano. |
| `HTTP 403` in LIVE | La API key non ha il permesso di trading. |
| "Nessun turno da oltre 90 minuti" | GitHub sospende i turni dopo 60 giorni senza attività: vai su Actions e riattivali. |
