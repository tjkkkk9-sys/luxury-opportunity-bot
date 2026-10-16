import { createFileRoute } from "@tanstack/react-router"
import { useAuthActions } from "@convex-dev/auth/react"
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react"
import { useEffect, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { api } from "../../convex/_generated/api"
import siteMetadata from "../metadata.json"
import { ROLE_IDS, ROLE_INFO, fmtWait, salaState } from "../components/sala-state"

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: siteMetadata["/"].title }, { name: "description", content: siteMetadata["/"].description }] }),
  component: App,
})

// ------------------------------------------------------------------ formattazione
const fmtEur = (v: unknown, sign = false) => {
  const n = Number(v)
  if (v === null || v === undefined || !Number.isFinite(n)) return "—"
  return (sign && n > 0 ? "+" : "") + new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n)
}
const fmtPct = (v: unknown, sign = true) => {
  const n = Number(v)
  if (v === null || v === undefined || !Number.isFinite(n)) return "—"
  return (sign && n > 0 ? "+" : "") + n.toFixed(2).replace(".", ",") + "%"
}
const fmtPx = (v: unknown) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("it-IT", { maximumSignificantDigits: 6 }))
const when = (t: number) => new Date(t * 1000).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const ago = (t: number) => {
  const m = Math.round((Date.now() / 1000 - t) / 60)
  return m < 1 ? "adesso" : m < 60 ? `${m} min fa` : m < 1440 ? `${Math.round(m / 60)} h fa` : `${Math.round(m / 1440)} g fa`
}
const tone = (v: unknown) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "")

function App() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const me = useQuery(api.store.me, isAuthenticated ? {} : "skip")
  if (isLoading || (isAuthenticated && me === undefined)) return <Shell><p className="note">Caricamento…</p></Shell>
  if (!isAuthenticated) return <Shell><Login /></Shell>
  if (!me?.owner) return <Shell><NotOwner /></Shell>
  return <Desk />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="wrap">
      <header className="top">
        <small>Desk Plus500 · Revolut X</small>
        <h1>Wolf Street <span>Capital</span></h1>
      </header>
      <div className="stack">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ accesso
function Login() {
  const { signIn } = useAuthActions()
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [step, setStep] = useState<"email" | "code">("email")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  async function sendCode(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg("")
    try { await signIn("resend-otp", { email: email.trim() }); setStep("code"); setMsg("Codice inviato: controlla la tua email.") }
    catch { setMsg("Accesso riservato al titolare del desk. Controlla l'indirizzo email.") }
    finally { setBusy(false) }
  }
  async function verify(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg("")
    try { await signIn("resend-otp", { email: email.trim(), code: code.trim() }) }
    catch { setMsg("Codice non valido o scaduto: richiedine uno nuovo.") }
    finally { setBusy(false) }
  }
  return (
    <article className="panel">
      <h2>Accesso al desk</h2>
      <p className="note">Il desk è riservato al titolare. Ti mandiamo un codice di 6 cifre via email.</p>
      {step === "email" ? (
        <form onSubmit={sendCode} className="form">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="solid" disabled={busy}>{busy ? "Invio…" : "Mandami il codice"}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="form">
          <label htmlFor="code">Codice ricevuto</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          <div className="row">
            <button className="solid" disabled={busy}>{busy ? "Verifica…" : "Entra"}</button>
            <button type="button" className="ghost" onClick={() => setStep("email")}>Cambia email</button>
          </div>
        </form>
      )}
      {msg && <p className="note" role="status">{msg}</p>}
    </article>
  )
}

function NotOwner() {
  const { signOut } = useAuthActions()
  return (
    <article className="panel">
      <h2>Accesso non autorizzato</h2>
      <p className="note">Questo account non è il titolare del desk.</p>
      <button className="ghost" onClick={() => void signOut()}>Esci</button>
    </article>
  )
}

// ------------------------------------------------------------------ desk
const TABS = [["ufficio", "Revolut X"], ["sala", "Sala 3D"], ["plus500", "Plus500"], ["mercato", "Mercato"], ["posizioni", "Posizioni"], ["registro", "Registro"], ["comandi", "Comandi"]] as const
type Tab = (typeof TABS)[number][0]

function Desk() {
  const data = useQuery(api.store.view, {})
  const [tab, setTab] = useState<Tab>("ufficio")
  useEffect(() => { const h = location.hash.slice(1); if (TABS.some(([t]) => t === h)) setTab(h as Tab) }, [])
  const go = (t: Tab) => { setTab(t); history.replaceState(null, "", "#" + t) }
  if (data === undefined) return <Shell><p className="note">Caricamento…</p></Shell>
  if (data === null) return <Shell><NotOwner /></Shell>
  const D: any = data.office ?? {}
  const keysReady = data.keys.revx_api_key && data.keys.revx_private_key
  return (
    <div className="wrap">
      <Header D={D} control={data.control} keysReady={keysReady || tab === "plus500"} p500={tab === "plus500"} />
      <nav className="tabs" aria-label="Sezioni">
        <div role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => go(id)}>{label}</button>
          ))}
        </div>
      </nav>
      {tab === "plus500" && <Plus500 />}
      {tab === "ufficio" && <Ufficio D={D} keysReady={keysReady} go={go} />}
      {tab === "mercato" && <Mercato D={D} />}
      {tab === "posizioni" && <Posizioni D={D} />}
      {tab === "registro" && <Registro D={D} />}
      {tab === "sala" && <Sala D={D} />}
      {tab === "comandi" && <Comandi data={data} D={D} />}
    </div>
  )
}

