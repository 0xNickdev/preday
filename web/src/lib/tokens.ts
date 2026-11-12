import { config } from './config'

type Token = { symbol: string; blockchain: string; price: number }

export const COINS = [
  { label: 'USDT on Tron', symbol: 'USDT', blockchain: 'tron' },
  { label: 'USDC on Base', symbol: 'USDC', blockchain: 'base' },
  { label: 'ETH', symbol: 'ETH', blockchain: 'eth' },
  { label: 'SOL', symbol: 'SOL', blockchain: 'sol' },
  { label: 'BTC', symbol: 'BTC', blockchain: 'btc' },
]

type Coin = (typeof COINS)[number]

/** Public price list. Only used for the estimate, so a failure just hides it. */
export async function loadTokens() {
  try {
    const response = await fetch(config.tokens)
    return response.ok ? ((await response.json()) as Token[]) : []
  } catch {
    return []
  }
}

/** "0.5843 ETH" for an amount in USDC minimal units, or null without a price. */
export function estimate(tokens: Token[], coin: Coin, amount: bigint) {
  const token = tokens.find((item) => item.symbol === coin.symbol && item.blockchain === coin.blockchain)
  if (!token || !(token.price > 0)) return null
  const coins = Number(amount) / 1e6 / token.price
  return `${coins.toLocaleString('en-US', { maximumSignificantDigits: 4 })} ${coin.symbol}`
}
