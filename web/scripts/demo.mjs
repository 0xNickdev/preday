// Runs the whole Preday story on NEAR testnet with two throwaway accounts and prints each step.
// Usage: npm run demo            (reads VITE_CONTRACT_ID from .env, or pass the contract id as an argument)
import { readFileSync } from 'node:fs'
import { Account, JsonRpcProvider, KeyPair, teraToGas } from 'near-api-js'

const fromEnv = () => /^VITE_CONTRACT_ID=(.+)$/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8'))?.[1]
const contract = process.argv[2] ?? fromEnv()
const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' })
const usd = (units) => `$${(Number(units) / 1e6).toFixed(2)}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args })

async function createAccount(label) {
  const pair = KeyPair.fromRandom('ed25519')
  const accountId = `preday-${label}-${Date.now().toString(36)}.testnet`
  const response = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: pair.getPublicKey().toString() }),
  })
  if (!response.ok) throw new Error(`faucet refused ${accountId}: ${response.status}`)
  return new Account(accountId, provider, pair.toString())
}

const send = (account, contractId, methodName, args = {}, deposit = 0n) =>
  account.callFunction({ contractId, methodName, args, gas: teraToGas(100), deposit, waitUntil: 'FINAL' })

const { usdc, verifier, register_deposit } = await view(contract, 'get_config')
const params = await view(contract, 'get_params')
const handle = `anna-${Date.now().toString(36)}`
const payAccount = `${handle}.${contract}`

const [anna, backer] = await Promise.all([createAccount('worker'), createAccount('backer')])
const balance = async () => usd(await view(usdc, 'ft_balance_of', { account_id: anna.accountId }))
const pay = async (dollars) => {
  await send(backer, usdc, 'mint', { account_id: payAccount, amount: String(dollars * 1e6) })
  await send(backer, payAccount, 'sweep')
}

console.log(`1. Backer adds $500 to the pool`)
await send(backer, usdc, 'mint', { account_id: backer.accountId, amount: '500000000' })
await send(backer, usdc, 'ft_transfer_call', { receiver_id: contract, amount: '500000000', msg: '{"deposit":true}' }, 1n)

console.log(`2. Anna claims the pay link ${handle} -> ${payAccount}`)
await send(anna, contract, 'register', { handle }, BigInt(register_deposit))
const keys = await provider.viewAccessKeyList({ accountId: payAccount })
console.log(`   pay account has ${keys.keys.length} access keys, so only its code can move money`)

console.log(`3. A client pays three times: $1,180, $640, $1,200`)
for (const dollars of [1180, 640, 1200]) await pay(dollars)
console.log(`   Anna's wallet: ${await balance()}`)

console.log(`4. Anna passes the identity check`)
await send(anna, verifier, 'verify', { handle })

console.log(`5. Waiting for ${params.min_history_ms / 1000}s of payment history (30 days in production)`)
for (;;) {
  const limit = await view(contract, 'get_limit', { handle })
  if (limit.eligible) {
    console.log(`   limit open: ${usd(limit.limit)} of a typical ${usd(limit.base)} payment`)
    break
  }
  await sleep(10_000)
}

console.log(`6. Anna takes a $25 advance`)
await send(anna, contract, 'request_advance', { amount: '25000000' })
const { advance } = await view(contract, 'get_worker', { handle })
console.log(`   owes ${usd(advance.principal)} + ${usd(advance.fee)} fee, wallet: ${await balance()}`)

console.log(`7. The next $1,000 payment arrives (after ${params.seasoning_ms / 1000}s, so the advance counts toward a higher limit)`)
await sleep(params.seasoning_ms + 3000)
await pay(1000)
const worker = await view(contract, 'get_worker', { handle })
const pool = await view(contract, 'get_pool')
console.log(`   advance ${worker.advance ? 'still open' : 'paid back'}, limit level ${worker.level}, wallet: ${await balance()}`)
console.log(`   pool: ${usd(pool.assets)} assets, ${usd(pool.reserve)} reserve, ${usd(pool.fees)} fees earned so far`)
console.log(`\nPay page: /${handle}   Explorer: https://testnet.nearblocks.io/address/${contract}`)