function Header({ D, control, keysReady, p500 }: { D: any; control: any; keysReady: boolean; p500?: boolean }) {
  if (p500) return (
    <header className="top">
      <div className="brand">
        <div><small>Desk Plus500 · segnali CFD</small><h1>Wolf Street <span>Capital</span></h1></div>
        <div className="status"><span className="pill paper"><span className="dot" />Esecuzione manuale</span></div>
      </div>
      <div className="banners"><div className="banner">Analisi automatica Plus500 in pausa: nessun avviso Telegram. Puoi comunque premere "Analizza adesso". Plus500 non ha API: il desk analizza e ti avvisa, l'ordine lo apri tu dall'app Plus500 con Stop Loss e Take Profit. I CFD con leva possono far perdere più in fretta di quanto pensi: rispetta sempre lo stop.</div></div>
    </header>
  )
  const mode = String(D.mode ?? control.mode ?? "shadow").toLowerCase()
  const banners: ReactNode[] = []
  if (!keysReady) banners.push(<div key="k" className="banner">Mancano le chiavi Revolut X: vai su <b>Comandi → Chiavi Revolut X</b>. Finché non ci sono il desk resta spento.</div>)
  if (control.paused && control.pause_reason) banners.push(<div key="p" className="banner">Pausa: {control.pause_reason}</div>)
  if (control.mode === "live" && mode !== "live" && D.live_blocks?.length) banners.push(<div key="l" className="banner err">LIVE richiesto ma non attivo: {D.live_blocks.join(" · ")}. Il desk lavora in SHADOW.</div>)
  for (const o of D.pending_orders ?? []) banners.push(<div key={o.created_ms} className="banner err">Ordine {o.side} {o.symbol} in attesa di conferma da Revolut X: nessun nuovo acquisto finché non è chiarito.</div>)
  for (const e of (D.errors ?? []).slice(0, 3)) banners.push(<div key={e} className="banner err">{e}</div>)
  return (
    <header className="top">
      <div className="brand">
        <div>
          <small>{D.desk ?? "Desk Revolut X"}</small>
          <h1>Wolf Street <span>Capital</span></h1>
        </div>
        <div className="status">
          {mode === "live" ? <span className="pill live"><span className="dot pulse" />Live · soldi veri</span>
            : mode === "paper" ? <span className="pill paper"><span className="dot" />Paper · simulato</span>
            : mode === "shadow" ? <span className="pill"><span className="dot" />Shadow · nessun ordine</span>
            : <span className="pill off">Spento</span>}
          {control.kill_switch ? <span className="pill live">Kill switch</span>
            : control.paused ? <span className="pill off">In pausa</span> : <span className="pill on"><span className="dot pulse" />Operativo</span>}
          {control.mode === "live" && <span className={`pill ${control.live_armed ? "on" : "off"}`}>{control.live_armed ? "Live armato" : "Live non armato"}</span>}
          {D.ai_enabled && <span className="pill">IA attiva</span>}
        </div>
      </div>
      <p className="stamp">Ultimo turno {D.generated_at ? <><span className="num">{when(D.generated_at)}</span> ({ago(D.generated_at)})</> : "—"} · turni totali <span className="num">{D.runs ?? 0}</span> · dati reali Revolut X</p>
      <div className="banners">{banners}</div>
    </header>
  )
}

function Kpis({ k, c }: { k: any; c: any }) {
  const items: [string, string, string, string][] = [
    ["Patrimonio", fmtEur(k.equity), `partenza ${fmtEur(k.start)}`, ""],
    ["Risultato", fmtEur(k.pnl_total, true), fmtPct(k.pnl_pct), tone(k.pnl_total)],
    ["Oggi · settimana", fmtEur(k.pnl_today, true), `settimana ${fmtEur(k.pnl_week, true)}`, tone(k.pnl_today)],
    ["Vincenti", k.win_rate == null ? "—" : fmtPct(k.win_rate, false), `${k.trades ?? 0} chiuse · ${k.sample ?? "—"}`, ""],
    ["Investito", fmtEur(k.exposure), `liquidità ${fmtEur(k.cash)}`, ""],
    ["Calo massimo", fmtPct(k.max_dd_pct == null ? null : -k.max_dd_pct), `limite ${c?.max_drawdown_pct ?? "—"}%`, k.max_dd_pct > (c?.max_drawdown_pct ?? 10) * 0.6 ? "down" : ""],
  ]
  return (
    <div className="kpis">
      {items.map(([l, v, s, cl]) => <div className="kpi" key={l}><span className="label">{l}</span><b className={cl}>{v}</b><i>{s}</i></div>)}
    </div>
  )
}

function Ufficio({ D, keysReady, go }: { D: any; keysReady: boolean; go: (t: Tab) => void }) {
  const hasBook = D.kpi && Object.keys(D.kpi).length > 0
  return (
    <section className="view split">
      <div className="span2"><Room D={D} /></div>
      {hasBook ? <div className="span2"><Kpis k={D.kpi} c={D.config} /></div>
        : <article className="panel span2"><p className="note">{D.mode === "shadow" ? "In SHADOW il desk non ha un portafoglio: registra nel Diario shadow cosa avrebbe comprato." : "I numeri compaiono dopo il primo turno."}{!keysReady && <> <button className="link" onClick={() => go("comandi")}>Inserisci le chiavi</button></>}</p></article>}
      <article className="panel">
        <div className="ph"><h2>La squadra</h2><span className="eyebrow">{D.generated_at ? "turno " + when(D.generated_at) : ""}</span></div>
        <div className="desks">
          {(D.agents ?? []).length ? D.agents.map((a: any) => (
            <div className={`desk ${a.status !== "IN PAUSA" ? "scan" : ""}`} key={a.id}>
              <div className="av">{a.name[0]}</div>
              <div className="min0">
                <h3>{a.name} <span className={`chip ${a.status === "IN PAUSA" || a.status === "BLOCCO" ? "c-avoid" : a.status === "SEGNALE" || a.status === "OPERATIVO" ? "c-buy" : "c-wait"}`}>{a.status}</span></h3>
                <p>{a.role}</p>
                <div className="row between"><span><span className="metric num">{a.metric}</span> <span className="muted">{a.unit}</span></span>{a.ai_reviews ? <span className="chip c-ai">{a.ai_reviews} pareri IA</span> : null}</div>
                <p>{a.detail}</p>
              </div>
            </div>
          )) : <p className="empty">I bot non hanno ancora completato un turno.</p>}
        </div>
      </article>
      <article className="panel">
        <div className="ph"><h2>Patrimonio del desk</h2><span className="eyebrow">{(D.equity ?? []).length ? `${D.equity.length} rilevazioni` : ""}</span></div>
        <EquityChart pts={D.equity ?? []} start={D.kpi?.start} />
      </article>
    </section>
  )
}

