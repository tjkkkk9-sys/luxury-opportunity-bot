# Audit e decisioni — ottobre 2026

## Materiale esaminato
- `wolfstreet-desk-original.zip` (Python, GitHub Actions): la base più completa e testata. È stata ripresa e corretta.
- `office.ts` (porting TypeScript per Convex): ne ho preso le idee buone, cioè il ruolo Risk, il rapporto rendimento/rischio, la coda dei task e il limite di esposizione. La cartella `convex/` completa non era nel pacchetto, quindi non può girare da sola.
- `ufficio.src.html`: la dashboard, collegata ai dati veri del desk. L'ho aggiornata.
- `wolf_gira_tutto_ufficio.html` ("OFFICEVERSE RC", agenti JARVIS, MIRA, JOON…): **è una simulazione**. Non contiene nessuna chiamata di rete e usa `Math.random`. Badge come "LIVE DATA", "VPS CONNECTED" e "99% CONF" non corrispondono a niente di reale. **Non l'ho usata.**
- `Analizzatore_Grafici_Trading_AI.html`: analizza le immagini dei grafici con Gemini. Non conosce il tuo conto e non è collegata al desk. È rimasta fuori.
- `plein_reel_maker_bot.html`: fuori ambito (video).
- Masterplan Market Lab: chiedeva una versione solo paper. Tu adesso chiedi il LIVE sui conti reali. Ho tenuto la sua disciplina (SHADOW di default, test, campione INCONCLUSIVO sotto i 100 trade, stress sui costi) e ho messo il LIVE dietro quattro chiavi.

## Bug trovati e corretti

| # | Gravità | Problema | Correzione |
|---|---|---|---|
| 1 | **critica** | Doppio acquisto: se `GET /orders/{id}` rispondeva 404 subito dopo l'ordine, il bot lo considerava fallito e al turno dopo ricomprava. Nella versione Python non era corretto. | Il `client_order_id` viene generato e **salvato su disco prima dell'invio**. Un 404 viene ritentato e l'ordine viene cercato in `/orders/active` e `/orders/historical`. Se resta incerto, il desk va in pausa e **non invia altri ordini** finché non lo ritrova (test `test_uncertain_order_is_never_repeated_and_is_reconciled`). |
| 2 | **critica** | In LIVE il bot non avrebbe mai comprato. L'API Revolut X restituisce al massimo 100 candele per richiesta, ma EMA200 ne richiede circa 220: il segnale restava "storico insufficiente" per sempre. I test non se ne accorgevano perché usavano candele finte senza limite. | Le candele vengono scaricate in 3 finestre consecutive da 100 (`test_candles_are_paged_to_get_enough_history`). |
| 3 | alta | Se la lettura delle candele falliva, le posizioni aperte non venivano controllate nemmeno per lo stop. | Stop e target si controllano sempre sul prezzo bid. Il trend si controlla solo se i dati ci sono. |
| 4 | alta | IA che non risponde: l'acquisto passava lo stesso. | Fail-closed: errore, rifiuto o risposta illeggibile producono un VETO. L'output è JSON garantito dalle structured outputs. |
| 5 | alta | Il LIVE si apriva con il solo secret, senza verifica. Cambiare chiave non bloccava niente. | Quattro chiavi, armamento legato all'impronta della API key, kill switch. |
| 6 | media | La commissione veniva stimata e non letta dall'ordine. `filled_quantity` è lorda. | `total_fee`/`fee_currency` vengono letti dall'ordine e la quantità è netta (`fill_from_order`). |
| 7 | media | Nessun limite settimanale, rischio non legato al patrimonio, fino a 3 posizioni. | Stop settimanale, rischio ≤ 1,5% del patrimonio, massimo 2 posizioni ed esposizione ≤ 60%. Sono tetti in codice (`bot/safety.py`) che `config.json` non può superare. |
| 8 | media | Si poteva comprare senza bid/ask o con dati vecchi. | Prezzi assenti, meno di 220 candele o ultima candela troppo vecchia bloccano l'acquisto. |
| 9 | media | Il backtest comprava al prezzo di chiusura già visto. | Entrata all'apertura della candela successiva, stress con costi raddoppiati, verdetto INCONCLUSIVO sotto i 100 trade. |
| 10 | bassa | Telegram: i testi variabili non erano escapati e un errore 400 faceva perdere l'avviso. | Escape HTML e reinvio in testo semplice. |
| 11 | bassa | Due turni potevano sovrapporsi. Un conflitto git poteva cancellare un tuo comando. | `concurrency` nel workflow; in caso di conflitto vince il comando dal telefono. |

## Ancora da verificare al primo uso reale
- Il permesso di trading della API key: lo si scopre solo con il primo ordine vero.
- Il casing di `side`: la documentazione usa `buy`/`sell` minuscoli ed è quello che usiamo.
- L'allowlist IP su Revolut X: con GitHub Actions gli IP cambiano, quindi la chiave **non** deve essere limitata per IP.
- Stop lato exchange (ordini `tpsl`): l'API li elenca, ma la documentazione pubblica non spiega come crearli. Oggi lo stop lo esegue il bot ogni 30 minuti, quindi in un crollo rapido l'uscita può avvenire più in basso dello stop.
