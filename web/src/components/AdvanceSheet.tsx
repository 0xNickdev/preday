import { useEffect, useRef, useState } from 'react'
import { parseUsd, usd } from '../lib/money'
import { feeFor, requestAdvance, type Params } from '../lib/preday'
import { useAction } from '../lib/useAction'

type Props = { limit: bigint; params: Params; onTaken: () => Promise<void>; onClose: () => void }

export function AdvanceSheet({ limit, params, onTaken, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [input, setInput] = useState(() => usd(limit).slice(1))
  const action = useAction()

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  const entered = parseUsd(input)
  const amount = entered !== null && entered > 0n && entered <= limit ? entered : null
  const fee = amount === null ? null : feeFor(amount, params)

  return (
    <dialog className="sheet" ref={dialog} onClose={onClose} aria-labelledby="sheet-title">
      <form
        className="panel dark stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (amount === null) return
          void action.run(async () => {
            await requestAdvance(amount)
            await onTaken()
          })
        }}
      >
        <h2 id="sheet-title">Take part of your next payment now</h2>
        <label className="field">
          Amount
          <span className="input">
            <span>$</span>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={amount === null}
              aria-describedby="sheet-help"
            />
          </span>
        </label>
        <p className={amount === null ? 'note late' : 'note'} id="sheet-help">
          {amount === null ? `Enter an amount up to ${usd(limit)}.` : `Up to ${usd(limit)} today.`}
        </p>
        <dl className="rows num">
          <div>
            <dt>Fee</dt>
            <dd>{fee === null ? '-' : usd(fee, 'always')}</dd>
          </div>
          <div>
            <dt>You get now</dt>
            <dd>{amount === null ? '-' : usd(amount, 'always')}</dd>
          </div>
          <div>
            <dt>Taken from next payment</dt>
            <dd>{amount === null || fee === null ? '-' : usd(amount + fee, 'always')}</dd>
          </div>
          <div>
            <dt>If no payment comes</dt>
            <dd>Nothing is added</dd>
          </div>
        </dl>
        <button className="btn amber wide" disabled={amount === null || action.busy}>
          {action.busy ? 'Sending your money...' : `Confirm, get ${usd(amount ?? limit)}`}
        </button>
        <button type="button" className="btn ghost wide" onClick={() => dialog.current?.close()}>
          Not now
        </button>
        {action.error && (
          <p className="note late" role="alert">
            {action.error}
          </p>
        )}
      </form>
    </dialog>
  )
}
