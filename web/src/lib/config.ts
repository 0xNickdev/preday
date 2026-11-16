const env = import.meta.env

export const config = {
  contract: env.VITE_CONTRACT_ID as string,
  network: (env.VITE_CONTRACT_ID as string | undefined)?.endsWith('.near') ? ('mainnet' as const) : ('testnet' as const),
  rpc: (env.VITE_RPC_URL as string | undefined) ?? 'https://test.rpc.fastnear.com',
  faucet: 'https://helper.nearprotocol.com/account',
  explorer: 'https://testnet.nearblocks.io',
  tokens: 'https://1click.chaindefuser.com/v0/tokens',
  quote: 'https://1click.chaindefuser.com/v0/quote',
  /** The Preday service that issues deposit addresses. Without it the pay page only takes test dollars. */
  service: (env.VITE_SERVICE_URL as string | undefined)?.replace(/\/$/, ''),
}
