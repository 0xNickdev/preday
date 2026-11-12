import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdvancePanel } from '../components/AdvancePanel'
import { Claim } from '../components/Claim'
import { Loading } from '../components/Loading'
import { date, usd } from '../lib/money'
import { guestId } from '../lib/near'
import { claim, getBalance, getHandle, getLimit, getParams, getRecentPayments, getWorker } from '../lib/preday'
import { useAction } from '../lib/useAction'
import { useLive } from '../lib/useLive'

export function Dashboard() {
  const handle = useLive(async () => {
    const guest = guestId()
    return guest ? getHandle(guest) : null
  })

  if (handle.data === undefined) return <Loading failed={handle.failed} />
  if (handle.data === null) return <Claim onClaimed={handle.refresh} />
  return <Home handle={handle.data} />
}

async function loadHome(handle: string) {
  const [worker, limit, params] = await Promise.all([getWorker(handle), getLimit(handle), getParams()])
  if (!worker) throw new Error('unknown handle')
  const [payments, balance] = await Promise.all([
    getRecentPayments(handle, worker.payments_count),
    getBalance(worker.owner),
  ])
  // The time of the read, so the remaining wait is counted from the same moment as the data.
  return { worker, limit, params, payments, balance, now: Date.now() }
}

function Home({ handle }: { handle: string }) {
  const live = useLive(() => loadHome(handle))
  if (!live.data) return <Loading failed={live.failed} />

  const { worker, limit, params, payments, balance, now } = live.data
  const level = Math.min(worker.level, params.ladder.length - 1)

  return (
    <div className="cols">
      <div>
        <AdvancePanel worker={worker} limit={limit} params={params} now={now} onChange={live.refresh} />
        <section className="panel">
          <h2>Payments</h2>
          {payments.length === 0 ? (
            <p className="muted">No payments yet. Send your link to a client.</p>
          ) : (
            <ul className="rows num">
              {payments.map((payment, index) => (
                <li key={worker.payments_count - index}>
                  <span>{date(payment.at)}</span>
                  <span className="in">+{usd(payment.amount, 'always')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside>
        <section className="panel">
          <h2>In your wallet</h2>
          <p className="balance num">{usd(balance, 'always')}</p>
          <p className="note">
            Payments and advances arrive here, in <span className="mono">{worker.owner}</span>. Preday does not hold
            them.
          </p>
        </section>
        <PayLink handle={handle} />
        <section className="panel">
          <h2>Your limit</h2>
          <ol className="ladder num">
            {params.ladder.map((step, index) => (
              <li key={step} aria-current={index === level ? 'step' : undefined}>
                {usd(step)}
              </li>
            ))}
          </ol>
          <p className="note">
            You can take up to {params.base_share_bps / 100}% of your usual payment, capped at the step you are on. The
            cap doubles each time an advance is paid back on time.
          </p>
        </section>
        {BigInt(worker.pending) > 0n && <Waiting amount={worker.pending} onClaimed={live.refresh} />}
      </aside>
    </div>
  )
}

function PayLink({ handle }: { handle: string }) {
  const [label, setLabel] = useState('Copy link')
  const url = `${location.origin}${import.meta.env.BASE_URL}${handle}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setLabel('Copied')
    } catch {
      setLabel('Could not copy, select the link')
    }
    setTimeout(() => setLabel('Copy link'), 2000)
  }

  return (
    <section className="panel">
      <h2>Your pay link</h2>
      <div className="stack">
        <p className="mono">{url.replace(/^https?:\/\//, '')}</p>
        <button className="btn small" onClick={copy}>
          {label}
        </button>
        <Link to={`/${handle}`} className="btn small ghost">
          Open pay page
        </Link>
      </div>
    </section>
  )
}

/** Money the contract could not deliver to the owner's account stays with it until claimed. */
function Waiting({ amount, onClaimed }: { amount: string; onClaimed: () => Promise<void> }) {
  const action = useAction()

  return (
    <section className="panel">
      <h2>Money waiting for you</h2>
      <div className="stack">
        <p className="muted">{usd(amount, 'always')} could not be sent to your account earlier. It is still yours.</p>
        <button
          className="btn small"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              await claim()
              await onClaimed()
            })
          }
        >
          {action.busy ? 'Sending...' : `Claim ${usd(amount, 'always')}`}
        </button>
        {action.error && (
          <p className="note late" role="alert">
            {action.error}
          </p>
        )}
      </div>
    </section>
  )
}
