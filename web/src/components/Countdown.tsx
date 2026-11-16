import { useEffect, useRef, useState } from 'react'
import { duration } from '../lib/money'

/** Counts a short wait down by the second, then asks for fresh data. Long waits stay in days and hours. */
export function Countdown({ ms, onDone }: { ms: number; onDone: () => Promise<void> }) {
  const [left, setLeft] = useState(ms)
  // The callback changes identity on every render, and restarting the timer for that would rewind it.
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })

  useEffect(() => {
    const until = Date.now() + ms
    const timer = setInterval(() => {
      const remaining = until - Date.now()
      setLeft(remaining)
      if (remaining <= 0) {
        clearInterval(timer)
        void done.current()
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [ms])

  if (left > 3_600_000) return <span className="muted num">{duration(left)} left</span>
  const seconds = Math.max(0, Math.ceil(left / 1000))
  return (
    <span className="muted num">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} left
    </span>
  )
}
