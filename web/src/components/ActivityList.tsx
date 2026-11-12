import { dateTime, usd } from '../lib/money'
import type { Activity } from '../lib/preday'

/** One line per thing the contract did, in the worker's words. Money in is green, money that left is plain. */
function describe({ kind, amount, fee }: Activity): { text: string; value?: string; incoming?: boolean } {
  switch (kind) {
    case 'payment':
      return { text: 'Payment received', value: `+${usd(amount, 'always')}`, incoming: true }
    case 'advance':
      return { text: `Advance taken, fee ${usd(fee, 'always')}`, value: `+${usd(amount, 'always')}`, incoming: true }
    case 'repayment':
      return {
        text: BigInt(fee) > 0n ? `Paid back from that payment, with ${usd(fee, 'always')} fee` : 'Paid back from that payment',
        value: `-${usd(BigInt(amount) + BigInt(fee), 'always')}`,
      }
    case 'closed':
      return { text: 'Advance paid back in full' }
    case 'late':
      return { text: 'Advance marked late, limit paused' }
    case 'written_off':
      return { text: 'Advance written off', value: usd(amount, 'always') }
  }
}

export function ActivityList({ activity, count }: { activity: Activity[]; count: number }) {
  if (activity.length === 0) return <p className="muted">Nothing yet. Send your link to a client.</p>

  return (
    <ul className="rows activity">
      {activity.map((entry, index) => {
        const { text, value, incoming } = describe(entry)
        return (
          <li key={count - index}>
            <span>
              {text}
              <small>{dateTime(entry.at)}</small>
            </span>
            {value && <span className={incoming ? 'in num' : 'num'}>{value}</span>}
          </li>
        )
      })}
    </ul>
  )
}
