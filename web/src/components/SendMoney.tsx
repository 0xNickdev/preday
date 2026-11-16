import { useEffect, useState } from 'react'
import { parseUsd, usd } from '../lib/money'
import { sendDollars } from '../lib/preday'
import { COINS, about, loadTokens, payoutFee, payoutQuote, type Payout } from '../lib/tokens'
import { useAction } from '../lib/useAction'

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/

type Tokens = Awaited<ReturnType<typeof loadTokens>>
type Answer = { asked: string; payout: Payout | null; error?: string }

/** Moves dollars out of the worker's own wallet. The contract is not involved: this money is already theirs. */
export function SendMoney({ balance, onSent }: { balance: string; onSent: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [abroad, setAbroad] = useState(false)
  const [coin, setCoin] = useState(COINS[0])
  const [to, setTo] = useState('')
  const [input, setInput] = useState('')
  const [tokens, setTokens] = useState<Tokens>([])
  const [answer, setAnswer] = useState<Answer | null>(null)
  const action = useAction()

  const amount = parseUsd(input)
  const affordable = amount !== null && amount > 0n && amount <= BigInt(balance)
  const valid = affordable && !abroad && ACCOUNT.test(to)

  useEffect(() => {
    if (abroad) void loadTokens().then(setTokens)
  }, [abroad])

  // Sending to another network is priced live by NEAR Intents, with the Preday fee taken first.
  const asked = abroad && affordable && to ? `${coin.label} ${to} ${amount}` : null
  const live = answer?.asked === asked ? answer : null

  useEffect(() => {
    if (asked === null || amount === null) return
    const control = new AbortController()
    const timer = setTimeout(() => {
      payoutQuote(tokens, coin, amount, to, control.signal)
        .then((payout) => ({ asked, payout }))
        .catch((error: Error) => ({ asked, payout: null, error: error.message }))
        .then((next) => {
          if (!control.signal.aborted) setAnswer(next)
        })
    }, 400)
    return () => {
      clearTimeout(timer)
      control.abort()
    }
  }, [tokens, coin, amount, to, asked])

  if (!open) {
    return (
      <button className="btn small ghost" disabled={BigInt(balance) === 0n} onClick={() => setOpen(true)}>
        Send money
      </button>
    )
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        void action.run(async () => {
          await sendDollars(to, amount)
          await onSent()
          setOpen(false)
          setInput('')
        })
      }}
    >
      <div className="chips" role="group" aria-label="Where to send">
        {['A NEAR account', 'Another network'].map((label, index) => (
          <button
            key={label}
            type="button"
            aria-pressed={abroad === Boolean(index)}
            onClick={() => {
              setAbroad(Boolean(index))
              setTo('')
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {abroad && (
        <div className="chips" role="group" aria-label="They receive">
          {COINS.map((option) => (
            <button key={option.label} type="button" aria-pressed={option === coin} onClick={() => setCoin(option)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      <label className="field">
        {abroad ? `To an address on ${coin.network}` : 'To a NEAR account'}
        <span className="input">
          <input
            value={to}
            onChange={(event) => setTo(abroad ? event.target.value.trim() : event.target.value.trim().toLowerCase())}
            autoComplete="off"
            spellCheck={false}
            placeholder={abroad ? undefined : 'friend.testnet'}
          />
        </span>
      </label>
      <label className="field">
        Amount, up to {usd(balance, 'always')}
        <span className="input">
          <span>$</span>
          <input value={input} onChange={(event) => setInput(event.target.value)} inputMode="decimal" autoComplete="off" />
        </span>
      </label>
      {abroad && affordable && (
        <dl className="rows num">
          <div>
            <dt>Preday fee, 0.3%</dt>
            <dd>{usd(payoutFee(amount), 'always')}</dd>
          </div>
          {live?.payout && (
            <>
              <div>
                <dt>They get about</dt>
                <dd>{live.payout.gets}</dd>
              </div>
              {live.payout.seconds > 0 && (
                <div>
                  <dt>Arrives via NEAR Intents in</dt>
                  <dd>{about(live.payout.seconds)}</dd>
                </div>
              )}
            </>
          )}
        </dl>
      )}
      {live?.error && <p className="note late">{live.error}</p>}
      <button className="btn small" disabled={!valid || action.busy}>
        {abroad ? 'Opens with mainnet' : action.busy ? 'Sending...' : valid ? `Send ${usd(amount, 'always')}` : 'Send'}
      </button>
      {action.error && (
        <p className="note late" role="alert">
          {action.error}
        </p>
      )}
      <p className="note">
        {abroad
          ? 'The quote is live from NEAR Intents on mainnet. Test dollars cannot leave NEAR testnet, so this shows what a real withdrawal would deliver. Sending to a NEAR account is always free.'
          : 'Sending to a NEAR account is free. Other networks cost 0.3% and use the same routing as incoming payments.'}
      </p>
    </form>
  )
}
