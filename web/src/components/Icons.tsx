/** Preday's own icon set. Coin marks are solid 20px glyphs, step marks are 24px line drawings. */

const RING = 'M10 1a9 9 0 110 18 9 9 0 010-18z'

const COINS = {
  USDT: `${RING}M6 5.5h8v2.2h-2.9V15H8.9V7.7H6z`,
  USDC: `${RING}M9.1 4.5h1.8v11H9.1zM7.4 6.3v2a2.9 2.9 0 000 3.4v2a4.8 4.8 0 010-7.4zm5.2 0a4.8 4.8 0 010 7.4v-2a2.9 2.9 0 000-3.4z`,
  ETH: 'M10 1l6 9-6 3.4L4 10zM10 15l6-3.4L10 19l-6-7.4z',
  SOL: 'M5.5 3.5H18l-2.5 3.2H3zM3 8.4h12.5L18 11.6H5.5zM5.5 13.3H18l-2.5 3.2H3z',
  BTC: `${RING}M7 5h4.3a2.5 2.5 0 011.7 4.3A2.8 2.8 0 0111.7 15H7zm2 2v2.2h2a1.1 1.1 0 000-2.2zm0 4v2.2h2.5a1.1 1.1 0 000-2.2z`,
  NEAR: 'M3.5 3.5h3.2l6.6 8.6V3.5h3.2v13h-3.2L6.7 7.9v8.6H3.5z',
}

export type Coin = keyof typeof COINS

export function CoinIcon({ coin }: { coin: Coin }) {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d={COINS[coin]} />
    </svg>
  )
}

const STEPS = {
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.700l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.700l1-1',
  coins: 'M3 8.500a6 2.500 0 1012 0 6 2.500 0 10-12 0M3 8.500v4c0 1.400 2.700 2.500 6 2.500M9 15.500v3c0 1.400 2.700 2.500 6 2.500s6-1.100 6-2.500v-4M9 14.500a6 2.500 0 1012 0 6 2.500 0 10-12 0',
  history: 'M4 6h16M4 12h10M4 18h13M19 10.500v3M17.500 12h3',
  early: 'M12 3a9 9 0 109 9M12 7v5l3 2M16 3h5v5M21 3l-6 6',
}

export type Step = keyof typeof STEPS

export function StepIcon({ step }: { step: Step }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={STEPS[step]} />
    </svg>
  )
}
