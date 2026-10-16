// Sala operativa 3D: quattro bot (Analista, Risk, Trader, Sistema) alle loro scrivanie.
// Gli schermi e i fumetti usano i dati veri dell'ultimo turno del desk; i movimenti sono animazione.
import * as THREE from "three"

type D = any
const GOLD = 0xe8be5c
const ROLES = [
  { id: "ANALISTA", color: 0x7fb8ff, angle: -2.35 },
  { id: "RISK", color: 0xff9b6a, angle: -0.8 },
  { id: "TRADER", color: 0x4fd394, angle: 0.8 },
  { id: "SISTEMA", color: GOLD, angle: 2.35 },
] as const

const fmt = (n: unknown, d = 0) => {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—"
}

/** Turni reali ogni 30 minuti ai minuti :17 e :47 UTC. */
export function secondsToNextTurn(): number {
  const now = new Date(), t = new Date(now)
  t.setUTCSeconds(0, 0)
  const m = now.getUTCMinutes()
  if (m < 17) t.setUTCMinutes(17)
  else if (m < 47) t.setUTCMinutes(47)
  else { t.setUTCHours(t.getUTCHours() + 1); t.setUTCMinutes(17) }
  return Math.max(0, Math.round((t.getTime() - now.getTime()) / 1000))
}

/** Ultima frase vera di ogni bot, dal registro del desk (più recente per prima). */
function lastSay(d: D, bot: string): string {
  const l = (d?.log ?? []).find((x: any) => x.bot === bot)
  return l ? String(l.text) : ""
}

