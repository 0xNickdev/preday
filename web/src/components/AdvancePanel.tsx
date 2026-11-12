import { useState } from 'react'
import { usd } from '../lib/money'
import type { Limit, Params, Worker } from '../lib/preday'
import { AdvanceSheet } from './AdvanceSheet'
import { Requirements } from './Requirements'

const DOTS = 30

type Props = { worker: Worker; limit: Limit; params: Params; now: number; onChange: () => Promise<void> }

/** The one thing the dashboard is about: what is owed, what can be taken, or what is missing. */
export function AdvancePanel(props: Props) {
  const { worker, limit, params, onChange } = props
  const [confirming, setConfirming] = useState(false)
  const { advance } = worker

  if (advance) {
    const owed = BigInt(advance.principal) + BigInt(advance.fee) - BigInt(advance.repaid)
    return (
      <section className="panel">
        <p className="cap">Advance open</p>
        <p className="amount">{usd(owed)}</p>
        <dl className="rows num">
          <div>
            <dt>You got</dt>
            <dd>{usd(advance.principal, 'always')}</dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>{usd(advance.fee, 'always')}</dd>
          </div>
          <div>
            <dt>Paid back so far</dt>
            <dd>{usd(advance.repaid, 'always')}</dd>
          </div>
        </dl>
        {advance.late ? (
          <p className="note late">No payment for a while. Your limit is paused until this is paid back.</p>
        ) : (
          <p className="note">Taken from your next payment. Nothing to do.</p>
        )}
      </section>
    )
  }

  if (!limit.eligible) return <Requirements {...props} />

  const lit = Math.round((Number(limit.limit) / Number(limit.base)) * DOTS)
  return (
    <section className="panel">
      <p className="cap">Next payment, usually around</p>
      <p className="amount">{usd(limit.base)}</p>
      <div className="meter" aria-hidden="true">
        {Array.from({ length: DOTS }, (_, index) => (
          <i key={index} className={index < lit ? 'on' : undefined} />
        ))}
      </div>
      <div className="stack">
        <p>You can take up to {usd(limit.limit)} of it today.</p>
        <button className="btn glow wide" onClick={() => setConfirming(true)}>
          Get {usd(limit.limit)} now
        </button>
      </div>
      {confirming && (
        <AdvanceSheet
          limit={BigInt(limit.limit)}
          params={params}
          onTaken={async () => {
            await onChange()
            setConfirming(false)
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
