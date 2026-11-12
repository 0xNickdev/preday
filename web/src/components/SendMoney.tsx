import { useState } from 'react'
import { parseUsd, usd } from '../lib/money'
import { sendDollars } from '../lib/preday'
import { useAction } from '../lib/useAction'

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/

/** Moves dollars out of the worker's own wallet. The contract is not involved: this money is already theirs. */
export function SendMoney({ balance, onSent }: { balance: string; onSent: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [input, setInput] = useState('')
  const action = useAction()

  const amount = parseUsd(input)
  const valid = amount !== null && amount > 0n && amount <= BigInt(balance) && ACCOUNT.test(to)

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
      <label className="field">
        To a NEAR account
        <span className="input">
          <input
            value={to}
            onChange={(event) => setTo(event.target.value.trim().toLowerCase())}
            autoComplete="off"
            spellCheck={false}
            placeholder="friend.testnet"
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
      <button className="btn small" disabled={!valid || action.busy}>
        {action.busy ? 'Sending...' : valid ? `Send ${usd(amount, 'always')}` : 'Send'}
      </button>
      {action.error && (
        <p className="note late" role="alert">
          {action.error}
        </p>
      )}
      <p className="note">
        On testnet money can only move between NEAR accounts. Sending to other networks uses the same routing as
        incoming payments and opens with mainnet.
      </p>
    </form>
  )
}
