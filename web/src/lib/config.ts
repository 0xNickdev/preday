const env = import.meta.env

export const config = {
  contract: env.VITE_CONTRACT_ID as string,
  rpc: (env.VITE_RPC_URL as string | undefined) ?? 'https://test.rpc.fastnear.com',
  faucet: 'https://helper.nearprotocol.com/account',
  explorer: 'https://testnet.nearblocks.io',
  tokens: 'https://1click.chaindefuser.com/v0/tokens',
}
