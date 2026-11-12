import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { config } from '../lib/config'

type Row = [string, ReactNode]

function Table({ head, rows }: { head: [string, string]; rows: Row[] }) {
  return (
    <div className="docs-table">
      <table>
        <thead>
          <tr>
            <th>{head[0]}</th>
            <th>{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const code = (text: string) => <span className="mono">{text}</span>

const SECTIONS: { id: string; title: string; body: ReactNode }[] = [
  {
    id: 'overview',
    title: 'What Preday is',
    body: (
      <>
        <p>
          Preday is two things that depend on each other. The first is a pay link: a short address you give to clients
          so they can pay you with any coin. The second is an advance: once the link has a history of payments, you can
          take part of the next payment early.
        </p>
        <p>
          They depend on each other because every payment to your link passes through a contract before it reaches you.
          That is what lets the advance pay itself back. Nobody has to trust you to return it, and you do not have to
          remember to.
        </p>
      </>
    ),
  },
  {
    id: 'pay-link',
    title: 'Your pay link and pay account',
    body: (
      <>
        <p>
          Claiming a name creates a pay account on NEAR, for example {code('anna.preday.near')}. This account is where
          client payments land. It is deliberately limited:
        </p>
        <ul>
          <li>It has no access keys. Nobody can sign for it, including you and including us.</li>
          <li>
            It runs one small piece of shared code with one job: forward all its dollars to the main contract, tagged
            with your name. This is the {code('sweep()')} call, and anyone can trigger it.
          </li>
          <li>The code is published once for everyone, so an account costs 0.001 NEAR.</li>
        </ul>
        <p>
          One name per wallet, and each name is unique. Claiming costs a 0.02 NEAR deposit, which covers the pay
          account, its registration with the dollar token, and storage for your first payments.
        </p>
      </>
    ),
  },
  {
    id: 'payment',
    title: 'How a payment moves',
    body: (
      <>
        <ol>
          <li>Your client opens your link, picks a coin and a network, and sends it to a one-time deposit address.</li>
          <li>NEAR Intents swaps it to USDC and delivers it to your pay account.</li>
          <li>The pay account is swept: its dollars go to the main contract with your name attached.</li>
          <li>The contract records the payment in your history.</li>
          <li>If an advance is open, it is repaid from this payment: the amount you took first, then the fee.</li>
          <li>Everything left is sent to your wallet in the same transaction chain.</li>
        </ol>
        <p>
          If the transfer to your wallet fails for any reason, the money is not lost. The contract holds it as a
          pending balance and you collect it from the dashboard.
        </p>
      </>
    ),
  },
  {
    id: 'eligibility',
    title: 'Who can take an advance',
    body: (
      <>
        <p>All four must be true:</p>
        <Table
          head={['Requirement', 'Why']}
          rows={[
            ['Three payments to your link', 'A limit needs something to be based on.'],
            ['30 days since your first payment', 'A history cannot be manufactured in an evening.'],
            ['One identity check', 'One person gets one account. The contract stores only a hash, never your documents.'],
            ['No advance open', 'One at a time, so what you owe is always a single number.'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'limit',
    title: 'How your limit is calculated',
    body: (
      <>
        <p>
          The contract takes the median of your last three payments. The median, not the average, so one unusually
          large payment does not inflate it. Your limit is the lower of two numbers: 30% of that median, and your
          current step.
        </p>
        <p className="formula">limit = min(30% x median of last 3 payments, current step)</p>
        <p>
          Steps are $25, $50, $100, $200 and $400. Everyone starts at $25. Each advance that is paid back on time
          moves you one step up. An advance that goes late sends you back to $25.
        </p>
        <Table
          head={['Worked example', '']}
          rows={[
            ['Last three payments', '$1,180, $640, $1,200'],
            ['Median', '$1,180'],
            ['30% of the median', '$354'],
            ['Current step', '$25 (first advance)'],
            ['Limit', '$25'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'fee',
    title: 'The fee and paying it back',
    body: (
      <>
        <p>
          The fee is 5% of the advance with a $1 minimum. It is fixed at the moment you take the advance and collected
          only when the advance is repaid. There is no interest, no late fee, no tip and no subscription.
        </p>
        <Table
          head={['Continuing the example', '']}
          rows={[
            ['You take', '$25.00, sent to your wallet at once'],
            ['Fee', '$1.25'],
            ['Next payment arrives', '$1,000.00'],
            ['Taken from it', '$26.25'],
            ['Sent to your wallet', '$973.75'],
            ['Your next limit step', '$50'],
          ]}
        />
        <p>
          If the next payment is smaller than what you owe, it covers what it can and the rest waits for the following
          payment. The amount owed never grows. In that case nothing is forwarded to your wallet until the advance is
          cleared.
        </p>
        <p>
          A 5% fee on an advance that lasts two weeks is a high rate if you annualize it. We show the fee in dollars
          before you confirm so you can judge it as what it is: a fixed price for getting part of a payment early.
        </p>
      </>
    ),
  },
  {
    id: 'late',
    title: 'If no payment comes',
    body: (
      <>
        <Table
          head={['Time without a payment', 'What happens']}
          rows={[
            ['Up to 45 days', 'Nothing. The advance waits.'],
            ['45 days', 'The advance is marked late. Your limit is paused and your step returns to $25.'],
            [
              '90 days',
              'The advance is written off. The pool absorbs the loss and that identity cannot take another advance.',
            ],
          ]}
        />
        <p>
          The clock counts from the last activity on the advance: the day you took it, or the last payment that repaid
          part of it. A late advance can still be repaid by any payment that arrives before day 90, which closes it and
          lets you start again from the first step. Your pay link keeps working in every case.
        </p>
        <p>
          Marking an advance late or writing it off is a public call that anyone can make once the deadline has
          passed. No operator decides who is late.
        </p>
      </>
    ),
  },
  {
    id: 'pool',
    title: 'Where the money comes from',
    body: (
      <>
        <p>
          Advances are paid from a shared pool. Anyone can add dollars to it and receives shares in return. The share
          price is the pool's assets divided by the shares in existence, and it rises as fees come in.
        </p>
        <ul>
          <li>Each collected fee is split: 80% is added to the pool, 20% goes to a separate reserve.</li>
          <li>A written-off advance is taken from the reserve first. Only what the reserve cannot cover reduces the pool.</li>
          <li>At most 80% of the pool can be out in advances, so there is always money left to withdraw.</li>
          <li>
            A withdrawal is paid from money that is not currently lent. If too much is out, it has to wait for
            repayments.
          </li>
        </ul>
        <p>
          Backing the pool is not a savings account. Returns depend on fees earned and on losses, and they are not
          guaranteed. The live numbers are on the <Link to="/pool">pool page</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'control',
    title: 'Who controls what',
    body: (
      <>
        <Table
          head={['Party', 'What they can do']}
          rows={[
            ['You', 'Claim a name, take an advance within your limit, collect a pending balance.'],
            ['Your client', 'Pay your link. They need no account.'],
            ['A pool backer', 'Add dollars, withdraw their share.'],
            ['Anyone', 'Sweep a pay account, mark an overdue advance late, write off a stale one.'],
            ['The identity checker', 'Confirm that a name belongs to one unique person. Nothing else.'],
            ['The contract owner', 'Propose new rule values. They take effect only after a public delay.'],
          ]}
        />
        <p>
          The owner has no method that moves anyone's money, and there is no method to upgrade the contract. Every
          rule on this page is a value in contract state that anyone can read.
        </p>
      </>
    ),
  },
  {
    id: 'demo',
    title: 'What is different in this demo',
    body: (
      <>
        <p>The demo runs on NEAR testnet so anyone can try the full flow without money or a wallet.</p>
        <Table
          head={['In the demo', 'In production']}
          rows={[
            ['Test dollars from an open faucet', 'USDC, delivered by NEAR Intents from any coin'],
            ['2 minutes of history', '30 days'],
            ['Late after 10 minutes, written off after 20', '45 and 90 days'],
            ['An identity check that approves everyone', 'A real identity provider'],
            ['A throwaway account kept in your browser', 'Your own wallet'],
          ]}
        />
        <p>
          The contract code and every other rule are the same. The demo contract is {code(config.contract)}.
        </p>
      </>
    ),
  },
]

const QUESTIONS: [string, ReactNode][] = [
  [
    'Is this a loan?',
    'It is an advance on money that is already on its way to you, with a fixed fee. It has no interest and no schedule, and what you owe cannot grow. Whether the law in your country treats it as credit is a separate question, and we do not claim it is settled.',
  ],
  [
    'What if I never get paid again?',
    'Then the advance is never repaid, and after 90 days it is written off against the pool. Nobody contacts you and nothing is added. The cost to you is that this identity cannot take another advance.',
  ],
  [
    'Can I repay early from my wallet?',
    'Not in this version. Repayment only happens from payments to your link. Asking a client to pay, or paying your own link, closes the advance the same way.',
  ],
  [
    'Can I just give clients a different wallet address after taking an advance?',
    'You can, and the contract cannot stop you. You would lose your payment history, your step and any future advance for that identity. Limits stay small relative to a payment for exactly this reason.',
  ],
  [
    'What stops someone from paying themselves to build a history?',
    'Nothing stops the payments, but an advance also needs an identity check, and one person gets one account. Faking a history lets one real person take one small advance and then lose access for good.',
  ],
  [
    'What does my client need?',
    'Only your link. They choose a coin and a network, send it to the address shown, and can close the page. They do not need a NEAR account or any account with us.',
  ],
  [
    'Which coins can a client pay with?',
    'Whatever NEAR Intents can route, which includes USDT, USDC, ETH, SOL, BTC and NEAR across the major networks. Some routes have a minimum amount set by Intents.',
  ],
  [
    'What do you know about me?',
    'Your pay link, your payments and your advance are public on the chain, as with any on-chain account. The identity check leaves only a hash in the contract. It proves you are one unique person without storing who you are.',
  ],
  [
    'Can Preday freeze or take my money?',
    'No. The owner has no method that moves funds, and a pay account has no keys at all. The only money the contract keeps from a payment is an advance you took and its fee.',
  ],
  [
    'What if a client sends the wrong coin to my pay account directly?',
    'The pay account can only forward the dollar token. Anything else sent to it directly, without going through the pay page, stays there and cannot be recovered. Always share the link, not the account name.',
  ],
  [
    'Can the rules change after I take an advance?',
    'The fee on an open advance cannot change: it was fixed when you took it. Other values can be changed by the owner, but only through a proposal that everyone can see and that takes effect after a delay.',
  ],
  [
    'Has the contract been audited?',
    'No. It has unit tests and tests that run the full flows on a local copy of the network, and it runs on testnet. It has not been reviewed by an outside auditor and should not hold real money yet.',
  ],
]

export function Docs() {
  return (
    <div className="docs">
      <nav className="docs-toc" aria-label="On this page">
        {SECTIONS.map(({ id, title }) => (
          <a key={id} href={`#${id}`}>
            {title}
          </a>
        ))}
        <a href="#questions">Questions and answers</a>
      </nav>

      <article>
        <h1>How Preday works</h1>
        <p className="docs-lead">
          Everything the contract does with a payment and an advance, in the order it happens. The numbers are the
          production rules unless a section says otherwise.
        </p>

        {SECTIONS.map(({ id, title, body }) => (
          <section key={id} id={id}>
            <h2>{title}</h2>
            {body}
          </section>
        ))}

        <section id="questions">
          <h2>Questions and answers</h2>
          <div className="docs-questions">
            {QUESTIONS.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <p className="note">
          The contract source, its tests and the deployment script are in the{' '}
          <a href="https://github.com/0xNickdev/preday">repository</a>.
        </p>
      </article>
    </div>
  )
}
