import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// Turno dell'ufficio ogni 30 minuti: gestisce le posizioni e valuta gli ingressi su candele chiuse.
// Senza chiavi Revolut X il turno si ferma subito senza fare nulla.
crons.interval("turno ufficio", { minutes: 30 }, internal.desk.runTurn, {})

export default crons
