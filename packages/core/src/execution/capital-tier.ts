import { Logger } from '../utils/index.js';

const logger = new Logger('CapitalTierEvaluator');

/**
 * Capital tier thresholds
 */
export interface CapitalTierConfig {
  tier1Usdc: number;  // Below this: single-shot only
  tier2Usdc: number;  // Below this: conditional split
  tier3Usdc: number;  // Above this: mandatory split for large trades
}

/**
 * Capital tier classification
 */
export type CapitalTier = 'SMALL' | 'MEDIUM' | 'LARGE' | 'WHALE';

/**
 * Execution mode based on capital and trade size
 */
export type ExecutionMode = 'SINGLE_SHOT' | 'CONDITIONAL_SPLIT' | 'MANDATORY_SPLIT';

/**
 * Result of capital tier evaluation
 */
export interface CapitalTierResult {
  tier: CapitalTier;
  portfolioValueUsdc: number;
  executionMode: ExecutionMode;
  maxSingleTradeUsdc: number;
  shouldSplit: boolean;
  reason: string;
}

/**
 * Configuration for split execution decisions
 */
export interface SplitDecisionConfig {
  maxSingleTradeSlippagePct: number;
  targetChunkSlippagePct: number;
  minChunkSizeUsdc: number;
  maxChunksPerSplit: number;
}

/**
 * Evaluates capital tier and determines execution mode
 */
export class CapitalTierEvaluator {
  constructor(
    private tierConfig: CapitalTierConfig,
    private splitConfig: SplitDecisionConfig
  ) {}

  /**
   * Evaluate capital tier and execution mode for a given portfolio
   */
  evaluate(portfolioValueUsdc: number, intendedTradeSizeUsdc: number): CapitalTierResult {
    const tier = this.classifyTier(portfolioValueUsdc);
    const executionMode = this.determineExecutionMode(tier, intendedTradeSizeUsdc);
    const maxSingleTradeUsdc = this.getMaxSingleTradeSize(tier, portfolioValueUsdc);
    const shouldSplit = this.shouldSplitTrade(tier, intendedTradeSizeUsdc, portfolioValueUsdc);

    const result: CapitalTierResult = {
      tier,
      portfolioValueUsdc,
      executionMode,
      maxSingleTradeUsdc,
      shouldSplit,
      reason: this.buildReason(tier, executionMode, shouldSplit, intendedTradeSizeUsdc),
    };

    logger.debug('Capital tier evaluated', {
      tier,
      portfolioValue: portfolioValueUsdc.toFixed(2),
      intendedSize: intendedTradeSizeUsdc.toFixed(2),
      executionMode,
      shouldSplit,
    });

    return result;
  }

  /**
   * Classify portfolio into capital tier
   */
  private classifyTier(portfolioValueUsdc: number): CapitalTier {
    if (portfolioValueUsdc < this.tierConfig.tier1Usdc) {
      return 'SMALL';
    }
    if (portfolioValueUsdc < this.tierConfig.tier2Usdc) {
      return 'MEDIUM';
    }
    if (portfolioValueUsdc < this.tierConfig.tier3Usdc) {
      return 'LARGE';
    }
    return 'WHALE';
  }

  /**
   * Determine execution mode based on tier and trade size
   */
  private determineExecutionMode(tier: CapitalTier, tradeSizeUsdc: number): ExecutionMode {
    switch (tier) {
      case 'SMALL':
        // Small accounts always use single-shot to minimize fees
        return 'SINGLE_SHOT';

      case 'MEDIUM':
        // Medium accounts use conditional split based on trade size
        if (tradeSizeUsdc > this.splitConfig.minChunkSizeUsdc * 2) {
          return 'CONDITIONAL_SPLIT';
        }
        return 'SINGLE_SHOT';

      case 'LARGE':
      case 'WHALE':
        // Large accounts should split large trades
        if (tradeSizeUsdc > this.splitConfig.minChunkSizeUsdc * 3) {
          return 'MANDATORY_SPLIT';
        }
        return 'CONDITIONAL_SPLIT';
    }
  }

