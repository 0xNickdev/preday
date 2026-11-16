import { NavLink, Outlet } from 'react-router-dom'
import { config } from '../lib/config'
import { connectWallet, disconnectWallet } from '../lib/near'
import { useAccount } from '../lib/useAccount'
import { Logo } from './Logo'

export function Shell() {
  const { account, wallet } = useAccount()

  return (
    <>
      <header className="wrap bar app">
        <Logo />
        <nav aria-label="App">
          <NavLink to="/app">Dashboard</NavLink>
          <NavLink to="/pool">Pool</NavLink>
          <NavLink to="/docs">Docs</NavLink>
        </nav>
        <span className="badge">Testnet demo</span>
        {account && <span className="mono muted">{account}</span>}
        <button
          className="btn small ghost"
          // Backing out of the wallet chooser is not an error worth showing.
          onClick={() => void (wallet ? disconnectWallet() : connectWallet()).catch(() => undefined)}
        >
          {wallet ? 'Disconnect' : 'Connect wallet'}
        </button>
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