function EquityChart({ pts, start }: { pts: [number, number][]; start?: number }) {
  if (pts.length < 2) return <p className="empty">La curva compare dopo i primi turni in PAPER o LIVE.</p>
  const W = 640, H = 230, L = 52, R = 14, T = 14, B = 28
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]).concat(start ? [start] : [])
  let lo = Math.min(...ys), hi = Math.max(...ys)
  const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad
  const x = (t: number) => L + ((t - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (W - L - R)
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B)
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join("")
  const last = pts[pts.length - 1][1], col = last >= (start ?? pts[0][1]) ? "var(--up)" : "var(--down)"
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Andamento del patrimonio, ultimo valore ${fmtEur(last)}`}>
      {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v.toFixed(v < 100 ? 1 : 0)}</text></g>)}
      {start ? <line x1={L} x2={W - R} y1={y(start)} y2={y(start)} stroke="var(--gold)" strokeDasharray="4 4" /> : null}
      <path d={`${line}L${x(xs[xs.length - 1])} ${H - B}L${L} ${H - B}Z`} fill={col} opacity={0.1} />
      <path d={line} fill="none" stroke={col} strokeWidth={2} />
      <circle cx={x(xs[xs.length - 1])} cy={y(last)} r={4} fill={col} />
      {[0, 0.5, 1].map((f, i) => { const t = xs[0] + (xs[xs.length - 1] - xs[0]) * f; return <text key={f} x={x(t)} y={H - 8} textAnchor={["start", "middle", "end"][i] as any}>{new Date(t * 1000).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}</text> })}
    </svg>
  )
}

function Mercato({ D }: { D: any }) {
  const c = D.config ?? {}
  const rules: [string, string][] = [
    [`${c.risk_per_trade_eur ?? "—"} € · ${c.max_risk_pct ?? "—"}%`, "rischio massimo per operazione"],
    [`${c.max_position_pct ?? "—"}%`, "tetto per singola posizione"],
    [`${c.max_open_positions ?? "—"}`, "posizioni contemporanee"],
    [`−${c.daily_loss_limit_eur ?? "—"} € / −${c.weekly_loss_limit_eur ?? "—"} €`, "stop giornaliero / settimanale"],
    [`${c.max_drawdown_pct ?? "—"}%`, "calo che mette in pausa"],
    [`${c.stop_atr ?? "—"}× / ${c.tp_atr ?? "—"}× ATR`, "distanza di stop e target"],
  ]
  return (
    <section className="view split">
      <article className="panel">
        <div className="ph"><h2>Lavagna dell'Analista</h2><span className="eyebrow">candele {(c.interval_min ?? 240) / 60}h · soglia {c.min_score ?? 80}</span></div>
        {(D.signals ?? []).length ? D.signals.map((s: any) => (
          <div className="sig" key={s.symbol}>
            <div><span className="sym">{s.symbol}</span> <span className="px num">{fmtPx(s.live_price ?? s.price)} €</span> {s.change_24h_pct != null && <span className={`num small ${tone(s.change_24h_pct)}`}>{fmtPct(s.change_24h_pct)} 24h</span>}</div>
            <div><span className={`chip ${s.action === "COMPRA" ? "c-buy" : s.action === "EVITA" ? "c-avoid" : "c-wait"}`}>{s.action}</span> <span className="num">{s.score}</span></div>
            <div className="bar" aria-label={`punteggio ${s.score} su 100`}><span style={{ width: `${s.score}%` }} /><em style={{ left: `${c.min_score ?? 80}%` }} /></div>
            <div className="meta full"><span>RSI <b className="num">{s.rsi?.toFixed(0) ?? "—"}</b></span><span>ATR <b className="num">{s.atr_pct?.toFixed(2) ?? "—"}%</b></span><span>ADX <b className="num">{s.adx?.toFixed(0) ?? "—"}</b></span>{s.spread_pct != null && <span>spread <b className="num">{s.spread_pct.toFixed(3)}%</b></span>}<span>{s.candles} candele</span></div>
            <ul className="why">{(s.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
            {s.ai && <p className="why flat"><span className="chip c-ai">IA {s.ai.verdict}</span> {s.ai.reason}</p>}
          </div>
        )) : <p className="empty">Nessuna analisi disponibile: serve il primo turno con le chiavi.</p>}
      </article>
      <article className="panel">
        <div className="ph"><h2>Regole di ingaggio</h2><span className="eyebrow">tetti fissi nel codice</span></div>
        <div className="rules">{rules.map(([b, s]) => <div key={s}><b>{b}</b><span>{s}</span></div>)}</div>
        <p className="note">L'Analista compra solo correzioni dentro un trend rialzista (EMA50 sopra EMA200) quando il momentum riparte, su candele chiuse e fresche. Il Trader dimensiona ogni ordine sul rischio. L'IA può solo aggiungere un veto.</p>
      </article>
    </section>
  )
}

function Posizioni({ D }: { D: any }) {
  const ps = [...(D.positions ?? []), ...(D.mode !== "live" && D.live_book ? D.live_book.positions ?? [] : [])]
  return (
    <section className="view split">
      <article className="panel">
        <div className="ph"><h2>Posizioni aperte</h2><span className="eyebrow">{ps.length} aperte</span></div>
        {ps.length ? ps.map((p: any) => {
          const span = p.tp - p.stop || 1, at = (v: number) => Math.max(0, Math.min(100, ((v - p.stop) / span) * 100))
          return (
            <div className="pos" key={p.symbol + p.mode}>
              <div className="row between"><span><b>{p.symbol}</b> <span className={`chip ${p.mode === "live" ? "c-avoid" : "c-wait"}`}>{String(p.mode).toUpperCase()}</span> <span className="num muted small">{fmtPx(p.qty)} @ {fmtPx(p.entry)}</span></span><span className={`num ${tone(p.pnl)}`}><b>{fmtEur(p.pnl, true)}</b> {fmtPct(p.pnl_pct)}</span></div>
              <div className="range"><b style={{ left: `${at(p.entry)}%` }} /><i style={{ left: `calc(${at(p.price)}% - 1px)` }} /></div>
              <div className="rl num"><span>stop {fmtPx(p.stop)}</span><span>ora {fmtPx(p.price)}</span><span>target {fmtPx(p.tp)}</span></div>
            </div>
          )
        }) : <p className="empty">Nessuna posizione aperta.</p>}
      </article>
      <article className="panel">
        <div className="ph"><h2>Operazioni chiuse</h2><span className="eyebrow">ultime {(D.closed ?? []).length}</span></div>
        <div className="tw"><table><tbody>
          {(D.closed ?? []).length ? D.closed.map((t: any) => <tr key={t.symbol + t.closed_at}><td className="num">{when(t.closed_at)}</td><td>{t.symbol}</td><td>{t.reason}</td><td className={`r num ${tone(t.pnl)}`}>{fmtEur(t.pnl, true)}</td></tr>)
            : <tr><td className="empty">Ancora nessuna operazione chiusa.</td></tr>}
        </tbody></table></div>
      </article>
      <article className="panel span2">
        <div className="ph"><h2>Diario shadow</h2><span className="eyebrow">cosa avrebbe comprato · nessun ordine</span></div>
        <div className="tw"><table><tbody>
          {(D.shadow ?? []).length ? D.shadow.map((r: any) => <tr key={r.symbol + r.t}><td className="num">{when(r.t)}</td><td>{r.symbol}</td><td className="r num">{fmtEur(r.eur)}</td><td className="r num">@ {fmtPx(r.price)}</td><td className="r num muted">stop {fmtPx(r.stop)} · target {fmtPx(r.tp)}</td></tr>)
            : <tr><td className="empty">In SHADOW il desk annota qui gli acquisti che avrebbe fatto. Ancora nessuno.</td></tr>}
        </tbody></table></div>
      </article>
    </section>
  )
}

function Registro({ D }: { D: any }) {
  const [who, setWho] = useState("TUTTI")
  const rows = (D.log ?? []).filter((l: any) => who === "TUTTI" || l.bot === who)
  return (
    <section className="view">
      <article className="panel">
        <div className="ph"><h2>Registro attività</h2>
          <div className="filters">{["TUTTI", "ANALISTA", "RISK", "TRADER", "SISTEMA"].map((w) => <button key={w} className="fbtn" aria-pressed={w === who} onClick={() => setWho(w)}>{w[0] + w.slice(1).toLowerCase()}</button>)}</div>
        </div>
        <ol className="log">
          {rows.length ? rows.map((l: any, i: number) => <li key={i} className={l.level}><time>{when(l.t)}</time><div><span className={`who ${l.bot}`}>{l.bot}</span> <span className="txt">{l.text}</span></div></li>)
            : <li><span /><span className="empty">Nessuna voce.</span></li>}
        </ol>
      </article>
    </section>
  )
}

// ------------------------------------------------------------------ comandi e chiavi
const CONFIRM: Record<string, string> = {
  kill: "Il kill switch blocca OGNI ordine, compresi gli stop delle posizioni LIVE: le gestirai tu dall'app Revolut X. Confermi?",
  panic: "Il Trader venderà al prezzo di mercato tutte le posizioni aperte dal bot (non le tue altre crypto) e metterà il desk in pausa. Confermi?",
  arm: "Avvio la verifica completa. Se hai chiesto LIVE e tutto è verde, il desk viene ARMATO e dal turno successivo può inviare ordini veri. Confermi?",
}

function Comandi({ data, D }: { data: any; D: any }) {
  const command = useMutation(api.store.command)
  const runNow = useAction(api.desk.runNow)
  const selftest = useAction(api.desk.selftest)
  const { signOut } = useAuthActions()
  const [pending, setPending] = useState<string | null>(null)
  const [msg, setMsg] = useState("")
  const [phrase, setPhrase] = useState("")
  const c = data.control
  async function exec(cmd: string) {
    setPending(null); setMsg("Invio…")
    try {
      if (cmd === "run") { await runNow({}); setMsg("Turno eseguito.") }
      else if (cmd === "check" || cmd === "arm") { const r: any = await selftest({ arm: cmd === "arm" }); setMsg(r.green ? (r.armed ? "Verifica verde: LIVE armato." : "Verifica verde.") : "Verifica rossa: guarda i dettagli qui sotto.") }
      else if (cmd === "live") { await command({ cmd, confirm: phrase }); setPhrase(""); setMsg("LIVE richiesto: ora premi Verifica e arma LIVE.") }
      else { await command({ cmd }); setMsg("Comando salvato: vale dal prossimo turno (o premi Esegui turno ora).") }
    } catch (e: any) { setMsg(String(e?.data ?? e?.message ?? e).replace(/^.*Uncaught Error: /, "").split("\n")[0]) }
  }
  const ask = (cmd: string) => (CONFIRM[cmd] ? setPending(cmd) : void exec(cmd))
  const btns: [string, string, string, string][] = [
    ["run", "Esegui turno ora", "I bot lavorano subito", "gold"],
    [c.paused ? "resume" : "pause", c.paused ? "Riprendi" : "Metti in pausa", c.paused ? "Riattiva nuovi ingressi" : "Stop nuovi acquisti, le uscite continuano", ""],
    ["shadow", "SHADOW", c.mode === "shadow" ? "Attivo · registra senza ordini" : "Solo decisioni, nessun ordine", ""],
    ["paper", "PAPER", c.mode === "paper" ? "Attivo · portafoglio virtuale" : "Portafoglio virtuale su prezzi veri", ""],
    ["check", "Verifica chiavi", "Solo lettura, non arma", ""],
    ["arm", "Verifica e arma LIVE", "Arma solo se tutto è verde e hai chiesto LIVE", "gold"],
    [c.kill_switch ? "unkill" : "kill", c.kill_switch ? "Spegni kill switch" : "KILL SWITCH", c.kill_switch ? "Riattiva il desk" : "Blocca ogni ordine, anche gli stop", "red"],
    ["panic", "Chiudi tutto", "Vende le posizioni del bot e mette in pausa", "red"],
  ]
  return (
    <section className="view split">
      <article className="panel span2">
        <div className="ph"><h2>Sala comandi</h2><span className="eyebrow">modalità richiesta: {String(c.mode).toUpperCase()}</span></div>
        <div className="cmds">{btns.map(([id, b, s, cl]) => <button key={id} className={`btn ${cl}`} onClick={() => ask(id)}><b>{b}</b><span>{s}</span></button>)}</div>
        {pending && <div className="confirm" role="alertdialog"><p>{CONFIRM[pending]}</p><div className="row"><button className="solid red" onClick={() => void exec(pending)}>Sì, conferma</button><button className="ghost" onClick={() => setPending(null)}>Annulla</button></div></div>}
        {msg && <p className="note" role="status">{msg}</p>}
        <div className="live-box">
          <p className="note"><b>Passare al LIVE</b> usa soldi veri del tuo conto Revolut X, entro i limiti del desk. Le perdite sono possibili: usa solo denaro che puoi permetterti di perdere. Scrivi <b>SOLDI VERI</b> per chiedere il LIVE; poi serve la verifica verde.</p>
          <div className="row"><input aria-label="Conferma LIVE" placeholder="SOLDI VERI" value={phrase} onChange={(e) => setPhrase(e.target.value)} /><button className="solid red" disabled={phrase.trim().toUpperCase() !== "SOLDI VERI"} onClick={() => void exec("live")}>Chiedi LIVE</button></div>
        </div>
        <Selftest r={data.selftest} />
      </article>
      <Chiavi data={data} />
      <Opzionali data={data} />
      <article className="panel span2"><div className="row between"><p className="note">Connesso come titolare.</p><button className="ghost" onClick={() => void signOut()}>Esci</button></div></article>
    </section>
  )
}

function Selftest({ r }: { r: any }) {
  if (!r) return null
  return (
    <div className="selftest">
      <h3>Ultima verifica · <span className={r.green ? "up" : "down"}>{r.green ? "VERDE" : "ROSSA"}</span>{r.armed && <span className="down"> · LIVE ARMATO</span>} <span className="eyebrow">{when(r.t)}</span></h3>
      <ul>{(r.checks ?? []).map((c: any) => <li key={c.name}>{c.ok ? "✅" : "❌"} <b>{c.name}</b> · {c.detail}</li>)}</ul>
      {r.note && <p className="note">{r.note}</p>}
    </div>
  )
}

// Coppia Ed25519 generata nel browser: la privata va solo al server (cifrata), mai mostrata altrove.
async function generateKeys(): Promise<{ pub: string; priv: string }> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair
  const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).match(/.{1,64}/g)!.join("\n")
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", k.privateKey)
  const spki = await crypto.subtle.exportKey("spki", k.publicKey)
  return { priv: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8)}\n-----END PRIVATE KEY-----`, pub: `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----` }
}

