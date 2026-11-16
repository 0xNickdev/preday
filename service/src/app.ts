import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { OneClickError, PAYOUT_FEE_BPS } from './oneclick.ts';
import type { OneClick } from './oneclick.ts';
import type { Watcher } from './watcher.ts';

const MAX_BODY_BYTES = 4096;

export interface AppDeps {
  predayContract: string;
  feeAccount: string;
  allowedOrigin: string;
  oneClick: Pick<OneClick, 'quote' | 'payout'>;
  watcher: Pick<Watcher, 'track' | 'statusOf'>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 1Click failures the caller can fix stay 400. Everything else is the upstream's fault. */
function upstream(error: unknown): never {
  if (error instanceof OneClickError) {
    throw new HttpError(error.status === 400 ? 400 : 502, error.message);
  }
  throw error;
}

export function createApp({ predayContract, feeAccount, allowedOrigin, oneClick, watcher }: AppDeps): RequestListener {
  async function quote(req: IncomingMessage): Promise<unknown> {
    const { handle, amount, originAsset, refundTo } = parse(await readBody(req), QUOTE_FIELDS);
    const account = `${handle}.${predayContract}`;

    const { depositAddress, depositMemo, amountIn, amountInFormatted, amountOut, deadline } = await oneClick
      .quote({ originAsset, amountOut: amount, recipient: account, refundTo })
      .catch(upstream);
    if (!depositAddress || !deadline || Number.isNaN(Date.parse(deadline))) {
      throw new HttpError(502, '1Click returned a quote without a deposit address or deadline');
    }

    watcher.track(depositAddress, { account, memo: depositMemo, deadline });
    return { depositAddress, memo: depositMemo, amountIn, amountInFormatted, amountOut, deadline };
  }

  /** The worker sends `amountIn` USDC from their own wallet to the deposit address. Preday never holds it. */
  async function payoutQuote(req: IncomingMessage): Promise<unknown> {
    const { destinationAsset, amount, recipient, refundTo } = parse(await readBody(req), PAYOUT_FIELDS);

    const { depositAddress, depositMemo, amountIn, amountOut, amountOutFormatted, deadline } = await oneClick
      .payout({ destinationAsset, amountIn: amount, recipient, refundTo, feeRecipient: feeAccount })
      .catch(upstream);
    if (!depositAddress || !deadline || Number.isNaN(Date.parse(deadline))) {
      throw new HttpError(502, '1Click returned a quote without a deposit address or deadline');
    }
    return { depositAddress, memo: depositMemo, amountIn, amountOut, amountOutFormatted, deadline, feeBps: PAYOUT_FEE_BPS };
  }

  function status(url: URL): unknown {
    const depositAddress = url.searchParams.get('depositAddress');
    if (!depositAddress) throw new HttpError(400, 'depositAddress query parameter is required');
    const current = watcher.statusOf(depositAddress);
    if (!current) throw new HttpError(404, 'Unknown deposit address');
    return { status: current };
  }

  async function route(req: IncomingMessage): Promise<unknown> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const routes: Record<string, { method: string; run: () => unknown }> = {
      '/health': { method: 'GET', run: () => ({ ok: true }) },
      '/quote': { method: 'POST', run: () => quote(req) },
      '/payout-quote': { method: 'POST', run: () => payoutQuote(req) },
      '/status': { method: 'GET', run: () => status(url) },
    };
    const matched = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
    if (!matched) throw new HttpError(404, 'Not found');
    if (req.method !== matched.method) throw new HttpError(405, 'Method not allowed');
    return matched.run();
  }

  return async (req, res) => {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '86400');
      res.writeHead(204).end();
      return;
    }
    try {
      send(res, 200, await route(req));
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error(error);
        send(res, 500, { error: 'Internal error' });
      }
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

type Fields<K extends string> = Record<K, { pattern: RegExp; hint: string }>;

const AMOUNT = { pattern: /^[1-9]\d{0,17}$/, hint: 'a positive integer string in USDC minimal units' };
const ASSET = { pattern: /^[A-Za-z0-9._:-]{1,128}$/, hint: 'a 1Click assetId' };
const ADDRESS = /^[A-Za-z0-9._:+/=-]{1,128}$/;

const QUOTE_FIELDS: Fields<'handle' | 'amount' | 'originAsset' | 'refundTo'> = {
  handle: { pattern: /^[a-z0-9-]{2,32}$/, hint: '2-32 characters of a-z, 0-9 or "-"' },
  amount: AMOUNT,
  originAsset: ASSET,
  refundTo: { pattern: ADDRESS, hint: 'an address on the origin chain' },
};

const PAYOUT_FIELDS: Fields<'destinationAsset' | 'amount' | 'recipient' | 'refundTo'> = {
  destinationAsset: ASSET,
  amount: AMOUNT,
  recipient: { pattern: ADDRESS, hint: 'an address on the destination chain' },
  refundTo: { pattern: /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/, hint: 'the NEAR account the money is sent from' },
};

function parse<K extends string>(body: unknown, fields: Fields<K>): Record<K, string> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const parsed = {} as Record<K, string>;
  for (const field of Object.keys(fields) as K[]) {
    const { pattern, hint } = fields[field];
    const value = input[field];
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new HttpError(400, `${field} must be ${hint}`);
    }
    parsed[field] = value;
  }
  return parsed;
}
