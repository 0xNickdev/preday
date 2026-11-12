import { useSyncExternalStore } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { config } from '../lib/config'
import { guestId, onGuest } from '../lib/near'
import { Logo } from './Logo'

export function Shell() {
  const guest = useSyncExternalStore(onGuest, guestId)

  return (
    <>
      <header className="wrap bar app">
        <Logo />
        <nav aria-label="App">
          <NavLink to="/app">Dashboard</NavLink>
          <NavLink to="/pool">Pool</NavLink>
        </nav>
        <span className="badge">Testnet demo</span>
        {guest && <span className="mono muted">{guest}</span>}
      </header>
      <main className="wrap page">
        {config.contract ? (
          <Outlet />
        ) : (
          <p className="narrow">
            This copy of Preday is not connected to a contract yet. Set <span className="mono">VITE_CONTRACT_ID</span>{' '}
            in <span className="mono">web/.env</span> and restart the dev server.
          </p>
        )}
      </main>
    </>
  )
}
