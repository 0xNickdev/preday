import { Account, JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from 'near-api-js'
import { config } from './config'

const provider = new JsonRpcProvider({ url: config.rpc })

type Args = Record<string, unknown>

export async function view<T>(contractId: string, method: string, args: Args = {}) {
  return (await provider.callFunction({ contractId, method, args })) as T
}

/**
 * The demo signs with a throwaway testnet account kept in this browser,
 * so nobody needs a wallet to try the product.
 */
type Guest = { accountId: string; key: KeyPairString }

const STORAGE_KEY = 'preday.guest'
const GUEST_EVENT = 'preday:guest'

function savedGuest(): Guest | null {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved ? (JSON.parse(saved) as Guest) : null
}

export function guestId() {
  return savedGuest()?.accountId ?? null
}

/** Fires when the guest account is created, so the app bar can show it without a reload. */
export function onGuest(listener: () => void) {
  window.addEventListener(GUEST_EVENT, listener)
  return () => window.removeEventListener(GUEST_EVENT, listener)
}

/** The guest's account id, creating the guest on first use. */
export async function ensureGuest() {
  return (await guest()).accountId
}

async function guest() {
  const saved = savedGuest()
  if (saved) return new Account(saved.accountId, provider, saved.key)

  const pair = KeyPair.fromRandom('ed25519')
  const created: Guest = { accountId: `preday-${crypto.randomUUID().slice(0, 8)}.testnet`, key: pair.toString() }
  const response = await fetch(config.faucet, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: created.accountId, newAccountPublicKey: pair.getPublicKey().toString() }),
  })
  if (!response.ok) throw new Error('The testnet faucet is busy. Try again in a minute.')

  localStorage.setItem(STORAGE_KEY, JSON.stringify(created))
  window.dispatchEvent(new Event(GUEST_EVENT))
  return new Account(created.accountId, provider, created.key)
}

type Call = { contractId: string; method: string; args?: Args; tgas?: number; deposit?: bigint }

/** Signs and sends one function call as the guest, creating the guest on first use. */
export async function call({ contractId, method, args = {}, tgas = 100, deposit = 0n }: Call) {
  const account = await guest()
  try {
    return await account.callFunction({
      contractId,
      methodName: method,
      args,
      gas: teraToGas(tgas),
      deposit,
      waitUntil: 'FINAL',
    })
  } catch (error) {
    throw new Error(panicMessage(error), { cause: error })
  }
}

export type ChainEvent = { event: string; data: Record<string, unknown> }

/** Like `call`, but returns the transaction hash and every event the contracts logged along the way. */
export async function callForEvents({ contractId, method, args = {}, tgas = 100, deposit = 0n }: Call) {
  const account = await guest()
  try {
    const outcome = await account.callFunctionRaw({
      contractId,
      methodName: method,
      args,
      gas: teraToGas(tgas),
      deposit,
      waitUntil: 'FINAL',
    })
    const events = outcome.receipts_outcome
      .flatMap((receipt) => receipt.outcome.logs)
      .filter((log) => log.startsWith('EVENT_JSON:'))
      .map((log) => JSON.parse(log.slice('EVENT_JSON:'.length)) as ChainEvent)
    return { hash: outcome.transaction.hash as string, events }
  } catch (error) {
    throw new Error(panicMessage(error), { cause: error })
  }
}

/** Contract panics arrive wrapped in RPC noise. Keep the sentence the contract wrote. */
function panicMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1]
  if (panic) return panic
  console.error(error)
  return 'NEAR testnet did not confirm this. Try again in a moment.'
}
