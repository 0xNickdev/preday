import { useEffect, useRef } from 'react'

/**
 * The payday board: an LED dot matrix drawn on a canvas every frame.
 * It loops through three frames that tell the product in one glance:
 * the next payment, the part you take today, and what lands on payday.
 */

type Frame = {
  left: string
  right: string
  amount: string
  amber: boolean
  /** Brightness of a given day on the month strip, 0 for unlit. */
  days: (day: number) => number
}

const TODAY = 12
const PAYDAY = 28

const FRAMES: Frame[] = [
  {
    left: 'NEXT PAYMENT',
    right: 'NOV 28',
    amount: '$1,180',
    amber: false,
    days: (d) => (d === PAYDAY ? 1 : d === TODAY ? 0.8 : d < TODAY ? 0.3 : 0),
  },
  {
    left: 'YOURS TODAY',
    right: 'NOV 12',
    amount: '$100',
    amber: true,
    days: (d) => (d === TODAY ? 1 : 0),
  },
  {
    left: 'PAID BACK $105',
    right: 'NOV 28',
    amount: '$1,075',
    amber: false,
    days: (d) => (d === PAYDAY ? 1 : d < PAYDAY ? 0.3 : 0),
  },
]

const LOOP = 18
const FADE = 1.4
/** Start times of the A-B, B-C and C-A dissolves. */
const CUTS = [4.6, 10.2, 15.8]
const LEVELS = [0.3, 0.55, 0.8, 1]
const BOARD = '#0A0A0A'
const UNLIT = '#1F1F1D'
const WHITE = '#F2F3EF'
const AMBER = '#FFB000'

// 5x7 glyphs, one 5-bit row per entry, most significant bit on the left.
const GLYPHS: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
}

const fract = (x: number) => x - Math.floor(x)
const hash = (a: number, b: number) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function textWidth(text: string) {
  return text.length * 6 - 1
}

function drawText(field: Float32Array, cols: number, text: string, x0: number, y0: number) {
  for (let c = 0; c < text.length; c++) {
    const glyph = GLYPHS[text[c]]
    if (!glyph) continue
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++)
        if (glyph[y] & (0x10 >> x)) field[(y0 + y) * cols + x0 + c * 6 + x] = 1
  }
}

/** Renders one frame into a cols x rows grid of dot intensities. */
function buildField(frame: Frame, cols: number, rows: number, scratch: CanvasRenderingContext2D) {
  const field = new Float32Array(cols * rows)
  const pad = cols < 90 ? 2 : 4
  const stacked = textWidth(frame.left) + textWidth(frame.right) + 6 > cols - pad * 2

  drawText(field, cols, frame.left, pad, pad)
  if (stacked) drawText(field, cols, frame.right, pad, pad + 9)
  else drawText(field, cols, frame.right, cols - pad - textWidth(frame.right), pad)

  const top = pad + (stacked ? 19 : 10)
  const baseline = rows - pad - 8
  const { canvas } = scratch
  canvas.width = cols
  canvas.height = rows
  scratch.fillStyle = '#000'
  scratch.fillRect(0, 0, cols, rows)
  scratch.fillStyle = '#fff'
  scratch.textBaseline = 'alphabetic'
  let size = (baseline - top) * 1.22
  scratch.font = `700 ${size}px "Funnel Display", system-ui, sans-serif`
  const fit = (cols - pad * 2) / scratch.measureText(frame.amount).width
  if (fit < 1) {
    size *= fit
    scratch.font = `700 ${size}px "Funnel Display", system-ui, sans-serif`
  }
  scratch.fillText(frame.amount, pad - size * 0.03, baseline)
  const pixels = scratch.getImageData(0, 0, cols, rows).data
  for (let i = 0; i < field.length; i++) field[i] = Math.max(field[i], pixels[i * 4] / 255)

  const slot = (cols - pad * 2) / 30
  for (let day = 1; day <= 30; day++) {
    const level = frame.days(day)
    if (!level) continue
    const x = Math.round(pad + (day - 1) * slot)
    const width = Math.max(1, Math.floor(slot) - 1)
    for (let w = 0; w < width; w++)
      for (let h = 0; h < 2; h++) field[(rows - pad - 2 + h) * cols + x + w] = level
  }
  return field
}