function Chiavi({ data }: { data: any }) {
  const save = useAction(api.desk.saveRevxKeys)
  const [pair, setPair] = useState<{ pub: string; priv: string } | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const ready = data.keys.revx_api_key && data.keys.revx_private_key
  async function gen() {
    try { setPair(await generateKeys()); setMsg("") } catch { setMsg("Questo browser non sa generare chiavi Ed25519: aggiorna Chrome e riprova.") }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMsg("Chiave pubblica copiata.") } catch { setMsg("Copia non riuscita: tieni premuto sul testo e copia.") }
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!pair) return
    setBusy(true); setMsg("")
    try { await save({ apiKey, privateKey: pair.priv }); setPair(null); setApiKey(""); setMsg("Chiavi salvate e cifrate. Ora premi Verifica chiavi.") }
    catch (err: any) { setMsg(String(err?.data ?? err?.message ?? err).replace(/^.*Uncaught Error: /, "").split("\n")[0]) }
    finally { setBusy(false) }
  }
  return (
    <article className="panel">
      <div className="ph"><h2>Chiavi Revolut X</h2><span className={`chip ${ready ? "c-buy" : "c-avoid"}`}>{ready ? `salvate · ${data.keyFingerprint ?? ""}` : "mancanti"}</span></div>
      <ol className="steps">
        <li>Premi <b>Genera chiavi</b>: la chiave privata nasce sul telefono e verrà salvata solo cifrata nel desk.</li>
        <li>Copia la <b>chiave pubblica</b> e su Revolut X (Profilo → API) crea una API key incollandola. Lascia spenti i prelievi.</li>
        <li>Incolla qui la <b>API key</b> che ti dà Revolut X e premi <b>Salva chiavi</b>.</li>
      </ol>
      {!pair ? <button className="solid" onClick={() => void gen()}>{ready ? "Sostituisci le chiavi" : "Genera chiavi"}</button> : (
        <form onSubmit={submit} className="form">
          <label htmlFor="pub">Chiave pubblica (per Revolut X)</label>
          <pre id="pub" className="key">{pair.pub}</pre>
          <button type="button" className="ghost" onClick={() => void copy(pair.pub)}>Copia pubblica</button>
          <a className="ghost center" href="https://exchange.revolut.com/" target="_blank" rel="noreferrer">Apri Revolut X</a>
          <label htmlFor="apikey">API key di Revolut X</label>
          <input id="apikey" autoComplete="off" autoCapitalize="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
          <button className="solid" disabled={busy || !apiKey.trim()}>{busy ? "Salvataggio…" : "Salva chiavi"}</button>
        </form>
      )}
      {msg && <p className="note" role="status">{msg}</p>}
    </article>
  )
}

