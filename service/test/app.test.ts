import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { OneClickError } from '../src/oneclick.ts';
import type { Quote, QuoteParams, SwapStatus } from '../src/oneclick.ts';

const ORIGIN = 'https://app.preday.test';
const VALID = {
  handle: 'anna',
  amount: '5000000',
  originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  refundTo: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
};
const QUOTE: Quote = {
  depositAddress: '0xdeposit',
  amountIn: '5051100',
  amountInFormatted: '5.0511',
  amountOut: '5000000',
  deadline: '2030-01-01T00:15:00.000Z',
};

let quoteCalls: QuoteParams[];
let quoteResult: () => Promise<Quote>;
let tracked: [string, { account: string; memo?: string; deadline: string }][];
let statuses: Record<string, SwapStatus>;

const server = createServer(
  createApp({
    predayContract: 'preday.near',
    allowedOrigin: ORIGIN,
    oneClick: {
      quote: (params) => {
        quoteCalls.push(params);
        return quoteResult();
      },
    },
    watcher: {
      track: (depositAddress, deposit) => void tracked.push([depositAddress, deposit]),
      statusOf: (depositAddress) => statuses[depositAddress],
    },
  }),
);
let base: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  quoteCalls = [];
  quoteResult = async () => QUOTE;
  tracked = [];
  statuses = {};
});

const postQuote = (body: unknown) =>
  fetch(`${base}/quote`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('POST /quote returns the deposit details and tracks the deposit', async () => {
  const response = await postQuote(VALID);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), QUOTE);
  assert.deepEqual(quoteCalls, [
    { originAsset: VALID.originAsset, amountOut: '5000000', recipient: 'anna.preday.near', refundTo: VALID.refundTo },
  ]);
  assert.deepEqual(tracked, [
    ['0xdeposit', { account: 'anna.preday.near', memo: undefined, deadline: QUOTE.deadline }],
  ]);
});

test('POST /quote exposes the deposit memo when 1Click requires one', async () => {
  quoteResult = async () => ({ ...QUOTE, depositMemo: '1111111' });

  const body = await (await postQuote(VALID)).json();

  assert.equal(body.memo, '1111111');
  assert.equal(tracked[0]?.[1].memo, '1111111');
});

const invalidBodies: [string, unknown][] = [
  ['malformed JSON', '{'],
  ['non-object body', [VALID]],
  ['missing handle', { ...VALID, handle: undefined }],
  ['short handle', { ...VALID, handle: 'a' }],
  ['uppercase handle', { ...VALID, handle: 'Anna' }],
  ['handle with a dot', { ...VALID, handle: 'anna.evil' }],
  ['handle longer than 32', { ...VALID, handle: 'a'.repeat(33) }],
  ['numeric amount', { ...VALID, amount: 5000000 }],
  ['zero amount', { ...VALID, amount: '0' }],
  ['negative amount', { ...VALID, amount: '-5' }],
  ['decimal amount', { ...VALID, amount: '1.5' }],
  ['amount with leading zero', { ...VALID, amount: '05' }],
  ['empty originAsset', { ...VALID, originAsset: '' }],
  ['originAsset with spaces', { ...VALID, originAsset: 'nep141:usdc near' }],
  ['missing refundTo', { ...VALID, refundTo: undefined }],
  ['oversized refundTo', { ...VALID, refundTo: 'x'.repeat(129) }],
];

for (const [name, body] of invalidBodies) {
  test(`POST /quote rejects ${name}`, async () => {
    const response = await postQuote(body);

    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(quoteCalls.length, 0);
    assert.equal(tracked.length, 0);
  });
}

test('POST /quote rejects an oversized body', async () => {
  const response = await postQuote({ ...VALID, padding: 'x'.repeat(5000) });

  assert.equal(response.status, 413);
});

test('POST /quote passes through the 1Click message when the quote is rejected', async () => {
  quoteResult = async () => {
    throw new OneClickError(400, 'refundTo is not valid');
  };

  const response = await postQuote(VALID);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'refundTo is not valid' });
  assert.equal(tracked.length, 0);
});

test('POST /quote answers 502 when 1Click fails', async () => {
  quoteResult = async () => {
    throw new OneClickError(401, 'Unauthorized');
  };

  const response = await postQuote(VALID);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('POST /quote answers 502 when the quote has no deposit address', async () => {
  quoteResult = async () => ({ ...QUOTE, depositAddress: undefined });

  const response = await postQuote(VALID);

  assert.equal(response.status, 502);
  assert.equal(tracked.length, 0);
});

test('POST /quote hides unexpected errors', async () => {
  quoteResult = async () => {
    throw new Error('secret detail');
  };

  const response = await postQuote(VALID);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal error' });
});

test('GET /status returns the status of a tracked deposit', async () => {
  statuses['0xdeposit'] = 'PROCESSING';

  const response = await fetch(`${base}/status?depositAddress=0xdeposit`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'PROCESSING' });
});

test('GET /status answers 404 for an unknown deposit and 400 without one', async () => {
  assert.equal((await fetch(`${base}/status?depositAddress=0xother`)).status, 404);
  assert.equal((await fetch(`${base}/status`)).status, 400);
});

test('GET /health answers ok', async () => {
  const response = await fetch(`${base}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('unknown paths answer 404 and wrong methods 405', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/constructor`)).status, 404);
  assert.equal((await fetch(`${base}/quote`)).status, 405);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
});

test('CORS allows only the configured origin', async () => {
  const preflight = await fetch(`${base}/quote`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST');
  assert.equal((await fetch(`${base}/health`)).headers.get('access-control-allow-origin'), ORIGIN);
});
