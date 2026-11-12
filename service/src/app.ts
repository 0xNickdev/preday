import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { OneClickError } from './oneclick.ts';
import type { OneClick } from './oneclick.ts';
import type { Watcher } from './watcher.ts';

const MAX_BODY_BYTES = 4096;

export interface AppDeps {
  predayContract: string;
  allowedOrigin: string;
  oneClick: Pick<OneClick, 'quote'>;
  watcher: Pick<Watcher, 'track' | 'statusOf'>;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp({ predayContract, allowedOrigin, oneClick, watcher }: AppDeps): RequestListener {
  async function quote(req: IncomingMessage): Promise<unknown> {
    const { handle, amount, originAsset, refundTo } = parseQuoteBody(await readBody(req));
    const account = `${handle}.${predayContract}`;

    const { depositAddress, depositMemo, amountIn, amountInFormatted, amountOut, deadline } = await oneClick
      .quote({ originAsset, amountOut: amount, recipient: account, refundTo })
      .catch((error: unknown) => {
        if (error instanceof OneClickError) {
          throw new HttpError(error.status === 400 ? 400 : 502, error.message);
        }
        throw error;
      });
    if (!depositAddress || !deadline || Number.isNaN(Date.parse(deadline))) {
      throw new HttpError(502, '1Click returned a quote without a deposit address or deadline');
    }

    watcher.track(depositAddress, { account, memo: depositMemo, deadline });
    return { depositAddress, memo: depositMemo, amountIn, amountInFormatted, amountOut, deadline };
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

interface QuoteBody {
  handle: string;
  amount: string;
  originAsset: string;
  refundTo: string;
}

const QUOTE_FIELDS: Record<keyof QuoteBody, { pattern: RegExp; hint: string }> = {
  handle: { pattern: /^[a-z0-9-]{2,32}$/, hint: '2-32 characters of a-z, 0-9 or "-"' },
  amount: { pattern: /^[1-9]\d{0,17}$/, hint: 'a positive integer string in USDC minimal units' },
  originAsset: { pattern: /^[A-Za-z0-9._:-]{1,128}$/, hint: 'a 1Click assetId' },
  refundTo: { pattern: /^[A-Za-z0-9._:+/=-]{1,128}$/, hint: 'an address on the origin chain' },
};

function parseQuoteBody(body: unknown): QuoteBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const parsed = {} as QuoteBody;
  for (const field of Object.keys(QUOTE_FIELDS) as (keyof QuoteBody)[]) {
    const { pattern, hint } = QUOTE_FIELDS[field];
    const value = input[field];
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new HttpError(400, `${field} must be ${hint}`);
    }
    parsed[field] = value;
  }
  return parsed;
}