function Opzionali({ data }: { data: any }) {
  const save = useAction(api.desk.saveOptionalSecret)
  const [vals, setVals] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState("")
  const fields: [string, string, string][] = [
    ["anthropic_key", "Chiave Claude (veto IA)", "sk-ant-…"],
    ["telegram_token", "Token bot Telegram", "123456:ABC…"],
    ["telegram_chat", "Chat ID Telegram", "123456789"],
  ]
  async function store(name: string) {
    try { await save({ name, value: vals[name] ?? "" }); setVals((v) => ({ ...v, [name]: "" })); setMsg("Salvato.") }
    catch (e: any) { setMsg(String(e?.message ?? e)) }
  }
  return (
    <article className="panel">
      <div className="ph"><h2>Facoltativi</h2><span className="eyebrow">IA e avvisi</span></div>
      {fields.map(([name, label, ph]) => (
        <div className="field" key={name}>
          <label htmlFor={name}>{label} {data.keys[name] ? <span className="chip c-buy">salvato</span> : null}</label>
          <div className="row"><input id={name} type="password" autoComplete="off" placeholder={ph} value={vals[name] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [name]: e.target.value }))} /><button className="ghost" onClick={() => void store(name)}>{vals[name] ? "Salva" : "Rimuovi"}</button></div>
        </div>
      ))}
      {msg && <p className="note" role="status">{msg}</p>}
    </article>
  )
}

// ------------------------------------------------------------------ Plus500 (segnali, esecuzione manuale)
const P500_LIST: [string, string][] = [["brent", "Petrolio Brent"], ["wti", "Petrolio WTI"], ["oro", "Oro"], ["argento", "Argento"], ["gas", "Gas naturale"], ["usa500", "USA 500"], ["usatech", "USA Tech 100"], ["germany40", "Germany 40"], ["eurusd", "EUR/USD"]]

