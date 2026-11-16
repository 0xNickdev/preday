export const USDC_ON_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const BASE_URL = 'https://1click.chaindefuser.com';
/** Preday's cut of a withdrawal to another network. 1Click takes it out of the swap and pays it to the fee account. */
export const PAYOUT_FEE_BPS = 30;

const SLIPPAGE_BPS = 100;
const QUOTE_LIFETIME_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const STATUSES = [
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;

export type SwapStatus = (typeof STATUSES)[number];

export interface QuoteParams {
  originAsset: string;
  amountOut: string;
  recipient: string;
  refundTo: string;
  dry?: boolean;
}

export interface PayoutParams {
  destinationAsset: string;
  amountIn: string;
  /** Address on the destination chain. */
  recipient: string;
  /** NEAR account the USDC comes from, and returns to if the swap fails. */
  refundTo: string;
  feeRecipient: string;
  dry?: boolean;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted?: string;
  deadline?: string;
}

export interface OneClick {
  /** A payment in: any coin becomes an exact amount of USDC on a NEAR account. */
  quote(params: QuoteParams): Promise<Quote>;
  /** A withdrawal out: an exact amount of USDC on NEAR becomes a coin on another chain, less the Preday fee. */
  payout(params: PayoutParams): Promise<Quote>;
  status(depositAddress: string, depositMemo?: string): Promise<SwapStatus>;
}

export class OneClickError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OneClickError';
    this.status = status;
  }
}

export function createOneClick(apiKey: string | undefined, fetchFn: typeof fetch = fetch): OneClick {
  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    if (apiKey) headers.set('x-api-key', apiKey);

    let response: Response;
    try {
      response = await fetchFn(BASE_URL + path, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new OneClickError(502, '1Click is unreachable', { cause });
    }

    const body: unknown = await response.json().catch(() => null);
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (!response.ok) {
      const message = typeof fields.message === 'string' ? fields.message : `1Click responded with ${response.status}`;
      throw new OneClickError(response.status, message);
    }
    return fields;
  }

  async function ask(swap: Record<string, unknown>): Promise<Quote> {
    const body = await call('/v0/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slippageTolerance: SLIPPAGE_BPS,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString(),
        ...swap,
      }),
    });
    const quote = body.quote as Partial<Quote> | undefined;
    if (
      typeof quote?.amountIn !== 'string' ||
      typeof quote.amountInFormatted !== 'string' ||
      typeof quote.amountOut !== 'string'
    ) {
      throw new OneClickError(502, '1Click returned a malformed quote');
    }
    return quote as Quote;
  }

  return {
    quote: ({ originAsset, amountOut, recipient, refundTo, dry = false }) =>
      ask({
        dry,
        swapType: 'EXACT_OUTPUT',
        originAsset,
        destinationAsset: USDC_ON_NEAR,
        amount: amountOut,
        refundTo,
        recipient,
      }),

    payout: ({ destinationAsset, amountIn, recipient, refundTo, feeRecipient, dry = false }) =>
      ask({
        dry,
        swapType: 'EXACT_INPUT',
        originAsset: USDC_ON_NEAR,
        destinationAsset,
        amount: amountIn,
        refundTo,
        recipient,
        appFees: [{ recipient: feeRecipient, fee: PAYOUT_FEE_BPS }],
      }),

    async status(depositAddress, depositMemo) {
      const query = new URLSearchParams({ depositAddress });
      if (depositMemo) query.set('depositMemo', depositMemo);
      const { status } = await call(`/v0/status?${query}`);
      if (!STATUSES.includes(status as SwapStatus)) {
        throw new OneClickError(502, `1Click returned an unknown status: ${String(status)}`);
      }
      return status as SwapStatus;
    },
  };
}
