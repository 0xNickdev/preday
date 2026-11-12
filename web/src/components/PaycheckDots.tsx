import { useEffect, useRef } from 'react'

/**
 * The hero backdrop: a paycheck drawn live as a halftone of scanline dots.
 * It dissolves dot by dot through three amounts that tell the product:
 * the next payment, the part taken today, and what lands on payday.
 */
const AMOUNTS = ['$1,180', '$100', '$1,075']

const LOOP = 18
const FADE = 1.6
/** Start times of the three dissolves, the last one returning to the first amount. */
const CUTS = [4.4, 10, 15.6]
const LEVELS = [0.26, 0.52, 0.78, 1]
const INK = '#0d0d0d'

const fract = (x: number) => x - Math.floor(x)
const hash = (a: number, b: number) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function PaycheckDots({ onAmount }: { onAmount: (index: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const field = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches

    let width = 0
    let height = 0
    let cols = 0
    let rows = 0
    let step = 0
    let rowStep = 0
    let seeds = new Float32Array(0)
    let raf = 0
    let visible = true
    let shown = 0
    const started = performance.now()

    function layout() {
      width = canvas.clientWidth
      height = canvas.clientHeight
      const dpr = Math.min(2, devicePixelRatio)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      step = Math.max(5, width / 205)
      rowStep = step * 2.05
      cols = Math.ceil(width / step)
      rows = Math.ceil(height / rowStep)
      field.canvas.width = cols
      field.canvas.height = rows
      seeds = new Float32Array(cols * rows)
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) seeds[j * cols + i] = 0.55 * hash(i, j) + 0.45 * hash(j * 3.1, 7.7)
      render(still ? 0 : time())
    }

    const time = () => ((performance.now() - started) / 1000) % LOOP

    /** Draws one amount into the field, one pixel per dot, with its current drift. */
    function sample(index: number, t: number) {
      const angle = (2 * Math.PI * t) / LOOP
      const breath = 1 + 0.035 * Math.sin(angle + 0.9)
      let size = Math.min(height * 0.3, width * (height > width ? 0.34 : 0.25))

      field.setTransform(1, 0, 0, 1, 0, 0)
      field.fillStyle = '#000'
      field.fillRect(0, 0, cols, rows)
      field.scale(cols / width, rows / height)
      field.translate(width / 2 + 0.012 * width * Math.sin(angle), height * 0.73)
      field.rotate(0.012 * Math.sin(angle + 2.1))
      field.scale(breath, breath)

      field.font = `600 ${size}px Inter, system-ui, sans-serif`
      const fit = (width * 0.9) / field.measureText(AMOUNTS[index]).width
      if (fit < 1) {
        size *= fit
        field.font = `600 ${size}px Inter, system-ui, sans-serif`
      }
      // Lighter at the top, solid at the bottom, so the dots shade across each digit.
      const shade = field.createLinearGradient(0, -size * 0.4, 0, size * 0.4)
      shade.addColorStop(0, '#8c8c8c')
      shade.addColorStop(1, '#fff')
      field.fillStyle = shade
      field.textAlign = 'center'
      field.textBaseline = 'middle'
      field.fillText(AMOUNTS[index], 0, 0)
      return field.getImageData(0, 0, cols, rows).data
    }

    function render(t: number) {
      const mix = CUTS.map((cut) => smooth(cut, cut + FADE, t))
      const front = mix.find((m) => m > 0.001 && m < 0.999)
      const current = mix[2] > 0.5 ? 0 : mix[1] > 0.5 ? 2 : mix[0] > 0.5 ? 1 : 0
      if (current !== shown) onAmount((shown = current))

      // A dot shows amount 0 before the first cut and after the last, 1 between the first two, 2 between the last two.
      const inUse = [mix[0] < 1 || mix[2] > 0, mix[0] > 0 && mix[1] < 1, mix[1] > 0 && mix[2] < 1]
      const fields = inUse.map((used, index) => (used ? sample(index, t) : null))
      const tick = Math.floor(t * 7)
      const radius = step * 0.46

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = INK
      ctx.beginPath()
      for (let j = 0; j < rows; j++) {
        const slip = hash(j, tick) > 0.965 ? Math.round((hash(tick, j) - 0.5) * 8) : 0
        for (let i = 0; i < cols; i++) {
          const seed = seeds[j * cols + i]
          const index = seed < mix[2] ? 0 : seed < mix[1] ? 2 : seed < mix[0] ? 1 : 0
          const cell = j * cols + Math.min(cols - 1, Math.max(0, i - slip))
          let value = fields[index]![cell * 4] / 255
          if (value < 0.1) continue
          value *= 0.86 + 0.14 * Math.sin(t * 3.2 + seed * 40)
          if (front !== undefined) {
            const distance = Math.abs(seed - front)
            if (distance < 0.12) value *= (distance / 0.12) * (hash(i + tick, j) > 0.4 ? 1 : 0.3)
          }
          const level = LEVELS.findLast((l) => value >= l - 0.13)
          if (!level) continue
          const r = radius * (level === LEVELS[0] ? 0.38 : level)
          const x = (i + 0.5) * step
          const y = (j + 0.5) * rowStep
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, Math.PI * 2)
        }
      }
      ctx.fill()
    }

    function loop() {
      if (visible) render(time())
      raf = requestAnimationFrame(loop)
    }

    const resize = new ResizeObserver(layout)
    const watch = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    document.fonts.load('600 40px Inter').finally(() => {
      resize.observe(canvas)
      watch.observe(canvas)
      if (!still) raf = requestAnimationFrame(loop)
    })

    return () => {
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
    }
  }, [onAmount])

  return <canvas ref={ref} className="dots" aria-hidden="true" />
}
