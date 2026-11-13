import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../components/Loading'
import { config } from '../lib/config'
import { parseUsd, usd } from '../lib/money'
import { guestId } from '../lib/near'
import { getWorker, pay, type Receipt } from '../lib/preday'
import { COINS, estimate, loadTokens, quote, type Quote } from '../lib/tokens'
import { useAction } from '../lib/useAction'
import { useLive } from '../lib/useLive'

const MIN = 1_000_000n

const about = (seconds: number) => (seconds >= 90 ? `about ${Math.round(seconds / 60)} min` : `about ${seconds} sec`)

export function Pay() {
  const handle = (useParams().handle ?? '').toLowerCase()
  return <PayPage key={handle} handle={handle} />
}

function PayPage({ handle }: { handle: string }) {
  const worker = useLive(() => getWorker(handle))
  const [paid, setPaid] = useState<Receipt | null>(null)

  if (worker.data === undefined) return <Loading failed={worker.failed} />

  if (worker.data === null) {
    return (
      <div className="narrow panel stack">
        <h2>Nobody has claimed preday.app/{handle} yet</h2>
        <p className="muted">If this is the name you want to be paid at, it can be yours.</p>
        <Link to="/app" className="btn">
          Claim a pay link
        </Link>
      </div>
    )
  }

  if (paid !== null) {
    return (
      <div className="narrow panel">
        <p className="cap">Paid. {handle} received</p>
        <p className="amount">{usd(paid.amount)}</p>
        <dl className="rows num">
          <div>
            <dt>Recorded in {handle}'s payment history</dt>
            <dd>{usd(paid.amount, 'always')}</dd>
          </div>
          {/* Only the owner of the link sees how the payment was split. A client has no business knowing about an advance. */}
          {worker.data.owner === guestId() && (
            <>
              {paid.repaid + paid.fee > 0n && (
                <div>
                  <dt>Paid back your advance and its fee</dt>
                  <dd>{usd(paid.repaid + paid.fee, 'always')}</dd>
                </div>
              )}
              <div>
                <dt>Sent to your wallet</dt>
                <dd>{usd(paid.forwarded, 'always')}</dd>
              </div>
            </>
          )}
        </dl>
        <div className="stack receipt-actions">
          <a href={`${config.explorer}/txns/${paid.hash}`} target="_blank" rel="noreferrer">
            See this payment on the testnet explorer
          </a>
          <button className="btn ghost wide" onClick={() => setPaid(null)}>
            Pay again
          </button>
        </div>
      </div>
    )
  }

  return <PayForm handle={handle} onPaid={setPaid} />
}

function PayForm({ handle, onPaid }: { handle: string; onPaid: (receipt: Receipt) => void }) {
  const [input, setInput] = useState('')
  const [coin, setCoin] = useState(COINS[0])
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof loadTokens>>>([])
  const action = useAction()

  useEffect(() => {
    void loadTokens().then(setTokens)
  }, [])

  const amount = parseUsd(input)
  const valid = amount !== null && amount >= MIN
  const sends = valid ? estimate(tokens, coin, amount) : null

  const asked = valid ? `${coin.label} ${amount}` : null
  const [answer, setAnswer] = useState<{ asked: string; quote: Quote | null } | null>(null)
  const live = answer?.asked === asked ? answer.quote : null

  useEffect(() => {
    if (asked === null || amount === null) return
    const control = new AbortController()
    const timer = setTimeout(() => {
      void quote(tokens, coin, amount, control.signal).then((found) => {
        if (!control.signal.aborted) setAnswer({ asked, quote: found })
      })
    }, 400)
    return () => {
      clearTimeout(timer)
      control.abort()
    }
  }, [tokens, coin, amount, asked])

  return (
    <form
      className="narrow panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        void action.run(async () => {
          onPaid(await pay(handle, amount))
        })
      }}
    >
      <label className="cap" htmlFor="pay-amount">
        Pay {handle}
      </label>
      <div className="amount entry">
        $
        <input
          id="pay-amount"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          aria-invalid={Boolean(input) && !valid}
          aria-describedby="pay-help"
        />
      </div>
      <div className="stack">
        {input && !valid && (
          <p className="note late" id="pay-help">
            Enter an amount in dollars, $1 or more.
          </p>
        )}
        <div className="field">
          <span id="pay-with">Pay with</span>
          <div className="chips" role="group" aria-labelledby="pay-with">
            {COINS.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={option === coin}
                onClick={() => setCoin(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <dl className="rows num">
          {live ? (
            <>
              <div>
                <dt>You send</dt>
                <dd>{live.sends}</dd>
              </div>
              {live.seconds > 0 && (
                <div>
                  <dt>Arrives via NEAR Intents in</dt>
                  <dd>{about(live.seconds)}</dd>
                </div>
              )}
            </>
          ) : (
            sends && (
              <div>
                <dt>You send about</dt>
                <dd>{sends}</dd>
              </div>
            )
          )}
          <div>
            <dt>{handle} gets</dt>
            <dd>{usd(valid ? amount : 0n, 'always')}</dd>
          </div>
        </dl>
        <button className="btn wide" disabled={!valid || action.busy}>
          {action.busy ? 'Paying...' : 'Pay with test dollars'}
        </button>
        {action.error && (
          <p className="note late" role="alert">
            {action.error}
          </p>
        )}
        <p className="note">
          The quote is live from NEAR Intents on mainnet. The demo itself runs on NEAR testnet, where real coins
          cannot be routed, so the payment uses test dollars on the same path through the contract.
        </p>
      </div>
    </form>
  )
}
