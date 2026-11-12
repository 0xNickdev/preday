import { config } from './config'
import { call, ensureGuest, view } from './near'

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
}

type Advance = { principal: string; fee: string; repaid: string; opened_at: number; touched_at: number; late: boolean }

export type Worker = {
  handle: string
  owner: string
  verified: boolean
  banned: boolean
  level: number
  payments_count: number
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

type Payment = { amount: string; at: number }

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
export const getShares = (accountId: string) => read<string>('get_shares', { account_id: accountId })

/** The latest payments, newest first. `count` is the worker's payments_count. */
export async function getRecentPayments(handle: string, count: number) {
  const from = Math.max(0, count - RECENT)
  const payments = await read<Payment[]>('get_payments', { handle, from, limit: RECENT })
  return payments.reverse()
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

/** The named account a client pays into. */
export function payAccount(handle: string) {
  return `${handle}.${config.contract}`
}

/** A demo payment: test dollars land on the pay account, then get forwarded as income. */
export async function pay(handle: string, amount: bigint) {
  const account = payAccount(handle)
  await mint(account, amount)
  await call({ contractId: account, method: 'sweep', tgas: 150 })
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
}

/** Turns a contract panic into a sentence for the person. Anything else is already one. */
export function explain(message: string) {
  return PLAIN[message] ?? message
}
