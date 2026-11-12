import { useEffect, useRef } from 'react'
import type { MotionValue } from 'motion/react'

/** A part of the hands sheet as fractions [x, y, width, height]. */
export type Region = readonly [number, number, number, number]

const SUB = 3
const BLACK = 0.14
const SHIMMER = 0.09
const FRONT = 0.07
// A little under two 60Hz frames, so the 30fps cap never slips to every third frame.
const FRAME = 32

/** Ordered dither matrix, built by quadrupling the one below it: [[4M, 4M+2], [4M+3, 4M+1]]. */
function bayer(size: number): number[] {
  if (size === 1) return [0]
  const half = size / 2
  const inner = bayer(half)
  return Array.from({ length: size * size }, (_, k) => {
    const x = k % size
    const y = (k - x) / size
    return 4 * inner[(y % half) * half + (x % half)] + [0, 2, 3, 1][(y < half ? 0 : 2) + (x < half ? 0 : 1)]
  })
}

const THRESHOLD = bayer(8).map((v) => (v + 0.5) / 64)

function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32
}

/** The luminance that `share` of the cells fall at or below. */
function percentile(histogram: Uint32Array, share: number) {
  const target = histogram.reduce((sum, n) => sum + n, 0) * share
  let seen = 0
  return histogram.findIndex((n) => (seen += n) >= target)
}

let sheet: Promise<HTMLImageElement> | undefined

function loadSheet() {
  if (!sheet) {
    const image = new Image()
    image.src = `${import.meta.env.BASE_URL}hands.webp`
    sheet = image.decode().then(() => image)
  }
  return sheet
}

/**
 * A region of the hands sheet drawn as square pixels with ordered dithering.
 * The pixels shimmer, and they assemble in a scattered order as `reveal` goes from 0 to 1.
 */
export function Dither({
  region,
  cellSize,
  color,
  reveal,
}: {
  region: Region
  cellSize: number
  color: string
  reveal?: MotionValue<number>
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const field = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const sub = cellSize / SUB

    let image: HTMLImageElement | undefined
    let cols = 0
    let rows = 0
    let dot = 0
    let values = new Float32Array(0)
    let seeds = new Float32Array(0)
    let raf = 0
    let last = 0
    let blank = true
    let alive = true

    /** Samples the region, cropped to cover the canvas, one pixel per cell, and levels it. */
    function layout() {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!image || !width || !height) return
      const dpr = Math.min(2, devicePixelRatio)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dot = Math.max(sub * 0.74, 1 / dpr)

      cols = Math.ceil(width / cellSize)
      rows = Math.ceil(height / cellSize)
      field.canvas.width = cols
      field.canvas.height = rows
      const [x, y, w, h] = region
      const sourceWidth = w * image.naturalWidth
      const sourceHeight = h * image.naturalHeight
      const perCell = Math.min(sourceWidth / cols, sourceHeight / rows)
      field.imageSmoothingQuality = 'high'
      field.drawImage(
        image,
        x * image.naturalWidth + (sourceWidth - cols * perCell) / 2,
        y * image.naturalHeight + (sourceHeight - rows * perCell) / 2,
        cols * perCell,
        rows * perCell,
        0,
        0,
        cols,
        rows,
      )

      const data = field.getImageData(0, 0, cols, rows).data
      const count = cols * rows
      const luminance = new Uint8Array(count)
      const histogram = new Uint32Array(256)
      for (let k = 0; k < count; k++) {
        luminance[k] = 0.2126 * data[k * 4] + 0.7152 * data[k * 4 + 1] + 0.0722 * data[k * 4 + 2]
        histogram[luminance[k]]++
      }
      const low = percentile(histogram, 0.02)
      const high = Math.max(low + 1, percentile(histogram, 0.98))

      // The sheet is dark hands on white, so the hand is what lights up.
      values = new Float32Array(count)
      seeds = new Float32Array(count)
      for (let k = 0; k < count; k++) {
        values[k] = 1 - Math.min(1, Math.max(0, (luminance[k] - low) / (high - low)))
        seeds[k] = hash(k % cols, Math.floor(k / cols))
      }
      draw(performance.now())
    }

    function draw(now: number) {
      const shown = reveal ? reveal.get() : 1
      if (shown <= 0 && blank) return
      blank = shown <= 0
      const t = still ? 0 : now / 1000
      const tick = Math.floor(t * 14)

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = color
      ctx.beginPath()
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i
          const seed = seeds[k]
          if (values[k] < BLACK || seed >= shown) continue
          // Cells that have only just arrived flicker before they settle.
          if (shown < 1 && shown - seed < FRONT && hash(i + tick, j - tick) < 0.5) continue
          const value = values[k] + (still ? 0 : SHIMMER * Math.sin(2.2 * t + seed * 2 * Math.PI))
          for (let b = 0; b < SUB; b++) {
            const row = ((j * SUB + b) & 7) * 8
            for (let a = 0; a < SUB; a++)
              if (value > THRESHOLD[row + ((i * SUB + a) & 7)]) ctx.rect(i * cellSize + a * sub, j * cellSize + b * sub, dot, dot)
          }
        }
      }
      ctx.fill()
    }

    function loop(now: number) {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME) return
      last = now
      draw(now)
    }

    const resize = new ResizeObserver(layout)
    const watch = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(raf)
      if (entry.isIntersecting && !still) raf = requestAnimationFrame(loop)
    })
    void loadSheet().then((loaded) => {
      if (!alive) return
      image = loaded
      resize.observe(canvas)
      watch.observe(canvas)
    })

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
    }
  }, [region, cellSize, color, reveal])

  return <canvas ref={ref} className="dither" aria-hidden="true" />
}