export function DotBoard() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const base = document.createElement('canvas')
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches

    let cols = 0
    let rows = 0
    let step = 0
    let fields: Float32Array[] = []
    let seeds = new Float32Array(0)
    let raf = 0
    let visible = true
    const started = performance.now()

    function layout() {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const dpr = Math.min(2, devicePixelRatio)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      step = Math.max(4.5, width / 176)
      cols = Math.floor(width / step)
      rows = Math.floor(height / step)
      step = width / cols
      fields = FRAMES.map((frame) => buildField(frame, cols, rows, scratch))
      seeds = new Float32Array(cols * rows)
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) seeds[j * cols + i] = 0.55 * hash(i, j) + 0.45 * hash(j * 3.1, 7.7)

      base.width = canvas.width
      base.height = canvas.height
      const b = base.getContext('2d')!
      b.setTransform(dpr, 0, 0, dpr, 0, 0)
      b.fillStyle = BOARD
      b.fillRect(0, 0, width, height)
      b.fillStyle = UNLIT
      b.beginPath()
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const x = (i + 0.5) * step
          const y = (j + 0.5) * step
          b.moveTo(x + step * 0.17, y)
          b.arc(x, y, step * 0.17, 0, Math.PI * 2)
        }
      b.fill()
      render(still ? 0 : time())
    }

    const time = () => ((performance.now() - started) / 1000) % LOOP

    function render(t: number) {
      const mix = CUTS.map((cut) => smooth(cut, cut + FADE, t))
      const front = mix.find((m) => m > 0.001 && m < 0.999)
      const tick = Math.floor(t * 7)
      const radius = step * 0.44
      const white = new Path2D()
      const amber = new Path2D()

      for (let j = 0; j < rows; j++) {
        const slip = hash(j, tick) > 0.985 ? Math.round((hash(tick, j) - 0.5) * 6) : 0
        for (let i = 0; i < cols; i++) {
          const cell = j * cols + Math.min(cols - 1, Math.max(0, i - slip))
          const seed = seeds[j * cols + i]
          const frame = seed < mix[2] ? 0 : seed < mix[1] ? 2 : seed < mix[0] ? 1 : 0
          let value = fields[frame][cell]
          if (value < 0.15) continue
          value *= 0.88 + 0.12 * Math.sin(t * 3.2 + seed * 40)
          if (front !== undefined) {
            const distance = Math.abs(seed - front)
            if (distance < 0.12) value *= (distance / 0.12) * (hash(i + tick, j) > 0.4 ? 1 : 0.3)
          }
          const level = LEVELS.findLast((l) => value >= l - 0.13)
          if (!level) continue
          const x = (i + 0.5) * step
          const y = (j + 0.5) * step
          const path = FRAMES[frame].amber ? amber : white
          path.moveTo(x + radius * level, y)
          path.arc(x, y, radius * level, 0, Math.PI * 2)
        }
      }

      ctx.drawImage(base, 0, 0, canvas.clientWidth, canvas.clientHeight)
      ctx.fillStyle = WHITE
      ctx.fill(white)
      ctx.fillStyle = AMBER
      ctx.fill(amber)
    }

    function loop() {
      if (visible) render(time())
      raf = requestAnimationFrame(loop)
    }

    const resize = new ResizeObserver(layout)
    const watch = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    document.fonts.load('700 40px "Funnel Display"').finally(() => {
      resize.observe(canvas)
      watch.observe(canvas)
      if (!still) raf = requestAnimationFrame(loop)
    })

    return () => {
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={ref}
      className="board"
      role="img"
      aria-label="A payday board. Next payment on November 28 is $1,180. Take $100 of it today. On payday the advance and its $5 fee are paid back and $1,075 lands."
    />
  )
}
