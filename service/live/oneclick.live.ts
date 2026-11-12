// Sends dry-run quotes to the real 1Click API: no deposit address is created and no funds move.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOneClick, OneClickError } from '../src/oneclick.ts';

const oneClick = createOneClick(process.env.ONECLICK_API_KEY);
const RECIPIENT = 'root.near';

const origins = [
  {
    name: 'USDC on Base',
    originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    refundTo: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    amountOut: '5000000',
  },
  {
    name: 'USDT on Tron',
    originAsset: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    refundTo: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
    amountOut: '150000000',
  },
];

for (const { name, originAsset, refundTo, amountOut } of origins) {
  test(`1Click accepts a dry quote for ${name}`, async () => {
    const quote = await oneClick.quote({ originAsset, amountOut, recipient: RECIPIENT, refundTo, dry: true });

    console.log(name, quote);
    assert.equal(quote.amountOut, amountOut);
    assert.match(quote.amountIn, /^[1-9]\d*$/);
    assert.equal(quote.depositAddress, undefined);
  });
}

test('1Click rejects an invalid refund address with a message', async () => {
  await assert.rejects(
    oneClick.quote({ ...origins[0]!, recipient: RECIPIENT, refundTo: 'nope', dry: true }),
    (error) => error instanceof OneClickError && error.status === 400 && error.message.length > 0,
  );
});

test('1Click answers 404 for an unknown deposit address', async () => {
  await assert.rejects(
    oneClick.status('0x0000000000000000000000000000000000000001'),
    (error) => error instanceof OneClickError && error.status === 404,
  );
});