function Plus500() {
  const data = useQuery(api.store.p500View, {})
  const run = useAction(api.desk.plus500Now)
  const saveCfg = useMutation(api.store.saveP500Config)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState("")
  const V: any = data?.view ?? {}
  const c: any = V.config ?? { ...data?.config }
  const [cap, setCap] = useState(""), [risk, setRisk] = useState("")
  useEffect(() => { if (c.capital_eur) { setCap(String(c.capital_eur)); setRisk(String(c.risk_pct)) } }, [c.capital_eur, c.risk_pct])
  if (data === undefined) return <p className="note">Caricamento…</p>
  if (data === null) return <NotOwner />
  const enabled: string[] = c.enabled ?? ["brent", "wti", "oro", "usatech", "germany40", "eurusd"]
  async function analyze() {
    setBusy(true); setMsg("")
    try { const r: any = await run({}); setMsg(r.errors?.length ? `Analisi fatta, con avvisi: ${r.errors.join(" · ")}` : "Analisi aggiornata.") }
    catch (e: any) { setMsg(e?.message ?? "Errore") } finally { setBusy(false) }
  }
  async function save(patch: any) {
    setMsg("")
    try { await saveCfg({ patch: JSON.stringify(patch) }); setMsg("Salvato. Vale dalla prossima analisi.") } catch (e: any) { setMsg(e?.message ?? "Errore") }
  }
  const sigs: any[] = V.signals ?? []
  const active = sigs.filter((s) => s.side === "LONG" || s.side === "SHORT")
  return (
    <section className="view split">
      <article className="panel span2">
        <div className="ph"><h2>Segnali Plus500</h2><span className="eyebrow">{V.generated_at ? `analisi ${when(V.generated_at)} (${ago(V.generated_at)})` : "nessuna analisi ancora"}</span></div>
        <div className="row">
          <button onClick={() => void analyze()} disabled={busy}>{busy ? "Analizzo…" : "Analizza adesso"}</button>
        </div>
        {msg && <p className="note">{msg}</p>}
        {(V.errors ?? []).map((e: string) => <div key={e} className="banner err">{e}</div>)}
        {active.length ? active.map((s) => <P500Card key={s.id} s={s} min={c.min_score} />) : <p className="empty">{V.generated_at ? "Nessun ingresso valido adesso: il desk aspetta un'occasione pulita. Meglio nessuna operazione che una cattiva." : "Premi \"Analizza adesso\" per la prima analisi; poi gira da solo ogni 30 minuti."}</p>}
      </article>
      <TelegramLink ready={data.telegram} hasToken={data.telegramToken} />
      <article className="panel">
        <div className="ph"><h2>Segnali in corso</h2><span className="eyebrow">li seguo io e ti avviso</span></div>
        {(V.ideas ?? []).length ? V.ideas.map((i: any) => (
          <div className="pos" key={i.id}>
            <div className="row between"><b>{P500_LIST.find(([k]) => k === i.id)?.[1] ?? i.id}</b><span className={`chip ${i.side === "LONG" ? "c-buy" : "c-avoid"}`}>{i.side === "LONG" ? "COMPRA" : "VENDI"}</span></div>
            <div className="rl num"><span>stop {fmtPx(i.stop)}{i.be ? " (pareggio)" : ""}</span><span>ingresso {fmtPx(i.entry)}</span><span>limite {fmtPx(i.target)}</span></div>
          </div>
        )) : <p className="empty">Nessun segnale aperto.</p>}
      </article>
      <article className="panel">
        <div className="ph"><h2>Il tuo conto Plus500</h2><span className="eyebrow">per calcolare quanto aprire</span></div>
        <div className="form">
          <label htmlFor="cap">Capitale sul conto (€)</label>
          <input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          <label htmlFor="risk">Rischio per operazione (% del capitale, max 2)</label>
          <input id="risk" inputMode="decimal" value={risk} onChange={(e) => setRisk(e.target.value)} />
          <button className="ghost" onClick={() => void save({ capital_eur: Number(cap.replace(",", ".")), risk_pct: Number(risk.replace(",", ".")) })}>Salva</button>
        </div>
        <p className="note">Con {fmtEur(c.capital_eur)} e {c.risk_pct ?? "—"}% rischi al massimo {fmtEur((c.capital_eur * c.risk_pct) / 100)} per operazione se scatta lo stop. Margine massimo per operazione {c.max_margin_pct ?? 25}% del capitale.</p>
      </article>
      <article className="panel span2">
        <div className="ph"><h2>Strumenti seguiti</h2><span className="eyebrow">tocca per attivare o togliere</span></div>
        <div className="filters">
          {P500_LIST.map(([id, name]) => {
            const on = enabled.includes(id)
            return <button key={id} className="fbtn" aria-pressed={on} onClick={() => void save({ enabled: on ? enabled.filter((x) => x !== id) : [...enabled, id] })}>{name}</button>
          })}
        </div>
        <div className="tw"><table><tbody>
          {sigs.length ? sigs.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td className="r num">{fmtPx(s.price)}</td>
              <td><span className={`chip ${s.side === "LONG" ? "c-buy" : s.side === "SHORT" ? "c-avoid" : "c-wait"}`}>{s.side === "LONG" ? "COMPRA" : s.side === "SHORT" ? "VENDI" : s.side}</span></td>
              <td className="r num muted">rialzo {s.long_score} · ribasso {s.short_score}</td></tr>
          )) : <tr><td className="empty">Nessuna analisi ancora.</td></tr>}
        </tbody></table></div>
      </article>
      <article className="panel span2">
        <div className="ph"><h2>Storico avvisi</h2></div>
        <ol className="log">
          {(V.log ?? []).length ? V.log.map((l: any, i: number) => <li key={i} className={l.level === "loss" ? "error" : l.level === "win" ? "info" : ""}><time>{when(l.t)}</time><div><span className="txt">{l.text}</span></div></li>)
            : <li><span /><span className="empty">Nessun avviso ancora.</span></li>}
        </ol>
        <p className="note">Regole: candele 4h chiuse, si entra solo a favore del trend (EMA50/EMA200) dopo una correzione, quando RSI e MACD ripartono. Stop {c.stop_atr ?? 3}× ATR, limite {c.tp_atr ?? 4}× ATR, stop a pareggio dopo {c.breakeven_atr ?? 2}× ATR. Dati: futures e cambi pubblici (Yahoo Finance), i prezzi Plus500 possono differire di poco: usa i livelli come riferimento e controlla lo spread.</p>
      </article>
    </section>
  )
}

