import type {
  JupiterQuoteRequest,
  JupiterQuoteResponse,
  JupiterSwapRequest,
  JupiterSwapResponse,
} from './types.js';
import { QuoteError, RpcError, Logger, retryWithBackoff } from '@autobot/core';

const logger = new Logger('JupiterClient');

export class JupiterClient {
  private apiBase: string;
  private apiKey?: string;

  constructor(apiBase?: string, apiKey?: string) {
    this.apiBase = apiBase ?? 'https://api.jup.ag/swap/v1';
    this.apiKey = apiKey;
    logger.info('JupiterClient initialized', {
      apiBase: this.apiBase,
      hasApiKey: !!apiKey,
    });
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  /**
   * Get a quote from Jupiter
   */
  async getQuote(params: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const url = new URL(`${this.apiBase}/quote`);

    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amount);
    url.searchParams.set('slippageBps', params.slippageBps.toString());

    if (params.swapMode) {
      url.searchParams.set('swapMode', params.swapMode);
    }
    if (params.dexes && params.dexes.length > 0) {
      url.searchParams.set('dexes', params.dexes.join(','));
    }
    if (params.excludeDexes && params.excludeDexes.length > 0) {
      url.searchParams.set('excludeDexes', params.excludeDexes.join(','));
    }
    if (params.onlyDirectRoutes) {
      url.searchParams.set('onlyDirectRoutes', 'true');
    }
    if (params.restrictIntermediateTokens) {
      url.searchParams.set('restrictIntermediateTokens', 'true');
    }

    logger.debug('Fetching Jupiter quote', {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
    });

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new QuoteError(`Jupiter quote failed: ${res.status} ${errorText}`, {
            status: res.status,
            body: errorText,
          });
        }

        return res.json() as Promise<JupiterQuoteResponse>;
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

    logger.debug('Jupiter quote received', {
      inAmount: response.inAmount,
      outAmount: response.outAmount,
      priceImpactPct: response.priceImpactPct,
    });

    return response;
  }

  /**
   * Get swap transaction from Jupiter
   */
  async getSwapTransaction(params: JupiterSwapRequest): Promise<JupiterSwapResponse> {
    const url = `${this.apiBase}/swap`;

    logger.debug('Requesting Jupiter swap transaction', {
      userPublicKey: params.userPublicKey,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
    });

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            userPublicKey: params.userPublicKey,
            quoteResponse: params.quoteResponse,
            wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
            useSharedAccounts: params.useSharedAccounts ?? true,
            computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports,
            prioritizationFeeLamports: params.prioritizationFeeLamports,
            dynamicComputeUnitLimit: params.dynamicComputeUnitLimit ?? true,
            asLegacyTransaction: params.asLegacyTransaction ?? false,
          }),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RpcError(`Jupiter swap failed: ${res.status} ${errorText}`, {
            status: res.status,
            body: errorText,
          });
        }

        return res.json() as Promise<JupiterSwapResponse>;
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

    logger.debug('Jupiter swap transaction received', {
      lastValidBlockHeight: response.lastValidBlockHeight,
      prioritizationFeeLamports: response.prioritizationFeeLamports,
    });

    return response;
  }

  /**
   * Check Jupiter API health via a minimal quote request
   */
  async checkHealth(): Promise<{ connected: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const testUrl = new URL(`${this.apiBase}/quote`);
      testUrl.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
      testUrl.searchParams.set('outputMint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      testUrl.searchParams.set('amount', '1000000');
      testUrl.searchParams.set('slippageBps', '50');

      const res = await fetch(testUrl.toString(), {
        method: 'GET',
        headers: this.getHeaders(),
      });

      const latencyMs = Date.now() - start;
      return { connected: res.ok, latencyMs };
    } catch {
      return { connected: false, latencyMs: Date.now() - start };
    }
  }
}
