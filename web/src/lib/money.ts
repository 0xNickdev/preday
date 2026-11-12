/** USDC has 6 decimals. Every amount in the app is a bigint of minimal units. */
const UNIT = 1_000_000n

export function usd(units: bigint | string, cents: 'auto' | 'always' = 'auto') {
  const value = BigInt(units)
  const whole = (value / UNIT).toLocaleString('en-US')
  const fraction = Number((value % UNIT) / 10_000n)
  if (cents === 'auto' && fraction === 0) return `$${whole}`
  return `$${whole}.${String(fraction).padStart(2, '0')}`
}

export function parseUsd(input: string): bigint | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''))
  if (!match) return null
  return BigInt(match[1]) * UNIT + BigInt((match[2] ?? '').padEnd(2, '0')) * 10_000n
}

export function date(ms: number) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Date and time of day, for lists where several things happen on the same day. */
export function dateTime(ms: number) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function duration(ms: number) {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours} hours`
  return `${Math.ceil(hours / 24)} days`
}
