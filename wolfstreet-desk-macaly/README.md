# Wolf Street Desk · versione Macaly (TanStack Start + Convex)

Sorgente dell'app Macaly che fa girare il desk Revolut X su Convex. È il porting TypeScript del desk
Python in `wolfstreet-desk/`, verificato contro di esso:

- strategia e indicatori: risultati identici su 3.128 candele reali;
- turno completo PAPER: stesse 13 operazioni e stessa cassa del Python;
- firma Ed25519: identica al client Python.

Cartelle: `convex/` (backend, cron ogni 30 minuti), `src/` (dashboard), `__tests__/` (21 test vitest).
Le chiavi Revolut X si inseriscono dall'app e restano cifrate sul server; nessun segreto è in questo codice.
