import type { KeyPairString } from 'near-api-js';

export interface Config {
  port: number;
  predayContract: string;
  nearRpcUrl: string;
  keeperAccountId: string;
  keeperPrivateKey: KeyPairString;
  oneClickApiKey: string | undefined;
  allowedOrigin: string;
}

const REQUIRED = [
  'PORT',
  'PREDAY_CONTRACT',
  'NEAR_RPC_URL',
  'KEEPER_ACCOUNT_ID',
  'KEEPER_PRIVATE_KEY',
  'ALLOWED_ORIGIN',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const read = (name: (typeof REQUIRED)[number]) => env[name]!.trim();

  const port = Number(read('PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const keeperPrivateKey = read('KEEPER_PRIVATE_KEY');
  if (!isKeyPairString(keeperPrivateKey)) {
    throw new Error('KEEPER_PRIVATE_KEY must look like "ed25519:<base58 secret key>"');
  }

  return {
    port,
    predayContract: read('PREDAY_CONTRACT'),
    nearRpcUrl: read('NEAR_RPC_URL'),
    keeperAccountId: read('KEEPER_ACCOUNT_ID'),
    keeperPrivateKey,
    oneClickApiKey: env.ONECLICK_API_KEY?.trim() || undefined,
    allowedOrigin: read('ALLOWED_ORIGIN'),
  };
}

function isKeyPairString(value: string): value is KeyPairString {
  return /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}
