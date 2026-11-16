import type { NearConnector } from '@hot-labs/near-connect'
import { Account, JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from 'near-api-js'
import { config } from './config'

const provider = new JsonRpcProvider({ url: config.rpc })

type Args = Record<string, unknown>

export async function view<T>(contractId: string, method: string, args: Args = {}) {
  return (await provider.callFunction({ contractId, method, args })) as T
}

export async function accountExists(accountId: string) {
  try {
    await provider.viewAccount({ accountId })
    return true
  } catch {
    return false
  }
}

/**
 * Two ways to sign. By default a throwaway testnet account kept in this browser, so nobody needs a wallet
 * to try the product. Or the person's own wallet, once they connect one.
 */
type Guest = { accountId: string; key: KeyPairString }

const STORAGE_KEY = 'preday.guest'
const WALLET_KEY = 'preday.wallet'
const ACCOUNT_EVENT = 'preday:account'

function savedGuest(): Guest | null {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved ? (JSON.parse(saved) as Guest) : null
}

/** The connected wallet's account, remembered across reloads so the first render already knows who is here. */
export function walletId() {
  return localStorage.getItem(WALLET_KEY)
}

function setWallet(accountId: string | null) {
  if (accountId) localStorage.setItem(WALLET_KEY, accountId)
  else localStorage.removeItem(WALLET_KEY)
  window.dispatchEvent(new Event(ACCOUNT_EVENT))
}

/** Who the app acts as: the connected wallet, else the guest, else nobody yet. */
export function accountId() {
  return walletId() ?? savedGuest()?.accountId ?? null
}

/** Fires when a wallet connects or disconnects, and when the guest account is created. */
export function onAccount(listener: () => void) {
  window.addEventListener(ACCOUNT_EVENT, listener)
  return () => window.removeEventListener(ACCOUNT_EVENT, listener)
}

/** The acting account's id, creating the guest on first use when no wallet is connected. */
export async function ensureAccount() {
  return walletId() ?? (await guest()).accountId
}

let connecting: Promise<NearConnector> | undefined

/** The wallet connector is only downloaded by people who use a wallet. */
function connector() {
  connecting ??= import('@hot-labs/near-connect').then(({ NearConnector }) => {
    const made = new NearConnector({ network: config.network })
    made.on('wallet:signIn', ({ accounts }) => setWallet(accounts[0]?.accountId ?? null))
    made.on('wallet:signOut', () => setWallet(null))
    return made
  })
  return connecting
}

/** Opens the wallet chooser. Resolves once a wallet is connected, rejects when the person backs out. */
export async function connectWallet() {
  await (await connector()).connect()
}

export async function disconnectWallet() {
  await (await connector()).disconnect().catch(() => undefined)
  setWallet(null)
}

// A remembered wallet whose session is gone would leave every button asking a wallet that is not there.
if (walletId()) {
  void connector()
    .then((made) => made.getConnectedWallet())
    .catch(() => setWallet(null))
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
  window.dispatchEvent(new Event(ACCOUNT_EVENT))
  return new Account(created.accountId, provider, created.key)
}

type Call = {
  contractId: string
  method: string
  args?: Args
  tgas?: number
  deposit?: bigint
  /** A public call that needs no identity. The browser's own key signs it, so a connected wallet is not asked. */
  anyone?: boolean
}

export type ChainEvent = { event: string; data: Record<string, unknown> }

const eventsOf = (outcome: { receipts_outcome: { outcome: { logs: string[] } }[] }) =>
  outcome.receipts_outcome
    .flatMap((receipt) => receipt.outcome.logs)
    .filter((log) => log.startsWith('EVENT_JSON:'))
    .map((log) => JSON.parse(log.slice('EVENT_JSON:'.length)) as ChainEvent)

/** Asks the connected wallet to sign one function call, then reads the final outcome from our own node. */
async function viaWallet(signerId: string, { contractId, method, args = {}, tgas = 100, deposit = 0n }: Call) {
  try {
    const wallet = await (await connector()).wallet()
    const sent = await wallet.signAndSendTransaction({
      signerId,
      receiverId: contractId,
      actions: [
        {
          type: 'FunctionCall',
          params: { methodName: method, args, gas: teraToGas(tgas).toString(), deposit: deposit.toString() },
        },
      ],
    })
    // Wallets differ in how long they wait before answering. The node knows when every receipt has run.
    const hash = sent.transaction.hash as string
    const outcome = await provider.viewTransactionStatus({ txHash: hash, accountId: signerId, waitUntil: 'FINAL' })
    const status = outcome.status as { SuccessValue?: string; Failure?: unknown }
    if (status.Failure) throw new Error(JSON.stringify(status.Failure))
    const returned = atob(status.SuccessValue ?? '')
    return { hash, events: eventsOf(outcome), value: returned ? (JSON.parse(returned) as unknown) : undefined }
  } catch (error) {
    throw new Error(panicMessage(error), { cause: error })
  }
}

/** Signs and sends one function call as the acting account, creating the guest on first use. */
export async function call(request: Call) {
  const signerId = walletId()
  if (signerId && !request.anyone) return (await viaWallet(signerId, request)).value

  const { contractId, method, args = {}, tgas = 100, deposit = 0n } = request
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

/** Like `call`, but returns the transaction hash and every event the contracts logged along the way. */
export async function callForEvents(request: Call) {
  const signerId = walletId()
  if (signerId && !request.anyone) return viaWallet(signerId, request)

  const { contractId, method, args = {}, tgas = 100, deposit = 0n } = request
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
    return { hash: outcome.transaction.hash as string, events: eventsOf(outcome) }
  } catch (error) {
    throw new Error(panicMessage(error), { cause: error })
  }
}

/** Contract panics arrive wrapped in RPC noise. Keep the sentence the contract wrote. */
function panicMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1]
  if (panic) return panic
  if (/reject|cancel|denied|closed/i.test(text)) return 'The wallet did not approve this, so nothing was sent.'
  console.error(error)
  return 'NEAR testnet did not confirm this. Try again in a moment.'
}
