import { useEffect, useRef } from 'react'

// Adapted from the Amount Slider by serafimcloud on 21st.dev: the same live grid of squares
// and rolling digits, rebuilt on a native range input with no styling framework.

const CELL = 6
const GAP = 1
const THUMB = 24

const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

type Props = { label: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void }

/** A range input whose track is a grid of shimmering squares. A busy tail follows the thumb and grows with the value. */
export function AmountSlider({ label, min, max, step, value, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fraction = (value - min) / (max - min)
  const fractionRef = useRef(fraction)

  useEffect(() => {
    fractionRef.current = fraction
  }, [fraction])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const color = getComputedStyle(canvas).color
    let width = 0
    let height = 0
    let raf = 0
    let visible = true
    let last = performance.now()
    let phase = 0
    let drift = 0

    function draw(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const fill = fractionRef.current
      phase += dt * (0.3 + fill * 3.2)
      drift += dt
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = color

      const thumbX = THUMB / 2 + fill * (width - THUMB)
      const tail = fill * 0.6 * width
      const hint = 0.15 * (1 - fill)
      for (let cx = 0; cx * CELL < width; cx++) {
        const x = cx * CELL + CELL / 2
        const behind = x <= thumbX
        let base: number
        if (behind) {
          const band = tail > 0.5 ? 1 - (thumbX - x) / tail : 0
          if (band <= 0) continue
          base = band * band
        } else {
          // A faint crest drifts toward the far end to say "drag this way for more".
          const along = (x - thumbX) / (width - thumbX)
          base = hint * Math.sin(along * Math.PI) * (0.5 + 0.5 * Math.sin((x / width) * 5 - drift * 4.5))
          if (base <= 0.002) continue
        }
        for (let cy = 0; cy * CELL < height; cy++) {
          const seed = hash(cx, cy) * Math.PI * 2
          const flicker = behind
            ? 0.35 + 0.325 * (1 + Math.sin(phase * 2.4 + cx * 0.9 + cy * 0.4 + seed))
            : 0.6 + 0.2 * (1 + Math.sin(phase * 1.7 + seed))
          const alpha = Math.min(1, base * (0.6 + 0.4 * hash(cx + 7.3, cy - 3.1)) * (still ? 1 : flicker))
          if (alpha < 0.015) continue
          ctx.globalAlpha = alpha
          ctx.fillRect(cx * CELL, cy * CELL, CELL - GAP, CELL - GAP)
        }
      }
      ctx.globalAlpha = 1
    }

    function loop(now: number) {
      if (visible) draw(now)
      raf = requestAnimationFrame(loop)
    }

    const resize = new ResizeObserver(() => {
      const dpr = Math.min(2, devicePixelRatio)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw(performance.now())
    })
    const watch = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    resize.observe(canvas)
    watch.observe(canvas)
    // The loop also runs with reduced motion: the flicker is frozen, but the tail still has to follow the thumb.
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
    }
  }, [])

  return (
    <div className="slider">
      <canvas ref={canvasRef} aria-hidden="true" />
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="slider-thumb" style={{ left: `calc(${fraction} * (100% - ${THUMB}px))` }} aria-hidden="true" />
    </div>
  )
}

/** A dollar amount with one column per digit. A changed digit rolls to its new value instead of cutting. */
export function AmountReadout({ value }: { value: number }) {
  const text = Math.round(value).toLocaleString('en-US')

  return (
    <span className="readout" role="status" aria-label={`$${text}`}>
      <span aria-hidden="true">$</span>
      {[...text].map((char, index) =>
        // Keyed from the right, so a place value keeps its column when the number grows.
        char === ',' ? (
          <span key={text.length - index} aria-hidden="true">
            ,
          </span>
        ) : (
          <span key={text.length - index} className="readout-digit" aria-hidden="true">
            <span style={{ transform: `translateY(-${char}em)` }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </span>
          </span>
        ),
      )}
    </span>
  )
}
