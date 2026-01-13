import { z } from 'zod';
import type { Chain, TradeSide, TradeSizeMode, StartingMode, PnLMethod } from '@autobot/db';

// Re-export database enums
export type { Chain, TradeSide, TradeSizeMode, StartingMode, PnLMethod };

// Chain adapter interface - implemented by Solana and Avalanche adapters
export interface ChainAdapter {
  chain: Chain;

  // Get current balances
  getBalances(): Promise<BalanceInfo>;

  // Get executable quote for a trade
  getQuote(params: QuoteParams): Promise<QuoteResult>;

  // Execute a trade
  executeSwap(params: SwapParams): Promise<SwapResult>;

  // Validate connectivity
  checkConnectivity(): Promise<ConnectivityStatus>;

  // Get current block/slot for tracking
  getCurrentBlock(): Promise<number | bigint>;
}

export interface BalanceInfo {
  base: number; // SOL or AVAX
  quote: number; // USDC
  baseDecimals: number;
  quoteDecimals: number;
  nativeForGas: number; // SOL or AVAX available for gas
}

export interface QuoteParams {
  side: TradeSide;
  amount: number; // In base or quote depending on mode
  amountIsBase: boolean;
  slippageBps: number;
  allowedSources?: string[];
  excludedSources?: string[];
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  price: number; // Quote per base (USDC per SOL/AVAX)
  priceImpactBps: number | null;
  route: RouteInfo;
  expiresAt: number; // Timestamp
  rawQuote: unknown; // Original quote response for execution
}

export interface RouteInfo {
  sources: string[];
  hops: number;
  description: string;
}

export interface SwapParams {
  quote: QuoteResult;
  clientOrderId: string;
  priorityFeeMicroLamports?: number; // Solana only
  maxFeePerGas?: bigint; // Avalanche only
}

export interface SwapResult {
  success: boolean;
  txSignature: string;
  blockNumber?: bigint;
  slot?: bigint;
  inputAmount: number;
  outputAmount: number;
  executedPrice: number;
  feeNative: number;
  feeNativeUsdc: number;
  actualSlippageBps: number | null;
  error?: SwapError;
}

export interface SwapError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ConnectivityStatus {
  rpcConnected: boolean;
  apiConnected: boolean;
  latencyMs: number;
  blockHeight: number | bigint;
  errors: string[];
}

// Strategy types
export interface StrategyConfig {
  buyDipPct: number;
  sellRisePct: number;
  tradeSizeMode: TradeSizeMode;
  tradeSize: number;
  minTradeNotional: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  cooldownSeconds: number;
  maxTradesPerHour: number;
  dailyLossLimitUsdc: number | null;
  maxDrawdownPct: number | null;
  maxConsecutiveFailures: number;
  minBaseReserve: number;
  minQuoteReserve: number;
  takeProfitUsdc: number | null;
  stopLossUsdc: number | null;
  startingMode: StartingMode;
  pnlMethod: PnLMethod;
  allowedSources: string[];
  excludedSources: string[];
  maxPriceDeviationBps: number;
  dryRunMode: boolean;
}

export interface StrategyState {
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  lastTradeAt: Date | null;
  consecutiveFailures: number;
  tradesThisHour: number;
  hourlyResetAt: Date;
  dailyRealizedPnl: number;
  dailyResetAt: Date;
  totalBaseCost: number;
  totalBaseQty: number;
}

export type StrategyAction =
  | { type: 'BUY'; reason: string; size: TradeSize }
  | { type: 'SELL'; reason: string; size: TradeSize }
  | { type: 'HOLD'; reason: string }
  | { type: 'PAUSE'; reason: string };

export interface TradeSize {
  baseAmount?: number;
  quoteAmount?: number;
}

export interface StrategyContext {
  config: StrategyConfig;
  state: StrategyState;
  balances: BalanceInfo;
  currentPrice: number;
  quote: QuoteResult;
}

// PnL calculation types
export interface PnLCalculation {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  costBasis: number;
  portfolioValue: number;
}

export interface FillForPnL {
  side: TradeSide;
  baseQty: number;
  quoteQty: number;
  executedPrice: number;
  feeQuote: number;
  feeNativeUsdc: number;
}

// Validation schemas
export const QuoteParamsSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  amount: z.number().positive(),
  amountIsBase: z.boolean(),
  slippageBps: z.number().int().min(1).max(1000),
  allowedSources: z.array(z.string()).optional(),
  excludedSources: z.array(z.string()).optional(),
});

export const StrategyConfigSchema = z.object({
  buyDipPct: z.number().min(0.1).max(50),
  sellRisePct: z.number().min(0.1).max(100),
  tradeSizeMode: z.enum(['FIXED_QUOTE', 'FIXED_BASE', 'PERCENT_BALANCE']),
  tradeSize: z.number().positive(),
  minTradeNotional: z.number().min(1),
  maxSlippageBps: z.number().int().min(1).max(1000),
  maxPriceImpactBps: z.number().int().min(1).max(1000).nullable(),
  cooldownSeconds: z.number().int().min(0),
  maxTradesPerHour: z.number().int().min(1).max(100),
  dailyLossLimitUsdc: z.number().positive().nullable(),
  maxDrawdownPct: z.number().min(1).max(100).nullable(),
  maxConsecutiveFailures: z.number().int().min(1),
  minBaseReserve: z.number().min(0),
  minQuoteReserve: z.number().min(0),
  takeProfitUsdc: z.number().positive().nullable(),
  stopLossUsdc: z.number().positive().nullable(),
  startingMode: z.enum(['START_BY_BUYING', 'START_BY_SELLING', 'START_NEUTRAL']),
  pnlMethod: z.enum(['AVERAGE_COST', 'FIFO']),
  allowedSources: z.array(z.string()),
  excludedSources: z.array(z.string()),
  maxPriceDeviationBps: z.number().int().min(1).max(1000),
  dryRunMode: z.boolean(),
});
