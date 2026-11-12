import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';
import type { Config } from './config.ts';

export type Sweep = (accountId: string) => Promise<void>;

export function createSweep(config: Pick<Config, 'nearRpcUrl' | 'keeperAccountId' | 'keeperPrivateKey'>): Sweep {
  const keeper = new Account(
    config.keeperAccountId,
    new JsonRpcProvider({ url: config.nearRpcUrl }),
    config.keeperPrivateKey,
  );

  return async (accountId) => {
    await keeper.callFunction({
      contractId: accountId,
      methodName: 'sweep',
      args: {},
      gas: teraToGas(150),
      deposit: 0n,
    });
  };
}
