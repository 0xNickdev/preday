import { useState } from 'react'
import { explain } from './preday'

/** One button's worth of state: busy while it runs, and the error to show next to it. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(explain(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, run }
}
