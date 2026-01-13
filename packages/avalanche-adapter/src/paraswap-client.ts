import {
  PARASWAP_API_URL,
  PARASWAP_PARTNER,
  AVALANCHE_CHAIN_ID,
} from './constants.js';
import type {
  ParaSwapPriceRequest,
  ParaSwapPriceResponse,
  ParaSwapTransactionRequest,
  ParaSwapTransactionResponse,
} from './types.js';
import { QuoteError, RpcError, Logger, retryWithBackoff } from '@autobot/core';

const logger = new Logger('ParaSwapClient');

export class ParaSwapClient {
  private apiUrl: string;
  private partner: string;

  constructor(apiUrl?: string, partner?: string) {
    this.apiUrl = apiUrl ?? PARASWAP_API_URL;
    this.partner = partner ?? PARASWAP_PARTNER;
  }

  /**
   * Get a price quote from ParaSwap
   */
  async getPrice(params: ParaSwapPriceRequest): Promise<ParaSwapPriceResponse> {
    const url = new URL(`${this.apiUrl}/prices`);

    url.searchParams.set('srcToken', params.srcToken);
    url.searchParams.set('destToken', params.destToken);
    url.searchParams.set('srcDecimals', params.srcDecimals.toString());
    url.searchParams.set('destDecimals', params.destDecimals.toString());
    url.searchParams.set('amount', params.amount);
    url.searchParams.set('side', params.side);
    url.searchParams.set('network', params.network.toString());
    url.searchParams.set('partner', this.partner);

    if (params.includeDEXS) {
      url.searchParams.set('includeDEXS', params.includeDEXS);
    }
    if (params.excludeDEXS) {
      url.searchParams.set('excludeDEXS', params.excludeDEXS);
    }

    logger.debug('Fetching ParaSwap price', {
      srcToken: params.srcToken,
      destToken: params.destToken,
      amount: params.amount,
      side: params.side,
    });

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new QuoteError(`ParaSwap price failed: ${res.status} ${errorText}`, {
            status: res.status,
            body: errorText,
          });
        }

        return res.json() as Promise<ParaSwapPriceResponse>;
      },
      {
        maxRetries: 3,
        initialDelayMs: 500,
        maxDelayMs: 2000,
        shouldRetry: (err) => {
          if (err instanceof QuoteError && err.details?.status) {
            const status = err.details.status as number;
            return status >= 500 || status === 429;
          }
          return true;
        },
      }
    );

    logger.debug('ParaSwap price received', {
      srcAmount: response.priceRoute.srcAmount,
      destAmount: response.priceRoute.destAmount,
      gasCostUSD: response.priceRoute.gasCostUSD,
    });

    return response;
  }

  /**
   * Build swap transaction from ParaSwap
   */
  async buildTransaction(
    params: ParaSwapTransactionRequest
  ): Promise<ParaSwapTransactionResponse> {
    const url = `${this.apiUrl}/transactions/${AVALANCHE_CHAIN_ID}`;

    const body = {
      srcToken: params.srcToken,
      destToken: params.destToken,
      srcAmount: params.srcAmount,
      destAmount: params.destAmount,
      priceRoute: params.priceRoute,
      userAddress: params.userAddress,
      partner: this.partner,
      slippage: params.slippage,
      deadline: params.deadline ?? Math.floor(Date.now() / 1000) + 300, // 5 min default
    };

    logger.debug('Building ParaSwap transaction', {
      userAddress: params.userAddress,
      slippage: params.slippage,
    });

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RpcError(`ParaSwap transaction build failed: ${res.status} ${errorText}`, {
            status: res.status,
            body: errorText,
          });
        }

        return res.json() as Promise<ParaSwapTransactionResponse>;
      },
      {
        maxRetries: 2,
        initialDelayMs: 500,
        maxDelayMs: 2000,
        shouldRetry: (err) => {
          if (err instanceof RpcError && err.details?.status) {
            const status = err.details.status as number;
            return status >= 500 || status === 429;
          }
          return true;
        },
      }
    );

    logger.debug('ParaSwap transaction built', {
      to: response.to,
      value: response.value,
    });

    return response;
  }

  /**
   * Check ParaSwap API health
   */
  async checkHealth(): Promise<{ connected: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      // Use a minimal price request to check health
      const url = new URL(`${this.apiUrl}/prices`);
      url.searchParams.set('srcToken', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'); // WAVAX
      url.searchParams.set('destToken', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'); // USDC
      url.searchParams.set('srcDecimals', '18');
      url.searchParams.set('destDecimals', '6');
      url.searchParams.set('amount', '1000000000000000000'); // 1 AVAX
      url.searchParams.set('side', 'SELL');
      url.searchParams.set('network', AVALANCHE_CHAIN_ID.toString());

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const latencyMs = Date.now() - start;
      return { connected: res.ok, latencyMs };
    } catch {
      return { connected: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Get token transfer proxy address for approvals
   */
  async getTokenTransferProxy(): Promise<string> {
    // ParaSwap v5 uses a fixed token transfer proxy on Avalanche
    // This is returned in the price response, but we can also hardcode the known address
    return '0x216B4B4Ba9F3e719726886d34a177484278Bfcae';
  }
}
