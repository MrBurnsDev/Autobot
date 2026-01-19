import { PublicKey } from '@solana/web3.js';

// Token mints on Solana mainnet
export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Wrapped SOL (same as SOL_MINT for Jupiter)
export const WSOL_MINT = SOL_MINT;

// Token decimals
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

// D3fenders Swap API (proxies Jupiter with fee handling)
export const D3FENDERS_SWAP_API_BASE = 'https://d3fenders-swap-service.vercel.app';
export const D3FENDERS_SOLANA_QUOTE_ENDPOINT = `${D3FENDERS_SWAP_API_BASE}/solana/quote`;
export const D3FENDERS_SOLANA_BUILD_ENDPOINT = `${D3FENDERS_SWAP_API_BASE}/solana/build`;

// Legacy Jupiter API endpoints (deprecated - now requires paid API key)
export const JUPITER_API_BASE = D3FENDERS_SWAP_API_BASE;
export const JUPITER_QUOTE_ENDPOINT = D3FENDERS_SOLANA_QUOTE_ENDPOINT;
export const JUPITER_SWAP_ENDPOINT = D3FENDERS_SOLANA_BUILD_ENDPOINT;

// Transaction settings
export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
export const DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1000; // 0.001 lamports per CU
export const LAMPORTS_PER_SOL = 1_000_000_000;

// Confirmation settings
export const MAX_CONFIRMATION_RETRIES = 30;
export const CONFIRMATION_RETRY_DELAY_MS = 2000;
export const TRANSACTION_EXPIRY_SECONDS = 60;

// Popular DEXes on Solana (for allowedSources/excludedSources filtering)
export const SOLANA_DEX_NAMES = [
  'Orca',
  'Orca (Whirlpools)',
  'Raydium',
  'Raydium CLMM',
  'Meteora',
  'Meteora DLMM',
  'Phoenix',
  'Lifinity',
  'Lifinity V2',
  'OpenBook',
  'Serum',
  'Saber',
  'Cropper',
  'GooseFX',
  'Marinade',
  'Aldrin',
  'Crema',
  'Cykura',
  'Dradex',
  'Invariant',
  'Mercurial',
  'Penguin',
  'Saros',
  'Sencha',
  'Step Finance',
  'Whirlpool',
] as const;

export type SolanaDexName = (typeof SOLANA_DEX_NAMES)[number];
