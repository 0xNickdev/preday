import { Link } from 'react-router-dom'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import { Calculator } from '../components/Calculator'
import { Dither, type Region } from '../components/Dither'
import { FlowDiagram } from '../components/FlowDiagram'
import { HandsDots } from '../components/HandsDots'
import { CoinIcon, StepIcon, type Coin, type Step } from '../components/Icons'
import { Logo } from '../components/Logo'
import { Marquee } from '../components/Marquee'
import { PaymentsGlobe } from '../components/PaymentsGlobe'
import { PoolFigures } from '../components/PoolFigures'
import { Rise } from '../components/Rise'
import { Story } from '../components/Story'
import { config } from '../lib/config'
import { getPool } from '../lib/preday'
import { useLive } from '../lib/useLive'

const STEPS: [Step, string, string][] = [
  ['link', 'Claim a pay link', 'Pick a name and send preday.app/anna to clients instead of a wallet address.'],
  ['coins', 'Get paid in any coin', 'Your client pays with what they hold, from any network. You receive dollars.'],
  ['history', 'Build a history', 'Every payment is recorded. After three payments your advance limit opens.'],
  ['early', 'Take part of it early', 'Get up to 30% of your next payment now. It is paid back from that payment.'],
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

const COINS: Coin[] = ['USDT', 'USDC', 'ETH', 'SOL', 'BTC', 'NEAR']

const ANSWERS = [
  [
    'You do not owe more than you took.',
    'The advance and its fee are fixed on the day you take it. There is no interest and no late fee.',
  ],
  [
    'Nobody chases you.',
    'Repayment only ever comes out of payments to your link. If a client is late, the advance waits with them.',
  ],
  [
    'After 90 days it is written off.',
    'The pool absorbs the loss and that identity cannot take another advance. Your pay link keeps working.',
  ],
]

/** Both hands of the top row of the sheet, reaching for each other. */
const REACH: Region = [0, 0.06, 1, 0.4]

export function Landing() {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <main>
          <section className="hero">
            <HandsDots />
            <header className="hero-bar">
              <Logo />
              <nav aria-label="Sections">
                <a href="#how">How it works</a>
                <a href="#terms">Terms</a>
                <Link to="/pool">Pool</Link>
                <Link to="/docs">Docs</Link>
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
            <ul className="coins" aria-label="Coins a client can pay with">
              {COINS.map((coin) => (
                <li key={coin}>
                  <CoinIcon coin={coin} />
                  {coin}
                </li>
              ))}
            </ul>
          </section>

          <Marquee />
          <Story />

          <section className="band" id="how">
            <div className="wrap">
              <h2>How a payment moves</h2>
              <FlowDiagram />
              <ol className="steps">
                {STEPS.map(([step, title, text]) => (
                  <li key={title}>
                    <StepIcon step={step} />
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="band">
            <div className="wrap split even">
              <div>
                <h2>Clients anywhere. One link.</h2>
                <p>
                  Your client pays from the network they already use, with the coin they already hold. It is routed
                  for them and reaches you as dollars. They do not need an account.
                </p>
                <dl className="facts">
                  <div>
                    <dt>From Base</dt>
                    <dd>about 35 seconds</dd>
                  </div>
                  <div>
                    <dt>From Tron</dt>
                    <dd>about 80 seconds</dd>
                  </div>
                </dl>
                <p className="note">Routing times are the estimates NEAR Intents returned for our test quotes.</p>
              </div>
              <PaymentsGlobe />
            </div>
          </section>

          <section className="band">
            <div className="wrap split even">
              <div>
                <h2>Run your own numbers</h2>
                <p>
                  You can take up to 30% of a typical payment, up to your current step. The step starts at $25 and
                  doubles each time an advance is paid back on time.
                </p>
              </div>
              <Calculator />
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
                {TERMS.map(([term, text], i) => (
                  <Rise key={term} index={i}>
                    <dt>{term}</dt>
                    <dd>{text}</dd>
                  </Rise>
                ))}
              </dl>
            </div>
          </section>

          <section className="band">
            <div className="wrap split">
              <h2>What if I cannot pay it back?</h2>
              <div className="answers">
                {ANSWERS.map(([title, text], i) => (
                  <Rise key={title} index={i}>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </Rise>
                ))}
              </div>
            </div>
          </section>

          {config.contract && <PoolBand />}

          <section className="closing">
            <div className="closing-hands">
              <Dither region={REACH} cellSize={6} color="#f7f7f5" />
            </div>
            <h2>Payday is whenever you need it.</h2>
            <Link to="/app" className="btn glow">
              Claim your pay link
            </Link>
          </section>
        </main>

        <footer className="wrap foot">
          <span>Preday. Contracts run on NEAR.</span>
          <Link to="/docs">Docs</Link>
          <a href="https://github.com/0xNickdev/preday">Source</a>
        </footer>
      </MotionConfig>
    </LazyMotion>
  )
}
