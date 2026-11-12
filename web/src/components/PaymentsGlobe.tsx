import { useEffect, useRef } from 'react'

// A dotted sphere on a plain canvas. Every arc ends at one worker, and payments travel one way: toward them.

type Place = { name: string; lat: number; lng: number }

const WORKER: Place = { name: 'You', lat: 38.72, lng: -9.14 }
const CLIENTS: Place[] = [
  { name: 'New York', lat: 40.71, lng: -74.01 },
  { name: 'Toronto', lat: 43.65, lng: -79.38 },
  { name: 'Sao Paulo', lat: -23.55, lng: -46.63 },
  { name: 'London', lat: 51.51, lng: -0.13 },
  { name: 'Berlin', lat: 52.52, lng: 13.4 },
  { name: 'Lagos', lat: 6.52, lng: 3.38 },
  { name: 'Dubai', lat: 25.2, lng: 55.27 },
  { name: 'Singapore', lat: 1.35, lng: 103.82 },
  { name: 'Tokyo', lat: 35.68, lng: 139.69 },
]

const DOTS = 1200
const FOV = 600
const INK = '17, 17, 17'
const SPECTRUM = ['#ffcf5a', '#7dffa8', '#5ad7ff', '#9b7bff', '#ff6fd8', '#ffb36b']

type Vec = [number, number, number]

function onSphere({ lat, lng }: Place): Vec {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lng + 180) * Math.PI) / 180
  return [-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)]
}

/** A Fibonacci lattice spreads the dots evenly, with no clumping at the poles. */
const SPHERE: Vec[] = Array.from({ length: DOTS }, (_, i) => {
  const theta = (2 * Math.PI * i) / ((1 + Math.sqrt(5)) / 2)
  const phi = Math.acos(1 - (2 * (i + 0.5)) / DOTS)
  return [Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi)]
})

export function PaymentsGlobe() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    // Start with the worker and most clients facing the viewer.
    let spin = 1.75
    let tilt = 0.35
    let width = 0
    let height = 0
    let raf = 0
    let visible = true
    let drag: { x: number; y: number; spin: number; tilt: number } | null = null
    const started = performance.now()

    function draw() {
      const time = (performance.now() - started) / 1000
      const cx = width / 2
      const cy = height / 2
      const radius = Math.min(width, height) * 0.4
      const cosT = Math.cos(tilt)
      const sinT = Math.sin(tilt)
      const cosS = Math.cos(spin)
      const sinS = Math.sin(spin)

      /** Rotates a unit vector and projects it. Negative depth faces the viewer. */
      const place = ([x, y, z]: Vec, lift = 1): Vec => {
        const y1 = y * cosT - z * sinT
        const z1 = y * sinT + z * cosT
        const x2 = (x * cosS + z1 * sinS) * radius * lift
        const z2 = (-x * sinS + z1 * cosS) * radius * lift
        const scale = FOV / (FOV + z2)
        return [x2 * scale + cx, y1 * radius * lift * scale + cy, z2 / radius]
      }

      ctx.clearRect(0, 0, width, height)
      for (const dot of SPHERE) {
        const [x, y, depth] = place(dot)
        if (depth > 0) continue
        const near = Math.max(0.1, -depth)
        ctx.fillStyle = `rgba(${INK}, ${(0.12 + near * 0.5).toFixed(2)})`
        ctx.beginPath()
        ctx.arc(x, y, 0.9 + near * 0.8, 0, Math.PI * 2)
        ctx.fill()
      }

      const worker = onSphere(WORKER)
      const [wx, wy, workerDepth] = place(worker)
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'

      CLIENTS.forEach((client, index) => {
        const from = onSphere(client)
        const [fx, fy, depth] = place(from)
        if (depth > 0.1) return

        ctx.fillStyle = `rgb(${INK})`
        ctx.beginPath()
        ctx.arc(fx, fy, 2.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgba(${INK}, 0.6)`
        ctx.fillText(client.name, fx + 8, fy + 4)
        if (workerDepth > 0.3) return

        // The arc bows away from the surface through a control point lifted above the midpoint.
        const mid: Vec = [from[0] + worker[0], from[1] + worker[1], from[2] + worker[2]]
        const length = Math.hypot(...mid)
        const [mx, my] = place([mid[0] / length, mid[1] / length, mid[2] / length], 1.3)
        ctx.strokeStyle = `rgba(${INK}, 0.22)`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(fx, fy)
        ctx.quadraticCurveTo(mx, my, wx, wy)
        ctx.stroke()

        const t = still ? 0.5 : (time * 0.22 + index * 0.37) % 1
        const u = 1 - t
        ctx.fillStyle = `rgb(${INK})`
        ctx.fillRect(u * u * fx + 2 * u * t * mx + t * t * wx - 2.5, u * u * fy + 2 * u * t * my + t * t * wy - 2.5, 5, 5)
      })

      if (workerDepth <= 0.1) {
        const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2)
        const ring = ctx.createLinearGradient(wx - 14, wy, wx + 14, wy)
        SPECTRUM.forEach((color, index) => ring.addColorStop(index / (SPECTRUM.length - 1), color))
        ctx.strokeStyle = ring
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(wx, wy, 9 + pulse * 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = `rgb(${INK})`
        ctx.beginPath()
        ctx.arc(wx, wy, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillText(WORKER.name, wx + 18, wy + 4)
      }
    }

    function loop() {
      if (visible) {
        if (!drag) spin += 0.0016
        draw()
      }
      raf = requestAnimationFrame(loop)
    }

    const resize = new ResizeObserver(() => {
      const dpr = Math.min(2, devicePixelRatio)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    })
    const watch = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting))
    resize.observe(canvas)
    watch.observe(canvas)

    const down = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY, spin, tilt }
      canvas.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent) => {
      if (!drag) return
      spin = drag.spin + (event.clientX - drag.x) * 0.005
      tilt = Math.max(-1, Math.min(1, drag.tilt + (event.clientY - drag.y) * 0.005))
      if (still) draw()
    }
    const up = () => (drag = null)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    document.fonts.load('500 11px "IBM Plex Mono"').finally(() => {
      if (!still) raf = requestAnimationFrame(loop)
      else draw()
    })

    return () => {
      cancelAnimationFrame(raf)
      resize.disconnect()
      watch.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      className="globe"
      role="img"
      aria-label="A globe of dots. Payments travel from clients in nine cities to one worker. Drag to rotate."
    />
  )
}
