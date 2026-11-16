import { config } from './config'

type Token = { assetId: string; symbol: string; blockchain: string; price: number }

export const COINS = [
  { label: 'USDT on Tron', symbol: 'USDT', blockchain: 'tron', network: 'Tron' },
  { label: 'USDC on Base', symbol: 'USDC', blockchain: 'base', network: 'Base' },
  { label: 'ETH', symbol: 'ETH', blockchain: 'eth', network: 'Ethereum' },
  { label: 'SOL', symbol: 'SOL', blockchain: 'sol', network: 'Solana' },
  { label: 'BTC', symbol: 'BTC', blockchain: 'btc', network: 'Bitcoin' },
]

export type Coin = (typeof COINS)[number]

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

/** "about 2 min", for a delivery estimate in seconds. */
export const about = (seconds: number) => (seconds >= 90 ? `about ${Math.round(seconds / 60)} min` : `about ${seconds} sec`)

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

/** A real quote: coins sent to `address` before `deadline` arrive on the pay account as dollars. */
export type Deposit = { address: string; memo?: string; sends: string; deadline: number }

export type DepositStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED'

type DepositAnswer = { depositAddress?: string; memo?: string; amountInFormatted?: string; deadline?: string; error?: string }

/** Asks the Preday service for a deposit address. The service watches it and sweeps the pay account on arrival. */
export async function openDeposit(tokens: Token[], coin: Coin, handle: string, amount: bigint, refundTo: string): Promise<Deposit> {
  const token = find(tokens, coin)
  if (!token) throw new Error(`${coin.label} cannot be routed right now. Pick another coin.`)
  const response = await fetch(`${config.service}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, amount: amount.toString(), originAsset: token.assetId, refundTo }),
  }).catch(() => null)
  const answer = ((await response?.json().catch(() => null)) ?? {}) as DepositAnswer
  const { depositAddress, amountInFormatted, deadline } = answer
  if (!response?.ok || !depositAddress || !amountInFormatted || !deadline) {
    // A 400 is about what was typed, and 1Click says what in plain words.
    throw new Error((response?.status === 400 && answer.error) || 'No quote right now. Try again in a moment.')
  }
  // The exact figure, not a rounded one: this is what the client has to send.
  return { address: depositAddress, memo: answer.memo, sends: `${amountInFormatted} ${coin.symbol}`, deadline: Date.parse(deadline) }
}

/** Null when the service did not answer. The next poll asks again. */
export async function depositStatus(address: string, signal: AbortSignal) {
  try {
    const response = await fetch(`${config.service}/status?depositAddress=${encodeURIComponent(address)}`, { signal })
    return response.ok ? ((await response.json()) as { status: DepositStatus }).status : null
  } catch {
    return null
  }
}
