import { useState } from 'react'
import { usd } from '../lib/money'
import { AmountReadout, AmountSlider } from './AmountSlider'

/** The production rule set: 30% of a typical payment, capped by the step, 5% fee with a $1 minimum. */
const STEPS = [25, 50, 100, 200, 400]

const units = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n

export function Calculator() {
  const [payment, setPayment] = useState(1200)
  const [step, setStep] = useState(0)

  const advance = Math.min(Math.floor(payment * 0.3), STEPS[step])
  const fee = Math.max(advance * 0.05, 1)

  return (
    <div className="panel calculator">
      <p className="cap">A typical payment from your clients</p>
      <p className="amount">
        <AmountReadout value={payment} />
      </p>
      <AmountSlider label="Typical payment in dollars" min={100} max={5000} step={50} value={payment} onChange={setPayment} />

      <p className="cap">Advances you have paid back on time</p>
      <div className="chips">
        {STEPS.map((cap, index) => (
          <button key={cap} type="button" aria-pressed={index === step} onClick={() => setStep(index)}>
            {index}
          </button>
        ))}
      </div>

      <dl className="rows">
        <div>
          <dt>You can take today</dt>
          <dd className="num">
            <AmountReadout value={advance} />
          </dd>
        </div>
        <div>
          <dt>Fee, fixed when you take it</dt>
          <dd className="num">{usd(units(fee), 'always')}</dd>
        </div>
        <div>
          <dt>Lands on payday</dt>
          <dd className="num">{usd(units(payment - advance - fee), 'always')}</dd>
        </div>
      </dl>
    </div>
  )
}
