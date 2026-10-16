// Sala operativa 3D: le quattro postazioni del desk (Analista, Risk, Trader, Sistema).
// Ogni movimento nasce da un evento reale del backend: un nuovo turno e le voci del registro di quel turno.
// Tra un turno e l'altro i bot stanno fermi alla loro postazione. Senza dati la sala si spegne: "non connesso".
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js"
import { fmtWait, ROLE_INFO, salaState } from "./sala-state"
import type { RoleId, SalaState } from "./sala-state"

const HUMAN_URL = "https://assets.macaly-user-data.dev/yi9n8qni1n5wrdwaqp51ks67/vu9nhwmqkga5erx4wfgq55x2/eyQqA07Y-IQBBs0mOVim5/trader-human-PbjW_jnI.glb"
const GOLD = 0xe8be5c
const ROLES: { id: RoleId; color: number; suit: number; angle: number }[] = [
  // cinque postazioni su sei posti: nessuna dietro l'ologramma, il posto libero è davanti a destra
  { id: "SCOUT", color: 0x5fd3d3, suit: 0x16272a, angle: -2.6 },
  { id: "ANALISTA", color: 0x6fa8ff, suit: 0x1b2638, angle: -1.56 },
  { id: "VERIFICATORE", color: 0xb48cff, suit: 0x231c33, angle: -0.52 },
  { id: "RISK", color: 0xff8a5c, suit: 0x33221f, angle: 0.52 },
  { id: "TRADER", color: 0x45c98a, suit: 0x18291f, angle: 1.56 },
]
const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`
const fmt = (n: unknown, d = 0) => {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—"
}
const STATUS_LABEL: Record<string, string> = { attivo: "attivo in questo turno", "in attesa": "nessuna azione in questo turno", errore: "errore nel turno", "non connesso": "non connesso" }

export function mountSala(canvas: HTMLCanvasElement, tagsEl: HTMLElement, getData: () => any): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputEncoding = THREE.sRGBEncoding
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x07080b)
  scene.fog = new THREE.Fog(0x07080b, 20, 46)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)

  // ---------------- luci: calde, morbide, da ufficio di sera ----------------
  scene.add(new THREE.HemisphereLight(0x9aa2b8, 0x0a0a0c, 0.5))
  const key = new THREE.SpotLight(0xffe6b8, 1.3, 40, Math.PI / 4.2, 0.6, 1.2)
  key.position.set(3, 13, 6); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; scene.add(key)
  const fill = new THREE.DirectionalLight(0x8fa6ff, 0.25); fill.position.set(-8, 6, -4); scene.add(fill)

  // ---------------- ambiente ----------------
  const metal = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.35, metalness: 0.8, envMap: envTex, envMapIntensity: 0.25 })
  const walnut = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.55, metalness: 0.05 })
  const goldMat = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.25, metalness: 1, emissive: 0x3a2a05, envMap: envTex, envMapIntensity: 0.8 })
  const fc = document.createElement("canvas"); fc.width = fc.height = 512
  const fg = fc.getContext("2d")!
  fg.fillStyle = "#0b0c10"; fg.fillRect(0, 0, 512, 512)
  for (let i = 0; i < 220; i++) { // venature del marmo fisse (non casuali)
    const r = (k: number) => (((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) + 1) % 1 * 512
    fg.strokeStyle = `rgba(255,255,255,${(r(9) / 512) * 0.03})`; fg.beginPath(); fg.moveTo(r(1), r(2)); fg.bezierCurveTo(r(3), r(4), r(5), r(6), r(7), r(8)); fg.stroke()
  }
  fg.strokeStyle = "rgba(232,190,92,.12)"; fg.lineWidth = 2; fg.strokeRect(0, 0, 512, 512)
  const floorTex = new THREE.CanvasTexture(fc); floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(6, 6)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 72), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.3, metalness: 0.35, envMap: envTex, envMapIntensity: 0.15 }))
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9.2, 0.035, 8, 180), goldMat); ring.rotation.x = Math.PI / 2; ring.position.y = 0.02; scene.add(ring)
  // parete curva alle spalle delle postazioni, con una linea di luce
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 5, 96, 1, true, Math.PI * 0.62, Math.PI * 0.76), new THREE.MeshStandardMaterial({ color: 0x0e0f14, roughness: 0.8, metalness: 0.1, side: THREE.BackSide }))
  wall.position.y = 2.5; scene.add(wall)
  const strip = new THREE.Mesh(new THREE.CylinderGeometry(10.95, 10.95, 0.04, 96, 1, true, Math.PI * 0.62, Math.PI * 0.76), new THREE.MeshBasicMaterial({ color: GOLD, side: THREE.BackSide }))
  strip.position.y = 3.6; scene.add(strip)
  const wordC = document.createElement("canvas"); wordC.width = 1024; wordC.height = 128
  const wg = wordC.getContext("2d")!
  wg.fillStyle = "#e8be5c"; wg.font = "600 64px Georgia, serif"; wg.textAlign = "center"; wg.fillText("WOLF STREET CAPITAL", 512, 84)
  const wordTex = new THREE.CanvasTexture(wordC); wordTex.encoding = THREE.sRGBEncoding
  const word = new THREE.Mesh(new THREE.PlaneGeometry(6, 0.75), new THREE.MeshBasicMaterial({ map: wordTex, transparent: true, toneMapped: false }))
  word.position.set(0, 4.25, -10.6); scene.add(word)

  // ---------------- schermi ----------------
  type Draw = (g: CanvasRenderingContext2D, W: number, H: number, S: SalaState, d: any) => void
  function screen(w: number, h: number, draw: Draw) {
    const c = document.createElement("canvas"); c.width = 512; c.height = Math.round((512 * h) / w)
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true }))
    return { mesh, tex, redraw: (S: SalaState, d: any) => { draw(c.getContext("2d")!, c.width, c.height, S, d); tex.needsUpdate = true } }
  }
  function frame(g: CanvasRenderingContext2D, W: number, H: number, title: string, color: string) {
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, "#0c1626"); grd.addColorStop(1, "#060a12")
    g.fillStyle = grd; g.fillRect(0, 0, W, H)
    g.fillStyle = color; g.font = "600 22px IBM Plex Mono, monospace"; g.fillText(title, 18, 34)
    g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(18, 46, W - 36, 2)
  }
  function offline(g: CanvasRenderingContext2D, W: number, H: number, S: SalaState) {
    g.fillStyle = "#07090d"; g.fillRect(0, 50, W, H - 50)
    g.fillStyle = "#8a8f9a"; g.font = "600 30px IBM Plex Mono, monospace"; g.fillText("NON CONNESSO", 18, 120)
    g.font = "400 18px IBM Plex Mono, monospace"; g.fillText(S.reason.slice(0, 40), 18, 156)
  }
  const roleLine = (g: CanvasRenderingContext2D, S: SalaState, id: RoleId, y: number) => {
    const e = S.roles[id].turnEntries[0]
    g.fillStyle = "#9aa3b5"; g.font = "400 16px IBM Plex Mono, monospace"
    g.fillText((e ? e.text : "nessuna voce in questo turno").slice(0, 44), 18, y)
  }
  const DRAW: Record<RoleId, Draw> = {
    ANALISTA: (g, W, H, S, d) => {
      frame(g, W, H, "ANALISTA · candele 4h", "#6fa8ff"); if (!S.connected) return offline(g, W, H, S)
      const min = Number(d?.config?.min_score), sigs = (d?.signals ?? []).slice(0, 4)
      if (!sigs.length) { g.fillStyle = "#9aa3b5"; g.font = "400 20px IBM Plex Mono, monospace"; g.fillText("nessuna analisi in questo turno", 18, 100); return }
      sigs.forEach((s: any, i: number) => {
        const y = 70 + i * 46, sc = Number(s.score ?? 0)
        g.fillStyle = "#cfd6e6"; g.font = "500 21px IBM Plex Mono, monospace"; g.fillText(String(s.symbol).split("-")[0], 18, y + 18)
        g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(92, y, 300, 20)
        g.fillStyle = s.action === "COMPRA" ? "#45c98a" : s.action === "EVITA" ? "#e46a6a" : "#9aa3b5"; g.fillRect(92, y, (300 * Math.max(0, Math.min(100, sc))) / 100, 20)
        if (Number.isFinite(min)) { g.fillStyle = "#e8be5c"; g.fillRect(92 + (300 * min) / 100, y - 4, 3, 28) }
        g.fillStyle = "#ece6d6"; g.fillText(String(sc), 408, y + 18)
      })
      roleLine(g, S, "ANALISTA", H - 14)
    },
    RISK: (g, W, H, S, d) => {
      frame(g, W, H, "RISK · limiti", "#ff8a5c"); if (!S.connected) return offline(g, W, H, S)
      const c = d?.config ?? {}, k = d?.kpi ?? {}, npos = (d?.positions ?? []).length
      const rows: [string, string, number | null][] = [
        ["perso oggi", `${fmt(Math.max(0, -Number(k.pnl_today ?? NaN)), 2)} / ${fmt(c.daily_loss_limit_eur)} €`, Number(c.daily_loss_limit_eur) ? Math.max(0, -Number(k.pnl_today ?? 0)) / Number(c.daily_loss_limit_eur) : null],
        ["perso sett.", `${fmt(Math.max(0, -Number(k.pnl_week ?? NaN)), 2)} / ${fmt(c.weekly_loss_limit_eur)} €`, Number(c.weekly_loss_limit_eur) ? Math.max(0, -Number(k.pnl_week ?? 0)) / Number(c.weekly_loss_limit_eur) : null],
        ["calo", `${fmt(k.max_dd_pct, 2)} / ${fmt(c.max_drawdown_pct)} %`, Number(c.max_drawdown_pct) ? Number(k.max_dd_pct ?? 0) / Number(c.max_drawdown_pct) : null],
        ["posizioni", `${npos} / ${c.max_open_positions ?? "—"}`, Number(c.max_open_positions) ? npos / Number(c.max_open_positions) : null],
      ]
      rows.forEach(([lab, v, f], i) => {
        const y = 66 + i * 40
        g.fillStyle = "#9aa3b5"; g.font = "400 18px IBM Plex Mono, monospace"; g.fillText(lab, 18, y + 15)
        g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(170, y + 2, 150, 15)
        if (f !== null) { g.fillStyle = f > 0.7 ? "#e46a6a" : "#45c98a"; g.fillRect(170, y + 2, Math.max(3, 150 * Math.min(1, f)), 15) }
        g.fillStyle = "#ece6d6"; g.fillText(v, 332, y + 15)
      })
      roleLine(g, S, "RISK", H - 14)
    },
    TRADER: (g, W, H, S, d) => {
      const p = (d?.positions ?? [])[0]
      frame(g, W, H, p ? `TRADER · ${String(p.symbol).replace("-", "/")}` : "TRADER · nessuna posizione", "#45c98a"); if (!S.connected) return offline(g, W, H, S)
      if (!p) { roleLine(g, S, "TRADER", 100); return }
      g.fillStyle = "#ece6d6"; g.font = "600 42px IBM Plex Mono, monospace"; g.fillText(`${fmt(p.price)} €`, 18, 100)
      const pct = Number(p.pnl_pct)
      g.fillStyle = pct >= 0 ? "#45c98a" : "#e46a6a"; g.font = "500 20px IBM Plex Mono, monospace"
      g.fillText(`${pct >= 0 ? "+" : ""}${fmt(pct, 2)}% · ${Number(p.pnl) >= 0 ? "+" : ""}${fmt(p.pnl, 2)} €`, 18, 132)
      const x0 = 18, x1 = W - 18, y = 168, span = p.tp - p.stop || 1
      const at = (v: number) => x0 + (x1 - x0) * Math.max(0, Math.min(1, (v - p.stop) / span))
      g.fillStyle = "rgba(228,106,106,.35)"; g.fillRect(x0, y, at(p.entry) - x0, 12)
      g.fillStyle = "rgba(69,201,138,.35)"; g.fillRect(at(p.entry), y, x1 - at(p.entry), 12)
      g.fillStyle = "#e8be5c"; g.fillRect(at(p.entry) - 1, y - 6, 3, 24)
      g.fillStyle = "#ffffff"; g.beginPath(); g.arc(at(Number(p.price)), y + 6, 8, 0, 7); g.fill()
      g.font = "400 16px IBM Plex Mono, monospace"; g.fillStyle = "#e46a6a"; g.fillText(`stop ${fmt(p.stop)}`, x0, y + 38)
      g.fillStyle = "#45c98a"; const tl = `target ${fmt(p.tp)}`; g.fillText(tl, x1 - g.measureText(tl).width, y + 38)
      roleLine(g, S, "TRADER", H - 14)
    },
    VERIFICATORE: (g, W, H, S, d) => {
      frame(g, W, H, "VERIFICATORE · red team", "#b48cff"); if (!S.connected) return offline(g, W, H, S)
      const v = d?.verifier ?? {}, lab = d?.lab, fc = d?.forecasts
      const rows: [string, string, boolean | null][] = [
        ["verificate", String(v.checked ?? 0), null],
        ["bloccate", String(v.blocked ?? 0), v.checked ? !(v.blocked > 0) : null],
        ["prove storiche", lab ? String(lab.verdict) : "assenti", lab ? lab.verdict === "SUPERATO" : null],
        ["previsioni ok", fc?.evaluated ? `${Math.round(fc.target_first_pct ?? 0)}% di ${fc.evaluated}` : "—", null],
      ]
      rows.forEach(([lab2, val, ok], i) => {
        const y = 78 + i * 34
        g.fillStyle = "#9aa3b5"; g.font = "400 18px IBM Plex Mono, monospace"; g.fillText(lab2, 18, y)
        g.fillStyle = ok === null ? "#ece6d6" : ok ? "#45c98a" : "#e46a6a"; g.font = "600 18px IBM Plex Mono, monospace"; g.fillText(val, 200, y)
      })
      roleLine(g, S, "VERIFICATORE", H - 14)
    },
    SCOUT: (g, W, H, S, d) => {
      frame(g, W, H, "SCOUT · dati e conto", "#5fd3d3"); if (!S.connected) return offline(g, W, H, S)
      const sc = d?.scout ?? {}
      const rows: [string, string, boolean | null][] = [
        ["saldo broker", sc.checked_at ? `confermato ${new Date(sc.checked_at * 1000).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}` : "non richiesto", sc.checked_at ? true : null],
        ["registro=conto", (sc.desync ?? []).length ? "NO" : sc.checked_at ? "sì" : "—", (sc.desync ?? []).length ? false : sc.checked_at ? true : null],
        ["prezzi", sc.prices_n ? `${sc.prices_ok}/${sc.prices_n}` : "—", sc.prices_n ? sc.prices_ok === sc.prices_n : null],
        ["candele 4h", sc.prices_n ? `${sc.candles_ok}/${sc.prices_n}` : "—", sc.prices_n ? sc.candles_ok === sc.prices_n : null],
      ]
      rows.forEach(([lab, v, ok], i) => {
        const y = 78 + i * 34
        g.fillStyle = "#9aa3b5"; g.font = "400 18px IBM Plex Mono, monospace"; g.fillText(lab, 18, y)
        g.fillStyle = ok === null ? "#9aa3b5" : ok ? "#45c98a" : "#e46a6a"; g.font = "600 18px IBM Plex Mono, monospace"; g.fillText(v, 200, y)
      })
      roleLine(g, S, "SCOUT", H - 14)
    },
  }

  // ---------------- postazioni ----------------
  const R = 6.2
  const stations = ROLES.map((r) => {
    const g = new THREE.Group()
    const x = Math.sin(r.angle) * R, z = -Math.cos(r.angle) * R
    g.position.set(x, 0, z); g.lookAt(0, 0, 0)
    const top = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.08, 1.4), walnut); top.position.set(0, 1.05, 0); top.castShadow = top.receiveShadow = true; g.add(top)
    const edge = new THREE.Mesh(new THREE.BoxGeometry(3.22, 0.025, 0.025), goldMat); edge.position.set(0, 1.08, 0.7); g.add(edge)
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.95, 0.08), metal); body.position.set(0, 0.55, -0.6); body.castShadow = true; g.add(body)
    ;[-1.45, 1.45].forEach((lx) => { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 1.25), metal); leg.position.set(lx, 0.52, 0); leg.castShadow = true; g.add(leg) })
    const kb = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.3), new THREE.MeshStandardMaterial({ color: 0x101115, roughness: 0.5 })); kb.position.set(0, 1.105, 0.2); g.add(kb)
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 0.45, 16), metal); stand.position.set(0, 1.3, -0.45); g.add(stand)
    const scr = screen(2.4, 1.35, DRAW[r.id]); scr.mesh.position.set(0, 2.15, -0.42); scr.mesh.rotation.x = -0.06; g.add(scr.mesh)
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.45, 0.05), metal); bezel.position.set(0, 2.15, -0.46); bezel.rotation.x = -0.06; g.add(bezel)
    // targhetta del ruolo sul bordo della scrivania
    const pc = document.createElement("canvas"); pc.width = 512; pc.height = 64
    const pg = pc.getContext("2d")!; pg.fillStyle = "#0c0d11"; pg.fillRect(0, 0, 512, 64); pg.fillStyle = css(r.color); pg.fillRect(0, 0, 8, 64)
    pg.fillStyle = "#ece6d6"; pg.font = "600 34px IBM Plex Mono, monospace"; pg.fillText(r.id, 28, 44)
    const plateTex = new THREE.CanvasTexture(pc); plateTex.encoding = THREE.sRGBEncoding
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.175), new THREE.MeshBasicMaterial({ map: plateTex, toneMapped: false })); plate.position.set(0, 0.92, 0.705); g.add(plate)
    const deskLight = new THREE.PointLight(r.color, 0.6, 4.5); deskLight.position.set(0, 2.1, 0.4); g.add(deskLight)
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.68, 48), new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }))
    pad.rotation.x = -Math.PI / 2; pad.position.set(0, 0.015, 1.36); g.add(pad)
    scene.add(g)
    return { ...r, group: g, screen: scr, deskLight, pad, seat: new THREE.Vector3(x * 0.78, 0, z * 0.78) }
  })

  // ---------------- persone (o figure semplici se il modello non arriva) ----------------
  type Person = {
    st: (typeof stations)[number]; root: THREE.Object3D; joints: THREE.MeshStandardMaterial[]
    pos: THREE.Vector3; target: THREE.Vector3; heading: number; tag: HTMLDivElement
    mixer?: THREE.AnimationMixer; idle?: THREE.AnimationAction; walk?: THREE.AnimationAction
    agree?: THREE.AnimationAction; shake?: THREE.AnimationAction; walking: boolean; sayUntil: number; say: string; pulse: number
  }
  const people: Person[] = stations.map((s) => {
    const root = new THREE.Group()
    const jointMat = new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.2, metalness: 0.8, roughness: 0.3 })
    const suit = new THREE.MeshStandardMaterial({ color: s.suit, roughness: 0.6, metalness: 0.1 })
    const bodyM = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.1, 20), suit); bodyM.position.y = 1.0; bodyM.castShadow = true; root.add(bodyM)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), suit); head.position.y = 1.75; root.add(head)
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 8, 32), jointMat); band.rotation.x = Math.PI / 2; band.position.y = 1.45; root.add(band)
    root.position.copy(s.seat); scene.add(root)
    const tag = document.createElement("div"); tag.className = "sala-tag"; tag.innerHTML = `<b></b><i></i>`; tagsEl.appendChild(tag)
    return { st: s, root, joints: [jointMat], pos: s.seat.clone(), target: s.seat.clone(), heading: 0, tag, walking: false, sayUntil: 0, say: "", pulse: 0 }
  })
  const byId = Object.fromEntries(people.map((p) => [p.st.id, p])) as Record<RoleId, Person>

  let disposed = false
  new GLTFLoader().load(HUMAN_URL, (gltf) => {
    if (disposed) return
    const clip = (n: string) => gltf.animations.find((c) => c.name === n)
    const additive = (n: string) => {
      const c = clip(n); if (!c) return undefined
      const cc = c.clone(); THREE.AnimationUtils.makeClipAdditive(cc)
      return THREE.AnimationUtils.subclip(cc, n, 2, Math.max(3, Math.round(cc.duration * 30)), 30)
    }
    const agreeClip = additive("agree"), shakeClip = additive("headShake")
    people.forEach((p) => {
      const model = SkeletonUtils.clone(gltf.scene)
      const joints: THREE.MeshStandardMaterial[] = []
      model.traverse((o: any) => {
        if (!o.isMesh) return
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false
        if (/joint/i.test(o.material?.name ?? "")) {
          const m = new THREE.MeshStandardMaterial({ color: p.st.color, emissive: p.st.color, emissiveIntensity: 0.2, metalness: 0.85, roughness: 0.25, envMap: envTex, envMapIntensity: 0.8 })
          joints.push(m); o.material = m
        } else o.material = new THREE.MeshStandardMaterial({ color: p.st.suit, metalness: 0.1, roughness: 0.6 })
      })
      model.scale.setScalar(1.06); model.position.copy(p.pos); model.rotation.y = p.root.rotation.y
      scene.remove(p.root); scene.add(model); p.root = model; p.joints = joints
      const mixer = new THREE.AnimationMixer(model)
      const idle = mixer.clipAction(clip("idle")!), walk = mixer.clipAction(clip("walk")!)
      idle.play(); walk.play(); walk.setEffectiveWeight(0)
      const mk = (c?: THREE.AnimationClip) => {
        if (!c) return undefined
        const a = mixer.clipAction(c); a.blendMode = THREE.AdditiveAnimationBlendMode; a.setLoop(THREE.LoopOnce, 1); return a
      }
      Object.assign(p, { mixer, idle, walk, agree: mk(agreeClip), shake: mk(shakeClip) })
    })
  }, undefined, () => { /* senza modello restano le figure semplici, ferme */ })

  // ---------------- ologramma centrale: curva vera del patrimonio ----------------
  const holo = new THREE.Group(); holo.position.y = 2.2; scene.add(holo)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.22, 48), metal); base.position.y = -2.09; holo.add(base)
  const baseGlow = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.025, 8, 80), goldMat); baseGlow.rotation.x = Math.PI / 2; baseGlow.position.y = -1.97; holo.add(baseGlow)
  const beamMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.045, side: THREE.DoubleSide })
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 3.0, 48, 1, true), beamMat); beam.position.y = -0.4; holo.add(beam)
  const bars = new THREE.Group(); holo.add(bars)
  function buildBars(d: any) {
    bars.children.forEach((c: any) => { c.geometry.dispose(); c.material.dispose() }); bars.clear()
    const eq: number[] = (Array.isArray(d?.equity) ? d.equity : []).map((x: any) => Number(x?.[1])).filter(Number.isFinite).slice(-36)
    if (eq.length < 2) return
    const lo = Math.min(...eq), hi = Math.max(...eq), span = hi - lo || 1, first = eq[0]
    eq.forEach((v, i) => {
      const a = (i / eq.length) * Math.PI * 2, h = 0.15 + ((v - lo) / span) * 0.9
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, 0.08), new THREE.MeshBasicMaterial({ color: v >= first ? 0x45c98a : 0xe46a6a, transparent: true, opacity: 0.8 }))
      m.position.set(Math.cos(a) * 1.05, -0.9 + h / 2, Math.sin(a) * 1.05); bars.add(m)
    })
  }
  const priceTag = screen(2.4, 0.6, (g, W, H, S, d) => {
    g.clearRect(0, 0, W, H); g.fillStyle = "rgba(8,10,14,.8)"; g.fillRect(0, 0, W, H)
    const btc = (d?.signals ?? []).find((s: any) => s.symbol === "BTC-EUR")
    const px = Number(btc?.live_price ?? btc?.price)
    g.fillStyle = S.connected ? "#e8be5c" : "#8a8f9a"; g.font = "700 40px IBM Plex Mono, monospace"
    const t = S.connected && Number.isFinite(px) ? `BTC ${fmt(px)} €` : "NON CONNESSO"
    g.fillText(t, (W - g.measureText(t).width) / 2, 58)
    g.font = "400 18px IBM Plex Mono, monospace"; g.fillStyle = "#9aa3b5"
    const sub = S.connected ? `patrimonio · ultimi ${Math.min(36, (d?.equity ?? []).length)} turni` : S.reason
    g.fillText(sub, (W - g.measureText(sub).width) / 2, 94)
  })
  priceTag.mesh.position.y = 1.05; holo.add(priceTag.mesh)

  // ---------------- passaggi di dati: solo quando arriva un turno vero ----------------
  const packets: { mesh: THREE.Mesh; from: Person; to: Person; t: number }[] = []
  const pGeo = new THREE.SphereGeometry(0.09, 16, 12)
  const headPos = (p: Person) => p.pos.clone().add(new THREE.Vector3(0, 2.15, 0))
  function sendPacket(from: Person, to: Person) {
    if (reduce) return
    const mesh = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({ color: from.st.color })); scene.add(mesh)
    packets.push({ mesh, from, to, t: 0 })
  }
  const gesture = (p: Person, kind: "agree" | "shake") => {
    const a = kind === "agree" ? p.agree : p.shake
    if (a && !reduce) { a.reset(); a.setEffectiveWeight(1); a.play() }
  }
  const timers: number[] = []
  const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(() => { if (!disposed) fn() }, ms)) }
  const pick = (S: SalaState, id: RoleId) => {
    const es = S.roles[id].turnEntries
    return (es.find((e) => e.level === "trade" || e.level === "error" || e.level === "warn") ?? es[0])?.text ?? ""
  }
  /** Racconta il turno appena arrivato, nell'ordine reale del lavoro, solo con i ruoli che hanno scritto qualcosa. */
  function playTurn(S: SalaState) {
    const order = (["SCOUT", "ANALISTA", "VERIFICATORE", "RISK", "TRADER"] as RoleId[]).filter((id) => S.roles[id].turnEntries.length)
    let prev: Person | null = null
    order.forEach((id, i) => {
      const p = byId[id]
      later(i * 1600, () => {
        const now = performance.now()
        p.say = pick(S, id); p.sayUntil = now + 6000; p.pulse = now
        if (prev) sendPacket(prev, p)
        if (id === "ANALISTA") { if (S.events.buySignal) gesture(p, "agree"); else if (S.events.avoidOnly) gesture(p, "shake") }
        if (id === "RISK" && S.events.riskBlock) gesture(p, "shake")
        if (id === "TRADER" && (S.events.trade || S.events.sold)) {
          p.target.set(Math.sin(p.st.angle) * 2.4, 0, -Math.cos(p.st.angle) * 2.4)
          later(4200, () => p.target.copy(p.st.seat))
        }
        if (id === "SCOUT") gesture(p, S.events.scoutStop ? "shake" : "agree")
        if (id === "VERIFICATORE") { if (S.events.verifierBlock) gesture(p, "shake"); else if (S.events.verifierOk) gesture(p, "agree") }
        if (id === "TRADER" && S.events.proposal && !S.events.trade && !S.events.sold) gesture(p, "agree")
        prev = p
      })
      prev = p
    })
  }

  // ---------------- camera e controlli ----------------
  const views = [{ yaw: 0, pitch: 0.5, dist: 13 }, { yaw: 0.9, pitch: 0.28, dist: 10 }, { yaw: -1.2, pitch: 0.6, dist: 12 }, { yaw: Math.PI, pitch: 0.4, dist: 13 }]
  let vi = 0, fit = 1, idleT = 0, dragging = false, last: [number, number] = [0, 0], pinch: number | null = null
  const cam = { ...views[0] }, goal = { ...views[0] }
  const onDown = (e: PointerEvent) => { dragging = true; last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); idleT = 0 }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    goal.yaw -= (e.clientX - last[0]) * 0.006; goal.pitch = Math.min(1.25, Math.max(0.12, goal.pitch + (e.clientY - last[1]) * 0.004)); last = [e.clientX, e.clientY]
  }
  const onUp = () => { dragging = false }
  const onWheel = (e: WheelEvent) => { e.preventDefault(); goal.dist = Math.min(22, Math.max(6, goal.dist + e.deltaY * 0.01)); idleT = 0 }
  const onTouch = (e: TouchEvent) => {
    if (e.touches.length !== 2) return
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
    if (pinch) goal.dist = Math.min(22, Math.max(6, (goal.dist * pinch) / d)); pinch = d
  }
  const onTouchEnd = () => { pinch = null }
  const nextView = () => { vi = (vi + 1) % views.length; Object.assign(goal, views[vi]); idleT = 0 }
  canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp)
  canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("touchmove", onTouch, { passive: true }); canvas.addEventListener("touchend", onTouchEnd)
  canvas.addEventListener("dblclick", nextView)
  function resize() {
    const r = canvas.getBoundingClientRect()
    renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix()
    fit = camera.aspect < 1.2 ? Math.min(2.4, 1.3 / camera.aspect) : 1
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

  // ---------------- ciclo ----------------
  const clock = new THREE.Clock()
  let raf = 0, screenT = 1, lastTurn: number | null = null, S = salaState(getData(), Date.now() / 1000)
  function refresh(d: any) {
    S = salaState(d, Date.now() / 1000)
    stations.forEach((s) => s.screen.redraw(S, d)); priceTag.redraw(S, d)
    if (S.turnAt !== lastTurn) {
      const first = lastTurn === null
      lastTurn = S.turnAt; buildBars(S.connected ? d : null)
      // all'apertura racconta il turno solo se è appena avvenuto; poi ogni turno nuovo
      if (S.connected && (!first || (S.ageS ?? 1e9) < 300)) playTurn(S)
    }
  }
  refresh(getData())
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05), now = performance.now(), d = getData()
    screenT += dt; if (screenT > 1) { screenT = 0; refresh(d) }
    idleT += dt; if (!dragging && idleT > 8 && !reduce) goal.yaw += dt * 0.04
    cam.yaw += (goal.yaw - cam.yaw) * 0.08; cam.pitch += (goal.pitch - cam.pitch) * 0.08; cam.dist += (goal.dist - cam.dist) * 0.08
    const D = cam.dist * fit
    camera.position.set(Math.sin(cam.yaw) * Math.cos(cam.pitch) * D, 1.4 + Math.sin(cam.pitch) * D, Math.cos(cam.yaw) * Math.cos(cam.pitch) * D)
    camera.lookAt(0, 1.3, 0)
    const rect = canvas.getBoundingClientRect()
    beamMat.opacity = S.connected ? 0.045 : 0.012
    people.forEach((p) => {
      const role = S.roles[p.st.id]
      const to = p.target.clone().sub(p.pos); to.y = 0
      const moving = to.length() > 0.05
      if (moving) { p.pos.add(to.clampLength(0, dt * 1.4)); p.heading = Math.atan2(to.x, to.z) }
      else { const look = new THREE.Vector3().subVectors(p.st.group.position, p.pos); p.heading = Math.atan2(look.x, look.z) }
      let dy = p.heading - p.root.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      p.root.rotation.y += dy * Math.min(1, dt * 6)
      p.root.position.set(p.pos.x, 0, p.pos.z)
      if (p.mixer && p.idle && p.walk) {
        if (moving !== p.walking) {
          p.walking = moving
          const from = moving ? p.idle : p.walk, toA = moving ? p.walk : p.idle
          toA.setEffectiveWeight(1); from.crossFadeTo(toA, 0.4, false)
        }
        p.idle.timeScale = S.connected ? 1 : 0.35 // senza dati il respiro rallenta: la figura è ferma, non lavora
        p.mixer.update(reduce ? 0 : dt)
      }
      // luce del ruolo: dice lo stato vero, con un breve impulso quando il bot ha scritto nel turno appena arrivato
      const base = role.status === "attivo" ? 0.5 : role.status === "in attesa" ? 0.18 : role.status === "errore" ? 0.6 : 0.03
      const flash = Math.max(0, 1 - (now - p.pulse) / 1200)
      p.joints.forEach((m) => {
        m.emissive.setHex(role.status === "errore" ? 0xe04848 : p.st.color)
        m.emissiveIntensity = base + flash * 0.8
      })
      p.st.deskLight.intensity = S.connected ? 0.25 + base * 0.8 + flash : 0.05
      ;(p.st.pad.material as THREE.MeshBasicMaterial).opacity = S.connected ? 0.15 + base * 0.6 : 0.06
      const hp = headPos(p).project(camera)
      p.tag.style.display = hp.z < 1 ? "" : "none"
      const half = (p.tag.offsetWidth || 120) / 2 + 4 // il cartellino resta dentro lo schermo
      p.tag.style.left = `${Math.min(rect.width - half, Math.max(half, (hp.x * 0.5 + 0.5) * rect.width))}px`; p.tag.style.top = `${(-hp.y * 0.5 + 0.5) * rect.height}px`
      p.tag.dataset.status = role.status
      ;(p.tag.firstChild as HTMLElement).textContent = `${ROLE_INFO[p.st.id].title} · ${role.status}`
      ;(p.tag.lastChild as HTMLElement).textContent = now < p.sayUntil ? p.say : ""
      p.tag.title = STATUS_LABEL[role.status]
    })
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i]; k.t += dt / 1.4
      const a = headPos(k.from), c = headPos(k.to), mid = a.clone().lerp(c, 0.5); mid.y += 1.6
      const u = Math.min(1, k.t)
      k.mesh.position.copy(a.multiplyScalar((1 - u) * (1 - u)).add(mid.multiplyScalar(2 * u * (1 - u))).add(c.multiplyScalar(u * u)))
      if (k.t >= 1) { scene.remove(k.mesh); (k.mesh.material as THREE.Material).dispose(); packets.splice(i, 1) }
    }
    if (S.connected && !reduce) holo.rotation.y += dt * 0.12
    priceTag.mesh.quaternion.copy(camera.quaternion).premultiply(holo.quaternion.clone().invert())
    renderer.render(scene, camera)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    disposed = true; cancelAnimationFrame(raf); ro.disconnect(); timers.forEach((t) => clearTimeout(t))
    canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp)
    canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("touchmove", onTouch); canvas.removeEventListener("touchend", onTouchEnd)
    canvas.removeEventListener("dblclick", nextView)
    tagsEl.innerHTML = ""
    scene.traverse((o: any) => { o.geometry?.dispose?.(); const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; mats.forEach((mm: any) => { mm.map?.dispose?.(); mm.dispose?.() }) })
    envTex.dispose(); pmrem.dispose(); renderer.dispose()
  }
}
