import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_MS = 8_000

/** Loads on mount and keeps the data fresh. `refresh()` resolves once new data is in. */
export function useLive<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [failed, setFailed] = useState(false)
  const latest = useRef(load)

  useEffect(() => {
    latest.current = load
  })

  const refresh = useCallback(async () => {
    try {
      setData(await latest.current())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return { data, failed, refresh }
}
