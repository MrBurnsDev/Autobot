import type { ChainAdapter } from '@autobot/core';
import { ConfigurationError } from '@autobot/core';
import { SolanaAdapter } from '@autobot/solana-adapter';
import { AvalancheAdapter } from '@autobot/avalanche-adapter';
import type { Chain } from '@autobot/db';
import { config } from '../config.js';

const adapterCache = new Map<string, ChainAdapter>();

export function getAdapter(chain: Chain, instanceId?: string): ChainAdapter {
  const cacheKey = `${chain}:${instanceId ?? 'default'}`;

  const cached = adapterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let adapter: ChainAdapter;

  switch (chain) {
    case 'SOLANA': {
      if (!config.solana.privateKeyBase58) {
        throw new ConfigurationError('SOLANA_PRIVATE_KEY_BASE58 is required for Solana trading');
      }
      adapter = new SolanaAdapter({
        rpcUrl: config.solana.rpcUrl,
        privateKeyBase58: config.solana.privateKeyBase58,
        jupiterApiBase: config.solana.jupiterApiBase,
        priorityFeeMicroLamports: config.solana.priorityFeeMicroLamports,
      });
      break;
    }

    case 'AVALANCHE': {
      if (!config.avalanche.privateKey) {
        throw new ConfigurationError('EVM_PRIVATE_KEY is required for Avalanche trading');
      }
      adapter = new AvalancheAdapter({
        rpcUrl: config.avalanche.rpcUrl,
        privateKey: config.avalanche.privateKey,
        paraswapPartner: config.avalanche.paraswapPartner,
        maxGasPriceGwei: config.avalanche.maxGasGwei,
      });
      break;
    }

    default:
      throw new ConfigurationError(`Unsupported chain: ${chain}`);
  }

  adapterCache.set(cacheKey, adapter);
  return adapter;
}

export function clearAdapterCache(): void {
  adapterCache.clear();
}