export function mountSala(canvas: HTMLCanvasElement, tagsEl: HTMLElement, getData: () => D): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputEncoding = THREE.sRGBEncoding
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x07080b, 22, 60)
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)

  scene.add(new THREE.HemisphereLight(0x8a90a8, 0x0a0a0c, 0.55))
  const key = new THREE.SpotLight(0xffe2a8, 1.4, 40, Math.PI / 4.5, 0.5, 1.2)
  key.position.set(4, 12, 6); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key)
  const rim = new THREE.PointLight(GOLD, 1.2, 18); rim.position.set(0, 3, -6); scene.add(rim)

  const fc = document.createElement("canvas"); fc.width = fc.height = 512
  const fg = fc.getContext("2d")!
  fg.fillStyle = "#0c0d11"; fg.fillRect(0, 0, 512, 512)
  for (let i = 0; i < 260; i++) {
    const r = (k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1 * 512 // venature fisse, niente casualità
    fg.strokeStyle = `rgba(255,255,255,${(r(9) / 512) * 0.025})`; fg.beginPath(); fg.moveTo(r(1), r(2))
    fg.bezierCurveTo(r(3), r(4), r(5), r(6), r(7), r(8)); fg.stroke()
  }
  fg.strokeStyle = "rgba(232,190,92,.16)"; fg.lineWidth = 2; fg.strokeRect(0, 0, 512, 512)
  const floorTex = new THREE.CanvasTexture(fc); floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(6, 6)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.35, metalness: 0.4 }))
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9.2, 0.04, 8, 160), new THREE.MeshBasicMaterial({ color: GOLD }))
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.02; scene.add(ring)

  // ---------------- schermi ----------------
  type Draw = (g: CanvasRenderingContext2D, W: number, H: number, t: number, d: D) => void
  function screen(w: number, h: number, draw: Draw) {
    const c = document.createElement("canvas"); c.width = 512; c.height = Math.round((512 * h) / w)
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true }))
    return { mesh, redraw: (t: number, d: D) => { draw(c.getContext("2d")!, c.width, c.height, t, d); tex.needsUpdate = true } }
  }
  function frame(g: CanvasRenderingContext2D, W: number, H: number, title: string, color: string) {
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, "#0d1a2e"); grd.addColorStop(1, "#060b14")
    g.fillStyle = grd; g.fillRect(0, 0, W, H)
    g.fillStyle = color; g.font = "600 22px IBM Plex Mono, monospace"; g.fillText(title, 18, 34)
    g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(18, 46, W - 36, 2)
  }
  const DRAW: Record<string, Draw> = {
    ANALISTA: (g, W, H, t, d) => {
      frame(g, W, H, "ANALISTA · candele 4h", "#7fb8ff")
      const min = Number(d?.config?.min_score ?? 80)
      ;(d?.signals ?? []).slice(0, 4).forEach((s: any, i: number) => {
        const y = 80 + i * 52, sc = Number(s.score ?? 0)
        g.fillStyle = "#cfd6e6"; g.font = "500 22px IBM Plex Mono, monospace"; g.fillText(String(s.symbol).split("-")[0], 18, y + 18)
        g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(92, y, 300, 22)
        const sweep = reduce ? 1 : Math.min(1, (t * 0.4 + i * 0.15) % 1.6)
        g.fillStyle = s.action === "COMPRA" ? "#4fd394" : s.action === "EVITA" ? "#f06a6a" : "#9aa3b5"; g.fillRect(92, y, (300 * sc / 100) * sweep, 22)
        g.fillStyle = "#e8be5c"; g.fillRect(92 + (300 * min) / 100, y - 4, 3, 30)
        g.fillStyle = "#ece6d6"; g.fillText(String(sc), 408, y + 18)
      })
      if (!(d?.signals ?? []).length) { g.fillStyle = "#9aa3b5"; g.font = "400 20px IBM Plex Mono, monospace"; g.fillText("in attesa del primo turno", 18, 100) }
    },
    RISK: (g, W, H, t, d) => {
      frame(g, W, H, "RISK · limiti", "#ff9b6a")
      const c = d?.config ?? {}, k = d?.kpi ?? {}, npos = (d?.positions ?? []).length
      const dd = Number(k.max_dd_pct ?? 0), ddLim = Number(c.max_drawdown_pct ?? 15)
      const dayLoss = Math.max(0, -Number(k.pnl_today ?? 0)), weekLoss = Math.max(0, -Number(k.pnl_week ?? 0))
      const rows: [string, string, number][] = [
        ["rischio/op.", `${fmt(c.risk_per_trade_eur, 2)} €`, 0.3],
        ["perso oggi", `${fmt(dayLoss, 2)}/${fmt(c.daily_loss_limit_eur)} €`, dayLoss / Math.max(0.01, Number(c.daily_loss_limit_eur ?? 1))],
        ["perso sett.", `${fmt(weekLoss, 2)}/${fmt(c.weekly_loss_limit_eur)} €`, weekLoss / Math.max(0.01, Number(c.weekly_loss_limit_eur ?? 1))],
        ["calo", `${fmt(dd, 2)}%`, dd / ddLim],
        ["posizioni", `${npos}/${c.max_open_positions ?? 2}`, npos / Number(c.max_open_positions ?? 2)],
      ]
      rows.forEach(([lab, v, f], i) => {
        const y = 78 + i * 42
        g.fillStyle = "#9aa3b5"; g.font = "400 19px IBM Plex Mono, monospace"; g.fillText(lab, 18, y + 16)
        g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(190, y + 2, 170, 16)
        g.fillStyle = f > 0.7 ? "#f06a6a" : "#4fd394"; g.fillRect(190, y + 2, Math.max(4, 170 * Math.min(1, f)), 16)
        g.fillStyle = "#ece6d6"; g.fillText(v, 372, y + 16)
      })
      const ok = !d?.paused && !d?.kill_switch
      g.fillStyle = ok ? (Math.sin(t * 3) > 0 || reduce ? "#4fd394" : "#2b6e4f") : "#f06a6a"
      g.font = "600 20px IBM Plex Mono, monospace"; g.fillText(ok ? "● TUTTO NEI LIMITI" : "● IN PAUSA", 18, H - 18)
    },
    TRADER: (g, W, H, t, d) => {
      const p = (d?.positions ?? [])[0], btc = (d?.signals ?? []).find((s: any) => s.symbol === "BTC-EUR")
      frame(g, W, H, p ? `TRADER · ${String(p.symbol).replace("-", "/")}` : "TRADER · nessuna posizione", "#4fd394")
      const price = Number(p?.price ?? btc?.live_price ?? btc?.price)
      g.fillStyle = "#ece6d6"; g.font = "600 46px IBM Plex Mono, monospace"; g.fillText(`${fmt(price)} €`, 18, 110)
      if (!p) { g.fillStyle = "#9aa3b5"; g.font = "400 20px IBM Plex Mono, monospace"; g.fillText("attendo un segnale pulito", 18, 150); return }
      const pct = Number(p.pnl_pct ?? 0)
      g.fillStyle = pct >= 0 ? "#4fd394" : "#f06a6a"; g.font = "500 22px IBM Plex Mono, monospace"
      g.fillText(`${pct >= 0 ? "+" : ""}${fmt(pct, 2)}% · ${pct >= 0 ? "+" : ""}${fmt(p.pnl, 2)} €`, 18, 144)
      const x0 = 18, x1 = W - 18, y = 200, span = p.tp - p.stop || 1
      const at = (v: number) => x0 + ((x1 - x0) * Math.max(0, Math.min(1, (v - p.stop) / span)))
      g.fillStyle = "rgba(240,106,106,.35)"; g.fillRect(x0, y, at(p.entry) - x0, 14)
      g.fillStyle = "rgba(79,211,148,.35)"; g.fillRect(at(p.entry), y, x1 - at(p.entry), 14)
      g.fillStyle = "#e8be5c"; g.fillRect(at(p.entry) - 1, y - 8, 3, 30)
      g.fillStyle = "#ffffff"; g.beginPath(); g.arc(at(price), y + 7, 9 + (reduce ? 0 : Math.sin(t * 4) * 2), 0, 7); g.fill()
      g.font = "400 17px IBM Plex Mono, monospace"; g.fillStyle = "#f06a6a"; g.fillText(`stop ${fmt(p.stop)}`, x0, y + 44)
      g.fillStyle = "#4fd394"; const tl = `target ${fmt(p.tp)}`; g.fillText(tl, x1 - g.measureText(tl).width, y + 44)
    },
    SISTEMA: (g, W, H, _t, d) => {
      frame(g, W, H, "SISTEMA · Revolut X", "#e8be5c")
      const live = String(d?.mode) === "live"
      g.fillStyle = live ? "#e8be5c" : "#9aa3b5"; g.font = "700 34px IBM Plex Mono, monospace"
      g.fillText(d?.kill_switch ? "KILL SWITCH" : live ? "LIVE · ARMATO" : String(d?.mode ?? "—").toUpperCase(), 18, 104)
      const s = secondsToNextTurn()
      g.fillStyle = "#ece6d6"; g.font = "500 24px IBM Plex Mono, monospace"; g.fillText(`prossimo turno ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, 18, 150)
      g.fillStyle = "#9aa3b5"; g.font = "400 19px IBM Plex Mono, monospace"
      g.fillText(`patrimonio ${fmt(d?.kpi?.equity, 2)} €`, 18, 192)
      g.fillText(`liquidità  ${fmt(d?.balances?.EUR?.available ?? d?.kpi?.cash, 2)} €`, 18, 222)
      g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(18, 244, W - 36, 10)
      g.fillStyle = "#e8be5c"; g.fillRect(18, 244, (W - 36) * (1 - s / 1800), 10)
    },
  }

  // ---------------- postazioni e bot ----------------
  const R = 6.2
  const metal = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.3, metalness: 0.85 })
  const goldMat = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.25, metalness: 1, emissive: 0x3a2a05 })
  const stations = ROLES.map((r) => {
    const g = new THREE.Group()
    const x = Math.sin(r.angle) * R, z = -Math.cos(r.angle) * R
    g.position.set(x, 0, z); g.lookAt(0, 0, 0)
    const desk = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 1.4), metal); desk.position.set(0, 1.05, 0); desk.castShadow = desk.receiveShadow = true; g.add(desk)
    const edge = new THREE.Mesh(new THREE.BoxGeometry(3.22, 0.03, 0.03), goldMat); edge.position.set(0, 1.11, 0.7); g.add(edge)
    ;[-1.4, 1.4].forEach((lx) => { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 1.2), metal); leg.position.set(lx, 0.5, 0); leg.castShadow = true; g.add(leg) })
    const scr = screen(2.4, 1.35, DRAW[r.id]); scr.mesh.position.set(0, 2.05, -0.45); scr.mesh.rotation.x = -0.08; g.add(scr.mesh)
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(2.52, 1.47, 0.06), metal); bezel.position.set(0, 2.05, -0.49); bezel.rotation.x = -0.08; g.add(bezel)
    const glow = new THREE.PointLight(r.color, 0.7, 4); glow.position.set(0, 2, 0.3); g.add(glow)
    scene.add(g)
    return { ...r, group: g, screen: scr, seat: new THREE.Vector3(x * 0.78, 0, z * 0.78) }
  })

  function makeBot(color: number) {
    const b = new THREE.Group()
    const white = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.35, metalness: 0.2 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.2, metalness: 0.6 })
    const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 })
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.95, 24), white); body.position.y = 1.0; body.castShadow = true; b.add(body)
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.035, 8, 32), accent); belt.rotation.x = Math.PI / 2; belt.position.y = 0.78; b.add(belt)
    const head = new THREE.Group(); head.position.y = 1.85; b.add(head)
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), white); skull.castShadow = true; head.add(skull)
    const eyes = [-0.12, 0.12].map((ex) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), accent); e.position.set(ex, 0.03, 0.4); head.add(e); return e })
    ;[-0.43, 0.43].forEach((ex) => { const e = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 16), accent); e.rotation.z = Math.PI / 2; e.position.x = ex; head.add(e) })
    const arms = [-0.55, 0.55].map((ax) => {
      const a = new THREE.Group(); a.position.set(ax, 1.3, 0)
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.5, 6, 12), white); m.position.y = -0.3; m.castShadow = true; a.add(m); b.add(a); return a
    })
    const legs = [-0.2, 0.2].map((lx) => { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.5, 12), dark); l.position.set(lx, 0.27, 0); b.add(l); return l })
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.62, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }))
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; b.add(halo)
    return { root: b, head, eyes, arms, legs, halo }
  }

  const bots = stations.map((s) => {
    const m = makeBot(s.color); m.root.position.copy(s.seat); scene.add(m.root)
    const tag = document.createElement("div"); tag.className = "sala-tag"; tag.innerHTML = `${s.id}<i></i>`; tagsEl.appendChild(tag)
    return { st: s, m, tag, pos: s.seat.clone(), target: s.seat.clone(), walk: 0, sayT: 0, typing: 0 }
  })
  const B = Object.fromEntries(bots.map((b) => [b.st.id, b]))

  // ologramma centrale
  const holo = new THREE.Group(); holo.position.y = 2.2; scene.add(holo)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.25, 48), metal); base.position.y = -2.08; holo.add(base)
  const baseGlow = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.03, 8, 80), goldMat); baseGlow.rotation.x = Math.PI / 2; baseGlow.position.y = -1.95; holo.add(baseGlow)
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 3.2, 48, 1, true), new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.05, side: THREE.DoubleSide })); beam.position.y = -0.3; holo.add(beam)
  const candles = new THREE.Group(); holo.add(candles)
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2, h = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(i * 1.7) * Math.cos(i * 0.45))
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), new THREE.MeshBasicMaterial({ color: Math.sin(i * 2.3) > -0.2 ? 0x4fd394 : 0xf06a6a, transparent: true, opacity: 0.85 }))
    c.position.set(Math.cos(a) * 1.05, Math.sin(i * 0.6) * 0.35, Math.sin(a) * 1.05); candles.add(c)
  }
  const priceTag = screen(2.2, 0.55, (g, W, H, _t, d) => {
    g.clearRect(0, 0, W, H); g.fillStyle = "rgba(8,10,14,.75)"; g.fillRect(0, 0, W, H)
    const btc = (d?.signals ?? []).find((s: any) => s.symbol === "BTC-EUR")
    g.fillStyle = "#e8be5c"; g.font = "700 46px IBM Plex Mono, monospace"
    const txt = `BTC ${fmt(btc?.live_price ?? btc?.price)} €`; g.fillText(txt, (W - g.measureText(txt).width) / 2, 82)
  })
  priceTag.mesh.position.y = 1.0; holo.add(priceTag.mesh)

  // pacchetti di dati tra i bot
  const packets: { mesh: THREE.Mesh; from: any; to: any; t: number }[] = []
  const pGeo = new THREE.SphereGeometry(0.11, 16, 12)
  function sendPacket(from: any, to: any, color: number) {
    const mesh = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color })); mesh.add(new THREE.PointLight(color, 1, 3)); scene.add(mesh)
    packets.push({ mesh, from, to, t: 0 })
  }
  const headPos = (b: any) => b.pos.clone().add(new THREE.Vector3(0, 2.2, 0))

  // ciclo del turno: Analista → Risk → Trader (ologramma) → Sistema
  let phase = -1, phaseT = 0
  const speak = (b: any) => { b.sayT = 3.4 }
  function nextPhase() {
    phase = (phase + 1) % 6; phaseT = 0
    const A = B.ANALISTA, K = B.RISK, T = B.TRADER, S = B.SISTEMA
    if (phase === 0) { speak(A); A.typing = 2.5 }
    if (phase === 1) { sendPacket(A, K, 0x7fb8ff) }
    if (phase === 2) { speak(K); K.typing = 1.5; sendPacket(K, T, 0xff9b6a) }
    if (phase === 3) { speak(T); T.target.set(Math.sin(0.8) * 2.3, 0, -Math.cos(0.8) * 2.3) }
    if (phase === 4) { T.target.copy(T.st.seat); sendPacket(T, S, 0x4fd394) }
    if (phase === 5) { speak(S); S.typing = 2 }
  }

  // camera e controlli
  const views = [{ yaw: 0, pitch: 0.58, dist: 15 }, { yaw: 0.9, pitch: 0.25, dist: 11 }, { yaw: -1.2, pitch: 0.6, dist: 13 }, { yaw: Math.PI, pitch: 0.35, dist: 14 }]
  let vi = 0, fit = 1, idle = 0, dragging = false, last: [number, number] = [0, 0], pinch: number | null = null
  const cam = { ...views[0] }, goal = { ...views[0] }
  const onDown = (e: PointerEvent) => { dragging = true; last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); idle = 0 }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    goal.yaw -= (e.clientX - last[0]) * 0.006; goal.pitch = Math.min(1.25, Math.max(0.1, goal.pitch + (e.clientY - last[1]) * 0.004)); last = [e.clientX, e.clientY]
  }
  const onUp = () => { dragging = false }
  const onWheel = (e: WheelEvent) => { e.preventDefault(); goal.dist = Math.min(24, Math.max(7, goal.dist + e.deltaY * 0.01)); idle = 0 }
  const onTouch = (e: TouchEvent) => {
    if (e.touches.length !== 2) return
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    if (pinch) goal.dist = Math.min(24, Math.max(7, (goal.dist * pinch) / d)); pinch = d
  }
  const onTouchEnd = () => { pinch = null }
  canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp)
  canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("touchmove", onTouch, { passive: true }); canvas.addEventListener("touchend", onTouchEnd)
  const nextView = () => { vi = (vi + 1) % views.length; Object.assign(goal, views[vi]); idle = 0 }
  canvas.addEventListener("dblclick", nextView)

  function resize() {
    const r = canvas.getBoundingClientRect()
    renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix()
    fit = camera.aspect < 1.2 ? Math.min(2.4, 1.25 / camera.aspect) : 1
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

  const clock = new THREE.Clock()
  let screenT = 0, raf = 0
  const data0 = getData()
  stations.forEach((s) => s.screen.redraw(0, data0)); priceTag.redraw(0, data0)
  nextPhase()
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime, d = getData()
    idle += dt; if (!dragging && idle > 6 && !reduce) goal.yaw += dt * 0.06
    cam.yaw += (goal.yaw - cam.yaw) * 0.08; cam.pitch += (goal.pitch - cam.pitch) * 0.08; cam.dist += (goal.dist - cam.dist) * 0.08
    const D = cam.dist * fit
    camera.position.set(Math.sin(cam.yaw) * Math.cos(cam.pitch) * D, 1.4 + Math.sin(cam.pitch) * D, Math.cos(cam.yaw) * Math.cos(cam.pitch) * D)
    camera.lookAt(0, 1.4, 0)
    phaseT += dt; if (phaseT > 2.6) nextPhase()
    const rect = canvas.getBoundingClientRect()
    bots.forEach((b) => {
      const m = b.m, to = b.target.clone().sub(b.pos); to.y = 0
      const moving = to.length() > 0.05
      if (moving) { b.pos.add(to.clampLength(0, dt * 2.2)); b.walk += dt * 9; m.root.rotation.y = Math.atan2(to.x, to.z) }
      else { const look = new THREE.Vector3().subVectors(b.st.group.position, b.pos); m.root.rotation.y += (Math.atan2(look.x, look.z) - m.root.rotation.y) * 0.1 }
      m.root.position.set(b.pos.x, reduce ? 0 : Math.abs(Math.sin(b.walk)) * (moving ? 0.08 : 0) + Math.sin(t * 2 + b.st.angle) * 0.02, b.pos.z)
      m.legs[0].position.z = moving ? Math.sin(b.walk) * 0.12 : 0; m.legs[1].position.z = moving ? -Math.sin(b.walk) * 0.12 : 0
      b.typing = Math.max(0, b.typing - dt)
      const typ = b.typing > 0 && !reduce
      m.arms[0].rotation.x = typ ? -1.1 + Math.sin(t * 22) * 0.12 : moving ? Math.sin(b.walk) * 0.5 : -0.2
      m.arms[1].rotation.x = typ ? -1.1 + Math.cos(t * 22) * 0.12 : moving ? -Math.sin(b.walk) * 0.5 : -0.2
      m.head.rotation.y = typ ? Math.sin(t * 3) * 0.15 : Math.sin(t * 0.7 + b.st.angle) * 0.3
      const blink = Math.sin(t * 1.3 + b.st.angle * 3) > 0.985 ? 0.1 : 1; m.eyes.forEach((e) => (e.scale.y = blink))
      ;(m.halo.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(t * 3 + b.st.angle)
      b.sayT = Math.max(0, b.sayT - dt)
      const p = headPos(b).project(camera)
      b.tag.style.display = p.z < 1 ? "" : "none"
      b.tag.style.left = `${(p.x * 0.5 + 0.5) * rect.width}px`; b.tag.style.top = `${(-p.y * 0.5 + 0.5) * rect.height}px`
      const say = b.sayT > 0 ? lastSay(d, b.st.id) : ""
      ;(b.tag.lastChild as HTMLElement).textContent = say
      b.tag.classList.toggle("on", !!say)
    })
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i]; k.t += dt / 1.6
      const a = headPos(k.from), c = headPos(k.to), mid = a.clone().lerp(c, 0.5); mid.y += 2.2
      const u = Math.min(1, k.t)
      k.mesh.position.copy(a.multiplyScalar((1 - u) * (1 - u)).add(mid.multiplyScalar(2 * u * (1 - u))).add(c.multiplyScalar(u * u)))
      if (k.t >= 1) { scene.remove(k.mesh); packets.splice(i, 1); k.to.typing = 1.2 }
    }
    holo.rotation.y += reduce ? 0 : dt * 0.35
    candles.children.forEach((c, i) => { c.scale.y = reduce ? 1 : 0.85 + 0.15 * Math.sin(t * 2 + i) })
    priceTag.mesh.quaternion.copy(camera.quaternion).premultiply(holo.quaternion.clone().invert())
    rim.intensity = 1 + Math.sin(t * 1.5) * 0.3
    screenT += dt; if (screenT > 0.25) { screenT = 0; stations.forEach((s) => s.screen.redraw(t, d)); priceTag.redraw(t, d) }
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf); ro.disconnect()
    canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp)
    canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("touchmove", onTouch); canvas.removeEventListener("touchend", onTouchEnd)
    canvas.removeEventListener("dblclick", nextView)
    tagsEl.innerHTML = ""
    scene.traverse((o: any) => { o.geometry?.dispose?.(); const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; mats.forEach((mm: any) => { mm.map?.dispose?.(); mm.dispose?.() }) })
    renderer.dispose()
  }
}

/** Per il pulsante "Cambia vista" esterno: simula un doppio clic sulla tela. */
export function nextSalaView(canvas: HTMLCanvasElement) { canvas.dispatchEvent(new MouseEvent("dblclick")) }
