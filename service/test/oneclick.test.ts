import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOneClick, OneClickError, USDC_ON_NEAR } from '../src/oneclick.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const PARAMS = {
  originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  amountOut: '5000000',
  recipient: 'anna.preday.near',
  refundTo: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
};
const QUOTE = {
  depositAddress: '0xdeposit',
  amountIn: '5051100',
  amountInFormatted: '5.0511',
  amountOut: '5000000',
  deadline: '2030-01-01T00:15:00.000Z',
};

test('quote sends an EXACT_OUTPUT request for USDC on NEAR to the recipient', async () => {
  const { calls, fetchFn } = fakeFetch(201, { quote: QUOTE });
  const before = Date.now();

  const quote = await createOneClick(undefined, fetchFn).quote(PARAMS);

  assert.deepEqual(quote, QUOTE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://1click.chaindefuser.com/v0/quote');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-api-key'), null);

  const { deadline, ...body } = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual(body, {
    dry: false,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: PARAMS.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDC_ON_NEAR,
    amount: '5000000',
    refundTo: PARAMS.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: 'anna.preday.near',
    recipientType: 'DESTINATION_CHAIN',
  });
  const lifetime = Date.parse(deadline) - before;
  assert.ok(lifetime >= 15 * 60 * 1000 && lifetime < 16 * 60 * 1000, `deadline is ${lifetime} ms ahead`);
});

test('the API key is sent in the x-api-key header', async () => {
  const { calls, fetchFn } = fakeFetch(201, { quote: QUOTE });

  await createOneClick('partner-jwt', fetchFn).quote(PARAMS);

  assert.equal(new Headers(calls[0]!.init.headers).get('x-api-key'), 'partner-jwt');
});

test('quote surfaces the 1Click rejection message and status', async () => {
  const { fetchFn } = fakeFetch(400, { message: 'refundTo is not valid' });

  await assert.rejects(
    createOneClick(undefined, fetchFn).quote(PARAMS),
    (error) => error instanceof OneClickError && error.status === 400 && error.message === 'refundTo is not valid',
  );
});

test('quote rejects a malformed response', async () => {
  const { fetchFn } = fakeFetch(201, { quote: { depositAddress: '0xdeposit' } });

  await assert.rejects(
    createOneClick(undefined, fetchFn).quote(PARAMS),
    (error) => error instanceof OneClickError && error.status === 502,
  );
});

test('a network failure becomes a 502 error', async () => {
  const fetchFn = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  await assert.rejects(
    createOneClick(undefined, fetchFn).quote(PARAMS),
    (error) => error instanceof OneClickError && error.status === 502,
  );
});

test('status queries by deposit address and memo', async () => {
  const { calls, fetchFn } = fakeFetch(200, { status: 'PROCESSING' });
  const oneClick = createOneClick(undefined, fetchFn);

  assert.equal(await oneClick.status('0xdeposit'), 'PROCESSING');
  assert.equal(await oneClick.status('GDEPOSIT', '1111111'), 'PROCESSING');

  assert.equal(calls[0]!.url, 'https://1click.chaindefuser.com/v0/status?depositAddress=0xdeposit');
  assert.equal(
    calls[1]!.url,
    'https://1click.chaindefuser.com/v0/status?depositAddress=GDEPOSIT&depositMemo=1111111',
  );
});

test('status rejects a value outside the 1Click status set', async () => {
  const { fetchFn } = fakeFetch(200, { status: 'DONE' });

  await assert.rejects(
    createOneClick(undefined, fetchFn).status('0xdeposit'),
    (error) => error instanceof OneClickError && error.status === 502,
  );
});
