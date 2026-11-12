import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PaycheckDots } from '../components/PaycheckDots'
import { Logo } from '../components/Logo'
import { PoolFigures } from '../components/PoolFigures'
import { config } from '../lib/config'
import { getPool } from '../lib/preday'
import { useLive } from '../lib/useLive'

const STEPS = [
  ['Claim a pay link', 'Pick a name and send preday.app/anna to clients instead of a wallet address.'],
  ['Get paid in any coin', 'Your client pays with what they hold, from any network. You receive dollars.'],
  ['Build a history', 'Every payment is recorded. After three payments your advance limit opens.'],
  ['Take part of it early', 'Get up to 30% of your next payment now. It is paid back from that payment.'],
]

const TERMS = [
  ['Who can get one', 'Anyone with three payments over at least 30 days and one identity check.'],
  ['How much', 'Up to 30% of your typical payment. Limits start at $25 and double each time you pay on time, up to $400.'],
  ['Fee', '5% of the advance, $1 minimum. No interest, no tips, no subscription.'],
  ['Paying it back', 'Your next payment covers the advance and the fee first. The rest goes to you.'],
  ['If the payment is smaller', 'It covers what it can. The remaining amount stays the same until the next one.'],
  ['If no payment comes', 'Nothing is added. After 45 days your limit is paused and starts again at $25.'],
]

/** Live numbers from the contract. Renders nothing until they load, so a failed read leaves no gap. */
function PoolBand() {
  const pool = useLive(getPool)
  if (!pool.data) return null

  return (
    <section className="band">
      <div className="wrap">
        <h2>Where the advances come from</h2>
        <PoolFigures pool={pool.data} />
        <p className="note">
          Advances are paid from a shared pool, and anyone can see what is in it. <Link to="/pool">See the pool</Link>
        </p>
      </div>
    </section>
  )
}

/** One line per amount the hero cycles through, in the same order. */
const LEGEND = [
  ['Nov 28', 'your next payment is $1,180'],
  ['Today', 'you take $100 of it'],
  ['Nov 28', '$1,075 lands, the advance is paid back'],
]

export function Landing() {
  const [amount, setAmount] = useState(0)

  return (
    <>
      <main>
        <section className="hero">
          <PaycheckDots onAmount={setAmount} />
          <header className="hero-bar">
            <Logo />
            <nav aria-label="Sections">
              <a href="#how">How it works</a>
              <a href="#terms">Terms</a>
              <Link to="/pool">Pool</Link>
            </nav>
            <Link to="/app" className="btn small">
              Open app
            </Link>
          </header>
          <div className="hero-copy">
            <h1>
              <span>Payday is</span> whenever you need it.
            </h1>
            <p>A pay link for people paid in crypto. Take part of your next payment early. It settles itself.</p>
            <Link to="/app" className="btn glow">
              Claim your pay link
            </Link>
          </div>
          <ol className="legend">
            {LEGEND.map(([when, what], index) => (
              <li key={what} aria-current={index === amount || undefined}>
                <b>{when}</b> {what}
              </li>
            ))}
          </ol>
        </section>

        <section className="band" id="how">
          <div className="wrap">
            <h2>From first invoice to early payday</h2>
            <ol className="steps">
              {STEPS.map(([title, text]) => (
                <li key={title}>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="band" id="terms">
          <div className="wrap split">
            <div>
              <h2>The terms, all of them</h2>
              <p>
                $5 on a $100 advance for two weeks is a high rate if you annualize it. That is why the fee is shown in
                dollars before you confirm, and why it never grows.
              </p>
            </div>
            <dl className="terms">
              {TERMS.map(([term, text]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="band">
          <div className="wrap split">
            <h2>What if I cannot pay it back?</h2>
            <div className="answers">
              <div>
                <h3>You do not owe more than you took.</h3>
                <p>The advance and its fee are fixed on the day you take it. There is no interest and no late fee.</p>
              </div>
              <div>
                <h3>Nobody chases you.</h3>
                <p>
                  Repayment only ever comes out of payments to your link. If a client is late, the advance waits with
                  them.
                </p>
              </div>
              <div>
                <h3>After 90 days it is written off.</h3>
                <p>
                  The pool absorbs the loss and that identity cannot take another advance. Your pay link keeps working.
                </p>
              </div>
            </div>
          </div>
        </section>

        {config.contract && <PoolBand />}
      </main>

      <footer className="wrap foot">
        <span>Preday. Contracts run on NEAR.</span>
        <a href="https://github.com/0xNickdev/preday">Source</a>
      </footer>
    </>
  )
}
