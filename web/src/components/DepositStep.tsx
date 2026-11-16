import { useEffect, useRef, useState } from 'react'
import { usd } from '../lib/money'
import { depositStatus, type Deposit, type DepositStatus } from '../lib/tokens'
import { Countdown } from './Countdown'
import { Qr } from './Qr'

const POLL_MS = 5_000

const PROGRESS: Partial<Record<DepositStatus, string>> = {
  PENDING_DEPOSIT: 'Waiting for your transfer',
  KNOWN_DEPOSIT_TX: 'Transfer seen, waiting for the network to confirm it',
  PROCESSING: 'Confirmed, converting to dollars',
}

const STOPPED: Partial<Record<DepositStatus, string>> = {
  INCOMPLETE_DEPOSIT: 'Less arrived than the quote asked for. It goes back to your refund address.',
  REFUNDED: 'The transfer could not be converted and went back to your refund address.',
  FAILED: 'The conversion failed. Anything you sent goes back to your refund address.',
}

type Props = {
  handle: string
  amount: bigint
  network: string
  deposit: Deposit
  /** Milliseconds until the quote's deadline, measured when the quote arrived. */
  left: number
  onPaid: () => void
  onBack: () => void
}

/** Step two of a real payment: where to send the coin, how long the quote holds, and what has happened to it. */
export function DepositStep({ handle, amount, network, deposit, left, onPaid, onBack }: Props) {
  const [status, setStatus] = useState<DepositStatus>('PENDING_DEPOSIT')
  const [expired, setExpired] = useState(false)
  const [copied, setCopied] = useState(false)
  const stopped = STOPPED[status]
  // A transfer that was already seen is still delivered after the deadline, so only an untouched quote expires.
  const lapsed = expired && status === 'PENDING_DEPOSIT'

  // The parent re-renders on every poll of its own, and restarting this one for a new callback would starve it.
  const paid = useRef(onPaid)
  useEffect(() => {
    paid.current = onPaid
  })

  useEffect(() => {
    if (stopped || lapsed) return
    const control = new AbortController()
    const check = async () => {
      const next = await depositStatus(deposit.address, control.signal)
      if (control.signal.aborted || next === null) return
      if (next === 'SUCCESS') paid.current()
      else setStatus(next)
    }
    const timer = setInterval(() => void check(), POLL_MS)
    return () => {
      clearInterval(timer)
      control.abort()
    }
  }, [deposit.address, stopped, lapsed])

  async function copy() {
    try {
      await navigator.clipboard.writeText(deposit.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The address is on screen and selectable.
    }
  }

  return (
    <div className="narrow panel">
      <p className="cap">Send exactly</p>
      <p className="amount small">{deposit.sends}</p>
      <div className="stack">
        <div className="deposit">
          <Qr value={deposit.address} label={`QR code of the ${network} address to send to`} />
          <div className="stack">
            <p className="muted">To this address on {network}</p>
            <p className="mono address">{deposit.address}</p>
            <button type="button" className="btn small" onClick={copy}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
        </div>
        <dl className="rows num">
          {deposit.memo && (
            <div>
              <dt>Memo, required</dt>
              <dd className="mono">{deposit.memo}</dd>
            </div>
          )}
          <div>
            <dt>{handle} gets</dt>
            <dd>{usd(amount, 'always')}</dd>
          </div>
          <div>
            <dt>Quote valid</dt>
            <dd>{lapsed ? 'Expired' : <Countdown ms={left} onDone={async () => setExpired(true)} />}</dd>
          </div>
        </dl>
        {stopped || lapsed ? (
          <p className="note late" role="alert">
            {stopped ?? 'This quote expired before a transfer arrived. Do not send to this address any more.'}
          </p>
        ) : (
          <p className="waiting" role="status">
            {PROGRESS[status]}
          </p>
        )}
        <button type="button" className="btn ghost wide" onClick={onBack}>
          {stopped || lapsed ? 'Get a new quote' : 'Change amount or coin'}
        </button>
        <p className="note">
          NEAR Intents converts what you send and delivers dollars to {handle}'s pay account. If less arrives, or it
          arrives after the deadline, it is returned to your refund address.
        </p>
      </div>
    </div>
  )
}
