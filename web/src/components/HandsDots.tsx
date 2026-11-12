import { useEffect, useRef } from 'react'

/**
 * The hero backdrop: one hand giving, one receiving, drawn live as a halftone of scanline dots.
 * Each hand drifts and breathes, and periodically dissolves dot by dot into a second pose.
 */

/** Regions of the source sheet as fractions [x, y, width, height]: both hands in pose A, then pose B. */
const SHEET = [
  [0, 0.06, 0.47, 0.4],
  [0.53, 0.06, 0.47, 0.4],
  [0, 0.55, 0.47, 0.4],
  [0.53, 0.55, 0.47, 0.4],
]
const SHEET_ASPECT = (0.4 * 1520) / (0.47 * 2688)
const LOOP = 20
const LEVELS = [0.26, 0.52, 0.78, 1]
const INK = '#0d0d0d'

const fract = (x: number) => x - Math.floor(x)
const hash = (a: number, b: number) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const mixAt = (t: number, on: number, off: number) => smooth(on, on + 1.6, t) * (1 - smooth(off, off + 1.6, t))

export function HandsDots() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const fields = [0, 1].map(() => document.createElement('canvas').getContext('2d', { willReadFrequently: true })!)
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches

    let tiles: HTMLCanvasElement[] = []
    let width = 0
    let height = 0
    let cols = 0
    let rows = 0
    let step = 0
    let rowStep = 0
    let seeds = new Float32Array(0)
    let raf = 0
    let visible = true
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
      for (const field of fields) {
        field.canvas.width = cols
        field.canvas.height = rows
      }
      seeds = new Float32Array(cols * rows)
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) seeds[j * cols + i] = 0.55 * hash(i, j) + 0.45 * hash(j * 3.1, 7.7)
      render(still ? 0 : time())
    }

    const time = () => ((performance.now() - started) / 1000) % LOOP

    /** Draws both hands of one pose into a field, one pixel per dot, with their current drift. */
    function sample(pose: number, t: number) {
      const field = fields[pose]
      const portrait = height > width
      const handWidth = width * (portrait ? 0.66 : 0.53)
      const handHeight = handWidth * SHEET_ASPECT
      const centerY = height * (portrait ? 0.66 : 0.54)
      const angle = (2 * Math.PI * t) / LOOP

      field.setTransform(1, 0, 0, 1, 0, 0)
      field.fillStyle = '#fff'
      field.fillRect(0, 0, cols, rows)
      for (const side of [0, 1]) {
        const phase = side * Math.PI
        const reach = (0.035 * Math.sin(angle + phase) + 0.012 * Math.sin(2 * angle + 1.3 + phase)) * width
        const scale = 1 + 0.07 * Math.sin(angle + 0.9 + phase)
        const roll = (side ? -1 : 1) * 0.045 * Math.sin(angle + 2.1 + phase)
        const pivot = side ? width : 0
        const x = side ? width - handWidth + width * 0.045 - reach : reach - width * 0.045

        field.setTransform(cols / width, 0, 0, rows / height, 0, 0)
        field.translate(pivot, centerY)
        field.rotate(roll)
        field.scale(scale, scale)
        field.translate(-pivot, -centerY)
        field.drawImage(tiles[pose * 2 + side], x, centerY - handHeight / 2, handWidth, handHeight)
      }
      return field.getImageData(0, 0, cols, rows).data
    }

    function render(t: number) {
      if (!tiles.length) return
      const portrait = height > width
      // The right hand changes pose first, then the left. Both are back before the loop restarts.
      const mix = [mixAt(t, 6.2, 14.6), mixAt(t, 2.4, 10.4)]
      const poses = [sample(0, t), sample(1, t)]
      const tick = Math.floor(t * 7)
      const radius = step * 0.46

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = INK
      ctx.beginPath()
      for (let j = 0; j < rows; j++) {
        const slip = hash(j, tick) > 0.965 ? Math.round((hash(tick, j) - 0.5) * 8) : 0
        const fromCopy = ((j + 0.5) * rowStep) / height - (portrait ? 0.33 : 0.385)
        for (let i = 0; i < cols; i++) {
          const seed = seeds[j * cols + i]
          const m = mix[i < cols / 2 ? 0 : 1]
          const cell = j * cols + Math.min(cols - 1, Math.max(0, i - slip))
          let value = Math.min(1, Math.max(0, (1 - poses[seed < m ? 1 : 0][cell * 4] / 255 - 0.16) / 0.42))
          if (!value) continue
          value *= 0.86 + 0.14 * Math.sin(t * 3.2 + seed * 40)
          if (m > 0.001 && m < 0.999) {
            const distance = Math.abs(seed - m)
            if (distance < 0.12) value *= (distance / 0.12) * (hash(i + tick, j) > 0.4 ? 1 : 0.3)
          }
          // Fingertips fade before they meet, and no dot crosses the headline.
          const fromCenter = Math.abs((i + 0.5) / cols - 0.5)
          value *= smooth(0.035, 0.11, fromCenter)
          value *= smooth(0.85, 1.25, Math.hypot(fromCenter / (portrait ? 0.44 : 0.2), fromCopy / 0.085))

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
    const sheet = new Image()
    sheet.onload = () => {
      tiles = SHEET.map(([x, y, w, h]) => {
        const tile = document.createElement('canvas')
        tile.width = 420
        tile.height = Math.round((420 * h * sheet.height) / (w * sheet.width))
        const tileCtx = tile.getContext('2d')!
        tileCtx.imageSmoothingQuality = 'high'
        tileCtx.drawImage(sheet, x * sheet.width, y * sheet.height, w * sheet.width, h * sheet.height, 0, 0, tile.width, tile.height)
        return tile
      })
      resize.observe(canvas)
      watch.observe(canvas)
      if (!still) raf = requestAnimationFrame(loop)
    }
    sheet.src = `${import.meta.env.BASE_URL}hands.webp`

    return () => {
      sheet.onload = null
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="dots" aria-hidden="true" />
}