function P500Card({ s, min }: { s: any; min: number }) {
  const long = s.side === "LONG"
  return (
    <div className="sig">
      <div><span className="sym">{s.name}</span> <span className="px num">{fmtPx(s.price)}</span></div>
      <div><span className={`chip ${long ? "c-buy" : "c-avoid"}`}>{long ? "COMPRA" : "VENDI"}</span> <span className="num">{s.score}</span></div>
      <div className="bar" aria-label={`punteggio ${s.score} su 100`}><span style={{ width: `${s.score}%` }} /><em style={{ left: `${min ?? 80}%` }} /></div>
      <div className="meta full"><span>Stop Loss <b className="num">{fmtPx(s.stop)}</b></span><span>Take Profit <b className="num">{fmtPx(s.target)}</b></span><span>RSI <b className="num">{s.ind?.rsi?.toFixed(0) ?? "—"}</b></span></div>
      {s.plan && <div className="meta full"><span>Valore posizione ≈ <b className="num">{fmtEur(s.plan.exposure_eur)}</b></span><span>margine ≈ <b className="num">{fmtEur(s.plan.margin_eur)}</b></span><span>se stop <b className="num down">−{fmtEur(s.plan.risk_eur)}</b></span><span>se limite <b className="num up">+{fmtEur(s.plan.reward_eur)}</b></span></div>}
      <ul className="why">{(s.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
      <p className="why flat">Su Plus500: {long ? "Compra" : "Vendi"} {s.name}, imposta l'importo vicino a {fmtEur(s.plan?.exposure_eur)} di valore, Stop Loss {fmtPx(s.stop)}, Take Profit {fmtPx(s.target)}.</p>
    </div>
  )
}

function TelegramLink({ ready, hasToken }: { ready: boolean; hasToken: boolean }) {
  const setToken = useAction(api.desk.telegramSetToken)
  const link = useAction(api.desk.telegramLink)
  const test = useAction(api.desk.telegramTest)
  const [token, setTok] = useState("")
  const [bot, setBot] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const [redo, setRedo] = useState(false)
  async function go(f: () => Promise<any>, ok: (r: any) => string) {
    setBusy(true); setMsg("")
    try { setMsg(ok(await f())) } catch (e: any) { setMsg(String(e?.message ?? e).replace(/^.*Uncaught Error: /, "").split("\n")[0]) } finally { setBusy(false) }
  }
  if (ready && !redo) return (
    <article className="panel span2">
      <div className="ph"><h2>Avvisi Telegram</h2><span className="chip c-buy">collegato</span></div>
      <div className="row">
        <button className="ghost" disabled={busy} onClick={() => void go(() => test({}), () => "Messaggio di prova inviato: controlla Telegram.")}>Manda una prova</button>
        <button className="link" onClick={() => setRedo(true)}>Ricollega</button>
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
    </article>
  )
  const step2 = hasToken || !!bot
  return (
    <article className="panel span2">
      <div className="ph"><h2>Collega Telegram</h2><span className="eyebrow">2 minuti · così i segnali ti arrivano sul telefono</span></div>
      <ol className="steps">
        <li><b>Crea il tuo bot.</b> Apri <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, premi Avvia, scrivi <code>/newbot</code>, scegli un nome (es. Wolf Street) e un nome utente che finisce con <code>bot</code>. BotFather ti risponde con un <b>token</b>: tienilo premuto e copialo.</li>
        <li><b>Incollalo qui.</b>
          <div className="row"><input type="password" autoComplete="off" placeholder="123456789:AA…" value={token} onChange={(e) => setTok(e.target.value)} />
            <button disabled={busy || !token.trim()} onClick={() => void go(() => setToken({ token }), (r) => { setBot(r.bot); setTok(""); return `Token giusto: il tuo bot è @${r.bot}.` })}>Salva</button></div>
          {hasToken && !bot && <span className="note">Token già salvato.</span>}
        </li>
        <li><b>Scrivi al bot.</b> {bot ? <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">Apri @{bot}</a> : "Apri il tuo bot su Telegram"} e premi <b>AVVIA</b> (o scrivi "ciao").</li>
        <li><b>Collega.</b> <button disabled={busy || !step2} onClick={() => void go(() => link({}), (r) => { setRedo(false); return `Collegato${r.name ? ", " + r.name : ""}! Ti ho mandato un messaggio di prova.` })}>{busy ? "Attendi…" : "Collega Telegram"}</button></li>
      </ol>
      {msg && <p className="note" role="status">{msg}</p>}
      <p className="note">Il token resta cifrato sul server e non viene mai mostrato. Non mandarlo in chat a nessuno.</p>
    </article>
  )
}

// ------------------------------------------------------------------ sala operativa (dati veri sugli schermi)
const ROOM_BG = "https://assets.macaly-user-data.dev/yi9n8qni1n5wrdwaqp51ks67/vu9nhwmqkga5erx4wfgq55x2/q29Oxqy2XP3b9boyrtn1z/desk-room-oR4ntGYi.webp"
const ROOM_BG_SM = "https://assets.macaly-user-data.dev/yi9n8qni1n5wrdwaqp51ks67/vu9nhwmqkga5erx4wfgq55x2/u7FdmBDowrpAajmPHN3Vv/desk-room-sm-Tk8rGbKc.webp"

function useNow(ms = 1000) {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setN(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return n
}

function Spark({ pts }: { pts: [number, number][] }) {
  if (!pts || pts.length < 2) return <svg className="rspark" viewBox="0 0 100 30" aria-hidden="true"><line x1="0" x2="100" y1="15" y2="15" /></svg>
  const v = pts.map((p) => p[1]), lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1
  const d = v.map((y, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * 100).toFixed(1)} ${(28 - ((y - lo) / r) * 26).toFixed(1)}`).join("")
  return <svg className="rspark" viewBox="0 0 100 30" aria-hidden="true"><path d={d} className={v[v.length - 1] >= v[0] ? "u" : "d"} /></svg>
}

function Room({ D }: { D: any }) {
  const now = useNow()
  const sigs: any[] = D.signals ?? []
  const btc = sigs.find((s) => s.symbol === "BTC-EUR") ?? sigs[0]
  const pos: any[] = D.positions ?? []
  const k = D.kpi ?? {}
  const live = String(D.mode) === "live"
  const stopped = D.kill_switch || D.paused
  const next = D.generated_at ? D.generated_at + 1800 - Math.floor(now / 1000) : null
  const mm = next != null && next > 0 ? `${Math.floor(next / 60)}:${String(next % 60).padStart(2, "0")}` : "in corso"
  const phase = Math.floor(now / 2600) % 4
  const steps = ["Analizza", "Pianifica", "Esegue", "Controlla"]
  const best = sigs.slice().sort((a, b) => b.score - a.score)[0]
  const say = D.kill_switch ? "Kill switch: tutto fermo" : D.paused ? "In pausa: niente nuovi acquisti"
    : pos.length ? `Sorveglio ${pos.map((p) => p.symbol.split("-")[0]).join(", ")}: stop e target attivi`
    : best ? `Studio ${best.symbol.split("-")[0]}: ${best.score}/100` : "Pronto"
  return (
    <figure className="room" aria-label="Sala operativa: i bot al lavoro con i dati reali del conto">
      <picture>
        <source media="(max-width: 700px)" srcSet={ROOM_BG_SM} />
        <img src={ROOM_BG} alt="" className="room-bg" />
      </picture>
      <div className="rscreen s1">
        <div className="rhead"><b>{btc?.symbol?.replace("-", "/") ?? "BTC/EUR"}</b><span className="live-dot" /></div>
        <div className="rbig num">{btc ? fmtPx(btc.live_price ?? btc.price) : "—"} €</div>
        <div className={`num rsmall ${tone(btc?.change_24h_pct)}`}>{btc?.change_24h_pct != null ? fmtPct(btc.change_24h_pct) + " 24h" : " "}</div>
        <ul className="rlist">{sigs.map((s) => <li key={s.symbol}><span>{s.symbol.split("-")[0]}</span><span className="num">{s.score}</span><span className={s.action === "COMPRA" ? "up" : s.action === "EVITA" ? "down" : "muted"}>{s.action}</span></li>)}</ul>
      </div>
      <div className="rscreen s2">
        <div className="rhead"><b>WOLF STREET</b><span className={`rmode ${live ? "on" : ""}`}>{live ? "LIVE · soldi veri" : String(D.mode ?? "—").toUpperCase()}</span></div>
        <ol className="rsteps">{steps.map((t, i) => <li key={t} className={!stopped && i === phase ? "act" : ""}>{t}</li>)}</ol>
        <Spark pts={D.equity ?? []} />
        <div className="rrow num"><span>Patrimonio</span><b>{fmtEur(k.equity)}</b></div>
        <div className="rrow num"><span>Prossimo turno</span><b>{stopped ? "—" : mm}</b></div>
      </div>
      <div className="rscreen s3">
        <div className="rhead"><b>POSIZIONI</b><span className="num">{pos.length}/2</span></div>
        {pos.length ? pos.map((p) => (
          <div key={p.symbol} className="rpos">
            <div className="rrow"><b>{p.symbol.split("-")[0]}</b><b className={`num ${tone(p.pnl)}`}>{fmtEur(p.pnl, true)}</b></div>
            <div className="rrow num rsmall"><span>entrata</span><span>{fmtPx(p.entry)}</span></div>
            <div className="rrow num rsmall"><span>ora</span><span>{fmtPx(p.price)}</span></div>
            <div className="rrow num rsmall down"><span>stop</span><span>{fmtPx(Math.round(p.stop))}</span></div>
            <div className="rrow num rsmall up"><span>target</span><span>{fmtPx(Math.round(p.tp))}</span></div>
          </div>
        )) : <p className="rsmall muted">Nessuna posizione: attendo un segnale pulito.</p>}
        <div className="rrow num rsmall"><span>Liquidità</span><span>{fmtEur(D.balances?.EUR?.available ?? k.cash)}</span></div>
      </div>
      <div className="rsign"><span>WOLF STREET</span><span>CAPITAL</span></div>
      <figcaption className={`rbubble ${stopped ? "off" : ""}`}><span className="typing" aria-hidden="true"><i /><i /><i /></span>{say}</figcaption>
    </figure>
  )
}

// ------------------------------------------------------------------ sala operativa 3D (solo dati veri del backend)
function Sala({ D }: { D: any }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tagsRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<any>(D)
  dataRef.current = D
  const [err, setErr] = useState("")
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    let stop: (() => void) | undefined, alive = true
    import("../components/sala3d")
      .then((m) => { if (alive && canvasRef.current && tagsRef.current) stop = m.mountSala(canvasRef.current, tagsRef.current, () => dataRef.current) })
      .catch(() => setErr("La grafica 3D non si è caricata su questo dispositivo. Lo stato dei bot resta qui sotto."))
    return () => { alive = false; stop?.() }
  }, [])
  const S = salaState(D, now)
  const nextView = () => { if (canvasRef.current) canvasRef.current.dispatchEvent(new MouseEvent("dblclick")) }
  const log = (D?.log ?? []).filter((l: any) => (ROLE_IDS as readonly string[]).includes(l.bot)).slice(0, 10)
  const modeCls = !S.connected ? "off" : S.killSwitch ? "bad" : S.liveConfirmed ? "live" : "idle"
  return (
    <section className="view split">
      <article className="panel span2 sala-wrap">
        <div className="ph"><h2>Sala operativa</h2><button className="ghost" onClick={nextView}>Cambia vista</button></div>
        <div className="sala-status" role="status">
          <span className={`sala-mode ${modeCls}`}>{S.modeLabel}</span>
          <span>Ultimo turno: <b>{S.turnAt ? `${when(S.turnAt)} · ${Math.round((S.ageS ?? 0) / 60)} min fa` : "nessuno"}</b></span>
          <span>Prossimo turno: <b>{S.connected ? fmtWait(S.nextInS) : "—"}</b></span>
          {!S.connected && <span className="sala-reason">{S.reason}</span>}
        </div>
        <div className="sala-stage">
          <canvas ref={canvasRef} className="sala-canvas" aria-label="Sala operativa 3D: le quattro postazioni del desk. Lo stato di ogni bot è scritto anche nelle schede qui sotto." />
          <div ref={tagsRef} className="sala-tags" aria-hidden="true" />
          <span className="sala-hint">Trascina per girare · pizzica per avvicinarti · doppio tocco cambia vista</span>
          {err && <p className="banner err sala-err">{err}</p>}
        </div>
        <ul className="sala-roles" aria-live="polite" aria-label="Stato dei bot">
          {ROLE_IDS.map((id) => {
            const r = S.roles[id], e = r.turnEntries[0] ?? null
            return (
              <li key={id} className={`sala-role ${id}`} data-status={r.status}>
                <div className="sala-role-h"><b>{ROLE_INFO[id].title}</b><span className="sala-pill">{r.status}</span></div>
                <p className="sala-job">{ROLE_INFO[id].job}</p>
                <p className="sala-say">
                  {!S.connected ? "Non connesso: nessun dato recente dal desk."
                    : e ? <><time>{when(e.t)}</time> {e.text}</>
                    : "Nessuna voce in questo turno."}
                </p>
                {S.connected && r.turnEntries.length > 1 && <p className="sala-more">+{r.turnEntries.length - 1} altre voci nel turno</p>}
              </li>
            )
          })}
        </ul>
        <p className="note">Ogni movimento, schermo e fumetto viene dal registro reale dell'ultimo turno: i bot si animano solo quando arriva un turno nuovo e fanno solo ciò che il registro dice. Senza dati recenti la sala resta ferma e segna «non connesso». La sala non può comprare, vendere o cambiare regole.</p>
      </article>
      <article className="panel span2">
        <div className="ph"><h2>Cosa dicono i bot</h2><span className="eyebrow">registro reale</span></div>
        <ol className="log">
          {log.length ? log.map((l: any, i: number) => <li key={i} className={l.level}><time>{when(l.t)}</time><div><span className={`who ${l.bot}`}>{l.bot}</span> <span className="txt">{l.text}</span></div></li>)
            : <li><span /><span className="empty">Nessuna voce ancora.</span></li>}
        </ol>
      </article>
    </section>
  )
}
