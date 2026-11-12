import { duration, usd } from '../lib/money'
import { verify, type Limit, type Params, type Worker } from '../lib/preday'
import { useAction } from '../lib/useAction'

const DAY_MS = 86_400_000

type Props = { worker: Worker; limit: Limit; params: Params; now: number; onChange: () => Promise<void> }

/** Shown until the first advance opens: what is still missing, in the worker's terms. */
export function Requirements({ worker, limit, params, now, onChange }: Props) {
  const action = useAction()
  const wait = worker.first_payment_at === null ? null : worker.first_payment_at + params.min_history_ms - now

  return (
    <section className="panel">
      <p className="cap">{BigInt(limit.base) > 0n ? 'Next payment, usually around' : 'Next payment'}</p>
      <p className="amount">{usd(limit.base)}</p>
      {worker.banned ? (
        <p className="note late">
          An earlier advance was never paid back, so advances are closed for you. Your pay link keeps working.
        </p>
      ) : (
        <>
          <h2>Before you can take part of it early</h2>
          <ul className="checks">
            <li>
              {params.min_payments} payments to your link
              {worker.payments_count >= params.min_payments ? (
                <span className="ok">Done</span>
              ) : (
                <span className="muted num">
                  {worker.payments_count} of {params.min_payments}
                </span>
              )}
            </li>
            <li>
              {duration(params.min_history_ms)} since your first payment
              {wait === null ? (
                <span className="muted">Starts with your first payment</span>
              ) : wait <= 0 ? (
                <span className="ok">Done</span>
              ) : (
                <span className="muted num">{duration(wait)} left</span>
              )}
            </li>
            <li>
              One identity check
              {worker.verified ? (
                <span className="ok">Done</span>
              ) : (
                <button
                  className="btn small"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await verify(worker.handle)
                      await onChange()
                    })
                  }
                >
                  {action.busy ? 'Verifying...' : 'Verify identity'}
                </button>
              )}
            </li>
          </ul>
          {action.error && (
            <p className="note late" role="alert">
              {action.error}
            </p>
          )}
          {!worker.verified && (
            <p className="note">
              This demo uses a stand-in identity check that approves everyone. The real one checks a person once.
            </p>
          )}
          {params.min_history_ms < DAY_MS && (
            <p className="note">
              The wait is {duration(params.min_history_ms)} in this demo, 30 days in production.
            </p>
          )}
        </>
      )}
    </section>
  )
}
