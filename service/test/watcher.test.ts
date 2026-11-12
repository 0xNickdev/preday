import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { SwapStatus } from '../src/oneclick.ts';
import { createWatcher } from '../src/watcher.ts';

const DEADLINE = '2030-01-01T00:15:00.000Z';
const HOUR_MS = 60 * 60 * 1000;

let clock: number;
let next: SwapStatus | Error;
let statusCalls: [string, string | undefined][];
let sweeps: string[];
let sweepFailure: Error | undefined;

beforeEach(() => {
  clock = Date.parse(DEADLINE) - 10 * 60 * 1000;
  next = 'PENDING_DEPOSIT';
  statusCalls = [];
  sweeps = [];
  sweepFailure = undefined;
});

function watcherWithDeposit() {
  const watcher = createWatcher(
    {
      status: async (depositAddress, memo) => {
        statusCalls.push([depositAddress, memo]);
        if (next instanceof Error) throw next;
        return next;
      },
    },
    async (accountId) => {
      sweeps.push(accountId);
      if (sweepFailure) throw sweepFailure;
    },
    () => clock,
  );
  watcher.track('0xdeposit', { account: 'anna.preday.near', deadline: DEADLINE });
  return watcher;
}

test('a new deposit is pending until 1Click reports progress', async () => {
  const watcher = watcherWithDeposit();
  assert.equal(watcher.statusOf('0xdeposit'), 'PENDING_DEPOSIT');
  assert.equal(watcher.statusOf('0xother'), undefined);

  next = 'PROCESSING';
  await watcher.tick();

  assert.equal(watcher.statusOf('0xdeposit'), 'PROCESSING');
  assert.deepEqual(sweeps, []);
});

test('SUCCESS sweeps the named account exactly once and stops polling', async () => {
  const watcher = watcherWithDeposit();
  await watcher.tick();
  next = 'SUCCESS';

  await watcher.tick();
  await watcher.tick();
  await watcher.tick();

  assert.deepEqual(sweeps, ['anna.preday.near']);
  assert.equal(statusCalls.length, 2);
  assert.equal(watcher.statusOf('0xdeposit'), 'SUCCESS');
});

test('a failed sweep is retried on the next poll, then never again', async () => {
  const watcher = watcherWithDeposit();
  next = 'SUCCESS';
  sweepFailure = new Error('rpc down');

  await watcher.tick();
  sweepFailure = undefined;
  await watcher.tick();
  await watcher.tick();

  assert.deepEqual(sweeps, ['anna.preday.near', 'anna.preday.near']);
});

for (const terminal of ['REFUNDED', 'FAILED'] as const) {
  test(`${terminal} stops polling without sweeping`, async () => {
    const watcher = watcherWithDeposit();
    next = terminal;

    await watcher.tick();
    await watcher.tick();

    assert.equal(statusCalls.length, 1);
    assert.deepEqual(sweeps, []);
    assert.equal(watcher.statusOf('0xdeposit'), terminal);
  });
}

test('a status error keeps the deposit and is retried', async () => {
  const watcher = watcherWithDeposit();
  next = new Error('1Click is unreachable');

  await watcher.tick();
  next = 'SUCCESS';
  await watcher.tick();

  assert.deepEqual(sweeps, ['anna.preday.near']);
});

test('a deposit is dropped an hour after its deadline', async () => {
  const watcher = watcherWithDeposit();

  clock = Date.parse(DEADLINE) + HOUR_MS - 1;
  await watcher.tick();
  assert.equal(watcher.statusOf('0xdeposit'), 'PENDING_DEPOSIT');

  clock = Date.parse(DEADLINE) + HOUR_MS + 1;
  await watcher.tick();
  assert.equal(watcher.statusOf('0xdeposit'), undefined);
  assert.equal(statusCalls.length, 1);
});

test('a settled deposit is dropped after expiry too', async () => {
  const watcher = watcherWithDeposit();
  next = 'SUCCESS';
  await watcher.tick();

  clock = Date.parse(DEADLINE) + HOUR_MS + 1;
  await watcher.tick();

  assert.equal(watcher.statusOf('0xdeposit'), undefined);
  assert.deepEqual(sweeps, ['anna.preday.near']);
});

test('the deposit memo is passed to the status lookup', async () => {
  const watcher = watcherWithDeposit();
  watcher.track('GDEPOSIT', { account: 'bob.preday.near', memo: '1111111', deadline: DEADLINE });

  await watcher.tick();

  assert.deepEqual(statusCalls, [
    ['0xdeposit', undefined],
    ['GDEPOSIT', '1111111'],
  ]);
});
