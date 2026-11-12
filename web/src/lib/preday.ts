import { config } from './config'
import { accountExists, call, callForEvents, ensureGuest, view } from './near'

/** Amounts are strings of USDC minimal units. Times are milliseconds. */

type Config = { usdc: string; verifier: string; owner: string; register_deposit: string; params_delay_ms: number }

export type Params = {
  min_payments: number
  min_history_ms: number
  base_share_bps: number
  ladder: string[]
  fee_bps: number
  min_fee: string
  late_after_ms: number
  write_off_after_ms: number
  reserve_bps: number
  max_utilization_bps: number
  min_payment: string
  seasoning_ms: number
  withdraw_delay_ms: number
}

type Advance = { id: number; principal: string; fee: string; repaid: string; opened_at: number; touched_at: number; late: boolean }

export type Worker = {
  handle: string
  owner: string
  verified: boolean
  banned: boolean
  level: number
  payments_count: number
  activity_count: number
  first_payment_at: number | null
  total_received: string
  pending: string
  advance: Advance | null
}

export type Limit = {
  eligible: boolean
  limit: string
  base: string
  reason: null | 'not_verified' | 'banned' | 'advance_open' | 'few_payments' | 'short_history'
}

export type Activity = {
  kind: 'payment' | 'advance' | 'repayment' | 'closed' | 'late' | 'written_off'
  amount: string
  fee: string
  at: number
}

type Lp = { shares: string; unlocks_at: number }

export type Pool = {
  assets: string
  lent: string
  reserve: string
  total_shares: string
  advanced: string
  repaid: string
  fees: string
  written_off: string
  advances_count: number
}

const BPS = 10_000n
/** What the dollar token charges to register a new holder: 0.00125 NEAR. */
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n
const RECENT = 20

function read<T>(method: string, args?: Record<string, unknown>) {
  return view<T>(config.contract, method, args)
}

let contractConfig: Promise<Config> | undefined

function getConfig() {
  contractConfig ??= read<Config>('get_config').catch((error: unknown) => {
    contractConfig = undefined
    throw error
  })
  return contractConfig
}

export const getParams = () => read<Params>('get_params')
export const getHandle = (accountId: string) => read<string | null>('get_handle', { account_id: accountId })
export const getWorker = (handle: string) => read<Worker | null>('get_worker', { handle })
export const getLimit = (handle: string) => read<Limit>('get_limit', { handle })
export const getPool = () => read<Pool>('get_pool')
export const getLp = (accountId: string) => read<Lp>('get_lp', { account_id: accountId })

/** Dollars sitting in an account's own wallet, outside the contract. */
export async function getBalance(accountId: string) {
  const { usdc } = await getConfig()
  return view<string>(usdc, 'ft_balance_of', { account_id: accountId })
}

/** Everything the contract still remembers about a pay link, newest first. `count` is the worker's activity_count. */
export async function getActivity(handle: string, count: number) {
  const from = Math.max(0, count - RECENT)
  const activity = await read<Activity[]>('get_activity', { handle, from, limit: RECENT })
  return activity.reverse()
}

/** Same rule as the contract: a share of the amount with a fixed minimum. */
export function feeFor(amount: bigint, params: Params) {
  const share = (amount * BigInt(params.fee_bps)) / BPS
  const min = BigInt(params.min_fee)
  return share > min ? share : min
}

/**
 * Methods that move money finish in a callback. When the transfer fails the
 * contract undoes its own bookkeeping and returns false instead of panicking.
 */
async function send(method: string, args: Record<string, unknown>, undone: string, tgas = 100, deposit = 0n) {
  const done = await call({ contractId: config.contract, method, args, tgas, deposit })
  if (done === false) throw new Error(undone)
}

export async function register(handle: string) {
  const { register_deposit } = await getConfig()
  await send(
    'register',
    { handle },
    'That name could not be set up, so nothing was claimed. Try again.',
    150,
    BigInt(register_deposit),
  )
}

export function requestAdvance(amount: bigint) {
  return send(
    'request_advance',
    { amount: String(amount) },
    'The money could not be sent to your account, so no advance was opened. Try again.',
  )
}

export function withdraw(shares: string) {
  return send('withdraw', { shares }, 'The money could not be sent, so your share is unchanged. Try again.')
}

