import { usd } from '../lib/money'
import type { Pool } from '../lib/preday'
import { CountUp } from './CountUp'

const PRICE_UNIT = 10_000n

/** Dollars one pool share is worth, to four decimals. An empty pool starts at $1. */
function sharePrice(pool: Pool) {
  const shares = BigInt(pool.total_shares)
  const price = shares === 0n ? PRICE_UNIT : (BigInt(pool.assets) * PRICE_UNIT) / shares
  return `$${price / PRICE_UNIT}.${String(price % PRICE_UNIT).padStart(4, '0')}`
}

export function PoolFigures({ pool }: { pool: Pool }) {
  return (
    <dl className="figures num">
      <div>
        <dt>Pool size</dt>
        <dd>
          <CountUp value={usd(pool.assets)} />
        </dd>
      </div>
      <div>
        <dt>Out in advances</dt>
        <dd>
          <CountUp value={usd(pool.lent)} />
        </dd>
      </div>
      <div>
        <dt>Reserve</dt>
        <dd>
          <CountUp value={usd(pool.reserve)} />
        </dd>
      </div>
      <div>
        <dt>Share price</dt>
        <dd>
          <CountUp value={sharePrice(pool)} />
        </dd>
      </div>
    </dl>
  )
}
