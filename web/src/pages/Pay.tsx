import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../components/Loading'
import { config } from '../lib/config'
import { parseUsd, usd } from '../lib/money'
import { getWorker, pay, payAccount } from '../lib/preday'
import { COINS, estimate, loadTokens } from '../lib/tokens'
import { useAction } from '../lib/useAction'
import { useLive } from '../lib/useLive'

const MIN = 1_000_000n

export function Pay() {
  const handle = (useParams().handle ?? '').toLowerCase()
  return <PayPage key={handle} handle={handle} />
}

function PayPage({ handle }: { handle: string }) {
  const worker = useLive(() => getWorker(handle))
  const [paid, setPaid] = useState<bigint | null>(null)

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
        <p className="amount">{usd(paid)}</p>
        <div className="stack">
          <a href={`${config.explorer}/address/${payAccount(handle)}`} target="_blank" rel="noreferrer">
            See {handle}'s pay account on the testnet explorer
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

function PayForm({ handle, onPaid }: { handle: string; onPaid: (amount: bigint) => void }) {
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

  return (
    <form
      className="narrow panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        void action.run(async () => {
          await pay(handle, amount)
          onPaid(amount)
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
          {sends && (
            <div>
              <dt>You send about</dt>
              <dd>{sends}</dd>
            </div>
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
          This demo runs on NEAR testnet, where real coins cannot be routed. Test dollars take the same path through
          the contract.
        </p>
      </div>
    </form>
  )
}
