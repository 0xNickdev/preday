import { useState } from 'react'
import { config } from '../lib/config'
import { register } from '../lib/preday'
import { useAction } from '../lib/useAction'

// These would hide behind the app's own pages.
const RESERVED = ['app', 'pool']

function problem(name: string) {
  // The name becomes the account <name>.<contract>, and NEAR account ids stop at 64 characters.
  const max = Math.min(32, 63 - config.contract.length)
  if (!/^[a-z0-9-]*$/.test(name)) return 'Use lowercase letters, numbers and hyphens only.'
  if (name.length < 2) return 'Use at least 2 characters.'
  if (name.length > max) return `Use ${max} characters or fewer.`
  if (name.startsWith('-') || name.endsWith('-')) return 'Start and end with a letter or a number.'
  if (RESERVED.includes(name)) return 'That name is reserved. Pick another one.'
  return null
}

export function Claim({ onClaimed }: { onClaimed: () => Promise<void> }) {
  const [name, setName] = useState('')
  const action = useAction()
  const invalid = name ? problem(name) : null

  return (
    <div className="narrow">
      <h1>Claim your pay link</h1>
      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            await register(name)
            await onClaimed()
          })
        }}
      >
        <label className="field">
          Your name on Preday
          <span className="input">
            <span>preday.app/</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value.trim().toLowerCase())}
              placeholder="anna"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid !== null}
              aria-describedby="claim-help"
            />
          </span>
        </label>
        <p className={invalid ? 'note late' : 'note'} id="claim-help">
          {invalid ?? '2 to 32 characters: letters, numbers and hyphens.'}
        </p>
        <button className="btn wide" disabled={!name || invalid !== null || action.busy}>
          {action.busy ? 'Claiming...' : `Claim preday.app/${name || 'your-name'}`}
        </button>
        {action.error && (
          <p className="note late" role="alert">
            {action.error}
          </p>
        )}
        <p className="note">
          This demo creates a throwaway NEAR testnet account in this browser and claims the name with it. No wallet
          needed, no real money involved.
        </p>
      </form>
    </div>
  )
}
