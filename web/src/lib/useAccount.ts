import { useSyncExternalStore } from 'react'
import { accountId, onAccount, walletId } from './near'

/** The account the app acts as and whether it is a connected wallet, kept current as wallets come and go. */
export function useAccount() {
  return { account: useSyncExternalStore(onAccount, accountId), wallet: useSyncExternalStore(onAccount, walletId) }
}
