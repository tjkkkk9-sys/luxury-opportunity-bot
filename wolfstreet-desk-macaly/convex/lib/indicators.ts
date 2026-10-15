// Indicatori tecnici puri (porting 1:1 di bot/indicators.py, verificato con i test di parità).
// I primi valori di "riscaldamento" sono null: niente numeri inventati su poche candele.
export type Series = (number | null)[]

export function ema(values: number[], span: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (values.length < span) return out
  const k = 2 / (span + 1)
  let prev = values.slice(0, span).reduce((a, b) => a + b, 0) / span
  out[span - 1] = prev
  for (let i = span; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function wilder(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null)
  if (values.length < period) return out
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period
    out[i] = prev
  }
  return out
}

export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < closes.length; i++) {
    gains.push(Math.max(closes[i] - closes[i - 1], 0))
    losses.push(Math.max(closes[i - 1] - closes[i], 0))
  }
  const ag = wilder(gains, period)
  const al = wilder(losses, period)
  for (let j = 0; j < ag.length; j++) {
    const g = ag[j], l = al[j]
    if (g === null || l === null) continue
    out[j + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}

export function trueRange(h: number[], l: number[], c: number[]): number[] {
  const tr = [h[0] - l[0]]
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])))
  return tr
}

export function atr(h: number[], l: number[], c: number[], period = 14): Series {
  return wilder(trueRange(h, l, c), period)
}

export function macdHist(closes: number[], fast = 12, slow = 26, signal = 9): Series {
  const ef = ema(closes, fast), es = ema(closes, slow)
  const line: Series = ef.map((a, i) => (a !== null && es[i] !== null ? a - (es[i] as number) : null))
  const out: Series = new Array(closes.length).fill(null)
  const start = line.findIndex((v) => v !== null)
  if (start < 0) return out
  const sig = ema(line.slice(start) as number[], signal)
  sig.forEach((s, j) => {
    const i = start + j
    if (s !== null && line[i] !== null) out[i] = (line[i] as number) - s
  })
  return out
}

export function adx(h: number[], l: number[], c: number[], period = 14): Series {
  const n = c.length
  const out: Series = new Array(n).fill(null)
  if (n < period * 2 + 1) return out
  const plus = [0], minus = [0]
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]
    plus.push(up > dn && up > 0 ? up : 0)
    minus.push(dn > up && dn > 0 ? dn : 0)
  }
  const tr = trueRange(h, l, c)
  const atr_ = wilder(tr.slice(1), period)
  const p_ = wilder(plus.slice(1), period)
  const m_ = wilder(minus.slice(1), period)
  const dx: number[] = []
  const idx: number[] = []
  for (let j = 0; j < atr_.length; j++) {
    const a = atr_[j]
    if (a === null || !a) continue
    const pdi = (100 * (p_[j] as number)) / a, mdi = (100 * (m_[j] as number)) / a
    dx.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi))
    idx.push(j + 1)
  }
  wilder(dx, period).forEach((v, k) => {
    if (v !== null) out[idx[k]] = v
  })
  return out
}

/** Massimo delle `window` candele PRECEDENTI (esclude la candela corrente: niente look-ahead). */
export function rollingMaxPrev(values: number[], window: number): Series {
  return values.map((_, i) => (i < window ? null : Math.max(...values.slice(i - window, i))))
}
