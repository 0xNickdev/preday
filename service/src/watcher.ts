import type { OneClick, SwapStatus } from './oneclick.ts';
import type { Sweep } from './keeper.ts';

const EXPIRY_GRACE_MS = 60 * 60 * 1000;

interface Deposit {
  account: string;
  memo: string | undefined;
  expiresAt: number;
  status: SwapStatus;
  settled: boolean;
}

export interface Watcher {
  track(depositAddress: string, deposit: { account: string; memo?: string; deadline: string }): void;
  statusOf(depositAddress: string): SwapStatus | undefined;
  tick(): Promise<void>;
  start(intervalMs: number): () => void;
}

export function createWatcher(oneClick: Pick<OneClick, 'status'>, sweep: Sweep, now: () => number = Date.now): Watcher {
  // Deposits live in memory only. After a restart they are forgotten, and their USDC waits on the
  // named account until anyone calls sweep().
  const deposits = new Map<string, Deposit>();

  async function check(depositAddress: string, deposit: Deposit): Promise<void> {
    deposit.status = await oneClick.status(depositAddress, deposit.memo);
    if (deposit.status === 'SUCCESS') {
      await sweep(deposit.account);
      console.log(`swept ${deposit.account} for deposit ${depositAddress}`);
    }
    deposit.settled = ['SUCCESS', 'REFUNDED', 'FAILED'].includes(deposit.status);
  }

  async function tick(): Promise<void> {
    // One deposit at a time, so sweeps signed by the single keeper key never race on its nonce.
    for (const [depositAddress, deposit] of deposits) {
      if (now() > deposit.expiresAt) {
        deposits.delete(depositAddress);
      } else if (!deposit.settled) {
        await check(depositAddress, deposit).catch((error) => {
          console.error(`deposit ${depositAddress} check failed, retrying on the next poll:`, error);
        });
      }
    }
  }

  return {
    track(depositAddress, { account, memo, deadline }) {
      deposits.set(depositAddress, {
        account,
        memo,
        expiresAt: Date.parse(deadline) + EXPIRY_GRACE_MS,
        status: 'PENDING_DEPOSIT',
        settled: false,
      });
    },

    statusOf: (depositAddress) => deposits.get(depositAddress)?.status,

    tick,

    start(intervalMs) {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        await tick();
        busy = false;
      }, intervalMs);
      return () => clearInterval(timer);
    },
  };
}