  /**
   * Get maximum single trade size based on tier
   */
  private getMaxSingleTradeSize(tier: CapitalTier, portfolioValueUsdc: number): number {
    switch (tier) {
      case 'SMALL':
        // Small accounts: trade up to 20% of portfolio in single shot
        return Math.min(portfolioValueUsdc * 0.20, this.tierConfig.tier1Usdc * 0.5);

      case 'MEDIUM':
        // Medium accounts: trade up to 10% of portfolio in single shot
        return Math.min(portfolioValueUsdc * 0.10, 500);

      case 'LARGE':
        // Large accounts: trade up to 5% of portfolio in single shot
        return Math.min(portfolioValueUsdc * 0.05, 1000);

      case 'WHALE':
        // Whale accounts: trade up to 2% of portfolio in single shot
        return Math.min(portfolioValueUsdc * 0.02, 2000);
    }
  }

  /**
   * Determine if trade should be split based on tier and size
   */
  private shouldSplitTrade(
    tier: CapitalTier,
    tradeSizeUsdc: number,
    portfolioValueUsdc: number
  ): boolean {
    // Never split if below minimum chunk size
    if (tradeSizeUsdc < this.splitConfig.minChunkSizeUsdc * 2) {
      return false;
    }

    const maxSingleSize = this.getMaxSingleTradeSize(tier, portfolioValueUsdc);
    return tradeSizeUsdc > maxSingleSize;
  }

  /**
   * Build human-readable reason for the decision
   */
  private buildReason(
    tier: CapitalTier,
    mode: ExecutionMode,
    shouldSplit: boolean,
    tradeSizeUsdc: number
  ): string {
    if (!shouldSplit) {
      return `${tier} tier: Single-shot execution for $${tradeSizeUsdc.toFixed(2)} trade`;
    }

    switch (mode) {
      case 'CONDITIONAL_SPLIT':
        return `${tier} tier: Trade size warrants split execution to minimize slippage`;
      case 'MANDATORY_SPLIT':
        return `${tier} tier: Large trade requires mandatory split execution`;
      default:
        return `${tier} tier: ${mode} execution`;
    }
  }

  /**
   * Calculate optimal chunk count for a trade
   */
  calculateChunkCount(tradeSizeUsdc: number, estimatedSlippagePerUsdcBps: number): number {
    // Target slippage per chunk
    const targetSlippageBps = this.splitConfig.targetChunkSlippagePct * 100;

    // Estimate optimal chunk size based on slippage
    const optimalChunkSize = estimatedSlippagePerUsdcBps > 0
      ? targetSlippageBps / estimatedSlippagePerUsdcBps
      : tradeSizeUsdc;

    // Calculate number of chunks needed
    let chunks = Math.ceil(tradeSizeUsdc / optimalChunkSize);

    // Apply bounds
    chunks = Math.max(1, Math.min(chunks, this.splitConfig.maxChunksPerSplit));

    // Ensure each chunk meets minimum size
    const chunkSize = tradeSizeUsdc / chunks;
    if (chunkSize < this.splitConfig.minChunkSizeUsdc && chunks > 1) {
      chunks = Math.floor(tradeSizeUsdc / this.splitConfig.minChunkSizeUsdc);
      chunks = Math.max(1, chunks);
    }

    return chunks;
  }
}

/**
 * Default capital tier configuration
 */
export const DEFAULT_CAPITAL_TIER_CONFIG: CapitalTierConfig = {
  tier1Usdc: 5000,
  tier2Usdc: 20000,
  tier3Usdc: 50000,
};

/**
 * Default split decision configuration
 */
export const DEFAULT_SPLIT_CONFIG: SplitDecisionConfig = {
  maxSingleTradeSlippagePct: 0.25,
  targetChunkSlippagePct: 0.15,
  minChunkSizeUsdc: 50,
  maxChunksPerSplit: 10,
};
