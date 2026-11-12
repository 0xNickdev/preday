import { useEffect, useRef } from 'react'
import { useInView } from 'motion/react'

const DURATION = 1100

/** A dollar figure that counts up from zero once, the first time it is seen. */
export function CountUp({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true })
  const counted = useRef(false)

  useEffect(() => {
    // React owns this text node, so its value is changed in place and never replaced.
    const text = ref.current!.firstChild!
    if (!seen || counted.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const target = Number(value.replace(/[$,]/g, ''))
    const digits = value.split('.')[1]?.length ?? 0
    const started = performance.now()
    let raf = requestAnimationFrame(function frame(now) {
      const t = Math.min(1, (now - started) / DURATION)
      const current = (target * (1 - (1 - t) ** 3)).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
      text.nodeValue = t < 1 ? `$${current}` : value
      if (t < 1) raf = requestAnimationFrame(frame)
      else counted.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [seen, value])

  return <span ref={ref}>{value}</span>
}
