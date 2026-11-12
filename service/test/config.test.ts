import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const ENV = {
  PORT: '8787',
  PREDAY_CONTRACT: 'preday.near',
  NEAR_RPC_URL: 'https://rpc.example',
  KEEPER_ACCOUNT_ID: 'keeper.preday.near',
  KEEPER_PRIVATE_KEY: 'ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr',
  ALLOWED_ORIGIN: 'https://app.preday.test',
};

test('loads a complete environment', () => {
  assert.deepEqual(loadConfig({ ...ENV, ONECLICK_API_KEY: ' jwt ' }), {
    port: 8787,
    predayContract: 'preday.near',
    nearRpcUrl: 'https://rpc.example',
    keeperAccountId: 'keeper.preday.near',
    keeperPrivateKey: ENV.KEEPER_PRIVATE_KEY,
    oneClickApiKey: 'jwt',
    allowedOrigin: 'https://app.preday.test',
  });
});

test('the 1Click API key is optional', () => {
  assert.equal(loadConfig({ ...ENV, ONECLICK_API_KEY: '' }).oneClickApiKey, undefined);
});

test('names every missing variable', () => {
  assert.throws(
    () => loadConfig({ ...ENV, PORT: undefined, KEEPER_PRIVATE_KEY: ' ' }),
    /Missing required environment variables: PORT, KEEPER_PRIVATE_KEY$/,
  );
});

test('rejects an invalid port and a malformed keeper key', () => {
  assert.throws(() => loadConfig({ ...ENV, PORT: 'http' }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ ...ENV, KEEPER_PRIVATE_KEY: 'not-a-key' }), /KEEPER_PRIVATE_KEY must look like/);
});
