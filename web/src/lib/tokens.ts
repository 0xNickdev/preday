import { config } from './config'

type Token = { assetId: string; symbol: string; blockchain: string; price: number }

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

const find = (tokens: Token[], coin: Coin) =>
  tokens.find((item) => item.symbol === coin.symbol && item.blockchain === coin.blockchain)

const coins = (value: number, coin: Coin) =>
  `${value.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${coin.symbol}`

/** "0.5843 ETH" for an amount in USDC minimal units, or null without a price. */
export function estimate(tokens: Token[], coin: Coin, amount: bigint) {
  const token = find(tokens, coin)
  if (!token || !(token.price > 0)) return null
  return coins(Number(amount) / 1e6 / token.price, coin)
}

const USDC_ON_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
/** A dry quote moves nothing, so no real address is needed. The zero account stands in for both ends. */
const NOBODY = '0'.repeat(64)

export type Quote = { sends: string; seconds: number }

/**
 * What NEAR Intents would charge right now to deliver `amount` USDC, asked as a dry run.
 * Null when there is no route or no answer, and the page falls back to the estimate.
 */
export async function quote(tokens: Token[], coin: Coin, amount: bigint, signal: AbortSignal): Promise<Quote | null> {
  const token = find(tokens, coin)
  if (!token) return null
  try {
    const response = await fetch(config.quote, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_OUTPUT',
        slippageTolerance: 100,
        originAsset: token.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: USDC_ON_NEAR,
        amount: amount.toString(),
        refundTo: NOBODY,
        refundType: 'INTENTS',
        recipient: NOBODY,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    })
    if (!response.ok) return null
    const { quote } = (await response.json()) as { quote?: { amountInFormatted?: string; timeEstimate?: number } }
    const sends = Number(quote?.amountInFormatted)
    if (!(sends > 0)) return null
    return { sends: coins(sends, coin), seconds: quote?.timeEstimate ?? 0 }
  } catch {
    return null
  }
}