export function claim() {
  return send('claim', {}, 'The money could not be sent. It is still waiting for you. Try again.')
}

/** Testnet stand-in for an identity check: the verifier approves whoever calls it. */
export async function verify(handle: string) {
  const { verifier } = await getConfig()
  await call({ contractId: verifier, method: 'verify', args: { handle }, tgas: 60 })
}

async function mint(accountId: string, amount: bigint) {
  const { usdc } = await getConfig()
  await call({ contractId: usdc, method: 'mint', args: { account_id: accountId, amount: String(amount) }, tgas: 30 })
}

/** Sends dollars from the guest's wallet to another account, registering it with the token first if needed. */
export async function sendDollars(to: string, amount: bigint) {
  // The token would happily register a name nobody owns, and the money would be stuck there.
  if (!(await accountExists(to))) throw new Error('That NEAR account does not exist. Check the name.')
  const { usdc } = await getConfig()
  const registered = await view<unknown>(usdc, 'storage_balance_of', { account_id: to })
  if (!registered) {
    await call({
      contractId: usdc,
      method: 'storage_deposit',
      args: { account_id: to, registration_only: true },
      tgas: 30,
      deposit: STORAGE_DEPOSIT,
    })
  }
  await call({
    contractId: usdc,
    method: 'ft_transfer',
    args: { receiver_id: to, amount: String(amount) },
    tgas: 30,
    deposit: 1n,
  })
}

/** The named account a client pays into. */
export function payAccount(handle: string) {
  return `${handle}.${config.contract}`
}

/** What the contract did with one payment, read from the events of the sweep transaction. */
export type Receipt = { hash: string; amount: bigint; repaid: bigint; fee: bigint; forwarded: bigint }

/** A demo payment: test dollars land on the pay account, then get forwarded as income. */
export async function pay(handle: string, amount: bigint): Promise<Receipt> {
  const account = payAccount(handle)
  await mint(account, amount)
  const { hash, events } = await callForEvents({ contractId: account, method: 'sweep', tgas: 150 })
  const repay = events.find(({ event }) => event === 'repay')?.data
  const repaid = BigInt((repay?.principal as string | undefined) ?? 0)
  const fee = BigInt((repay?.fee as string | undefined) ?? 0)
  return { hash, amount, repaid, fee, forwarded: amount - repaid - fee }
}

/** Mints test dollars to the guest and deposits them into the pool. */
export async function addToPool(amount: bigint) {
  const { usdc } = await getConfig()
  await mint(await ensureGuest(), amount)
  await call({
    contractId: usdc,
    method: 'ft_transfer_call',
    args: { receiver_id: config.contract, amount: String(amount), msg: '{"deposit":true}' },
    deposit: 1n,
  })
}

const PLAIN: Record<string, string> = {
  'handle is taken': 'That name is already taken. Try another one.',
  'account already has a handle': 'This browser already has a pay link. Reload the page to see it.',
  'handle is already verified': 'Your identity is already verified. Reload the page.',
  'person already has a handle': 'This identity is already verified for another pay link.',
  'person is banned': 'This identity cannot take advances because an earlier one was never paid back.',
  'amount exceeds the limit': 'That is more than your limit right now. Enter a smaller amount.',
  'not enough liquidity': 'The pool cannot cover this right now. Try a smaller amount or come back later.',
  'utilization cap reached': 'The pool cannot cover this right now. Try a smaller amount or come back later.',
  'not enough liquid funds': 'Too much of the pool is out in advances right now. Try again once some are paid back.',
  'withdrawal is too small': 'Your share is too small to withdraw.',
  'deposit is too small': 'That amount is too small. Add at least $1.',
  'nothing to claim': 'There is nothing waiting for you. Reload the page.',
  'amount is below the minimum advance': 'The smallest advance is $1.',
  'deposit is below the minimum': 'That amount is too small. Add at least $1.',
  'first deposit must exceed the locked minimum': 'The first deposit into the pool has to be more than $1.',
  'shares are still locked': 'Money you added recently cannot be withdrawn yet. Try again a little later.',
}

/** Turns a contract panic into a sentence for the person. Anything else is already one. */
export function explain(message: string) {
  return PLAIN[message] ?? message
}
