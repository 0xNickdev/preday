import { useState } from 'react'
import { Loading } from '../components/Loading'
import { PoolFigures } from '../components/PoolFigures'
import { dateTime, duration, parseUsd, usd } from '../lib/money'
import { guestId } from '../lib/near'
import { addToPool, getParams, getLp, getPool, withdraw } from '../lib/preday'
import { useAction } from '../lib/useAction'
import { useLive } from '../lib/useLive'

const MIN = 1_000_000n

async function loadPool() {
  const guest = guestId()
  const [pool, params, lp] = await Promise.all([getPool(), getParams(), guest ? getLp(guest) : null])
  // The time of the read, so the lock is judged at the same moment as the data.
  return { pool, params, shares: lp?.shares ?? '0', unlocksAt: lp?.unlocks_at ?? 0, now: Date.now() }
}

export function Pool() {
  const live = useLive(loadPool)
  const [input, setInput] = useState('100')
  const add = useAction()
  const take = useAction()

  if (!live.data) return <Loading failed={live.failed} />

  const { pool, params, shares, unlocksAt, now } = live.data
  const locked = unlocksAt > now
  const amount = parseUsd(input)
  const valid = amount !== null && amount >= MIN
  const held = BigInt(shares)
  const value = held > 0n ? (held * BigInt(pool.assets)) / BigInt(pool.total_shares) : 0n

  return (
    <>
      <h1>The pool advances are paid from</h1>
      <PoolFigures pool={pool} />

      <div className="cols">
        <section className="panel">
          <h2>Since the start</h2>
          <dl className="rows num">
            <div>
              <dt>Advanced</dt>
              <dd>{usd(pool.advanced)}</dd>
            </div>
            <div>
              <dt>Paid back</dt>
              <dd>{usd(pool.repaid)}</dd>
            </div>
            <div>
              <dt>Fees earned</dt>
              <dd>{usd(pool.fees, 'always')}</dd>
            </div>
            <div>
              <dt>Written off</dt>
              <dd>{usd(pool.written_off)}</dd>
            </div>
            <div>
              <dt>Recovered later</dt>
              <dd>{usd(pool.recovered)}</dd>
            </div>
            <div>
              <dt>Advances</dt>
              <dd>{pool.advances_count}</dd>
            </div>
          </dl>
          <p className="note">
            Every fee adds to the pool, and {params.reserve_bps / 100}% of each fee goes to the reserve. If an advance
            is never paid back, the loss comes out of the reserve first and then out of the pool. Returns are not
            guaranteed.
          </p>
        </section>

        <aside>
          <form
            className="panel stack"
            onSubmit={(event) => {
              event.preventDefault()
              if (!valid) return
              void add.run(async () => {
                await addToPool(amount)
                await live.refresh()
              })
            }}
          >
            <h2>Add test dollars</h2>
            <label className="field">
              Amount
              <span className="input">
                <span>$</span>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={!valid}
                />
              </span>
            </label>
            <button className="btn wide" disabled={!valid || add.busy}>
              {add.busy ? 'Adding...' : valid ? `Add ${usd(amount)} to the pool` : 'Enter $1 or more'}
            </button>
            {add.error && (
              <p className="note late" role="alert">
                {add.error}
              </p>
            )}
            <p className="note">
              Testnet only. The demo mints test dollars to a throwaway account in this browser, then moves them into
              the pool.
            </p>
          </form>

          {held > 0n && (
            <section className="panel stack">
              <h2>Your share: {usd(value, 'always')}</h2>
              <p className="muted">The first dollar ever added to the pool stays locked in it, so the share price cannot be pushed around.</p>
              <button
                className="btn ghost wide"
                disabled={take.busy || locked}
                onClick={() =>
                  take.run(async () => {
                    await withdraw(shares)
                    await live.refresh()
                  })
                }
              >
                {take.busy ? 'Withdrawing...' : locked ? `Withdraw from ${dateTime(unlocksAt)}` : 'Withdraw all'}
              </button>
              {take.error && (
                <p className="note late" role="alert">
                  {take.error}
                </p>
              )}
              <p className="note">
                Money you add stays in for {duration(params.withdraw_delay_ms)} before it can be withdrawn. A
                withdrawal can only use money that is in the pool right now, so if most of it is out in advances it
                waits until they are paid back.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  )
}
