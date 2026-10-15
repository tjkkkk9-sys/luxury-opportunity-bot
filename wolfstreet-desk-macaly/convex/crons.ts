import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Turno dell'ufficio ogni 30 minuti: gestisce le posizioni e valuta gli ingressi su candele chiuse.
// Senza chiavi Revolut X il turno si ferma subito senza fare nulla.
crons.interval("turno ufficio", { minutes: 30 }, internal.desk.runTurn, {})

// Analista Plus500 ogni 30 minuti: solo segnali e avvisi Telegram, nessun ordine (Plus500 non ha API).
// In pausa su richiesta del titolare (conto Plus500 senza fondi): si riattiva togliendo il commento.
// crons.interval("analista plus500", { minutes: 30 }, internal.desk.runPlus500, {})

export default crons
