import { Logger, safeDivide, safeAdd, safeMultiply } from '../utils/index.js';
import type { ChainAdapter, QuoteResult, SwapResult, TradeSide } from '../types/index.js';
import { ExecutionCostCalculator, type ExecutionCostConfig } from './cost-calculator.js';
import { CapitalTierEvaluator, type SplitDecisionConfig, type CapitalTierConfig } from './capital-tier.js';

const logger = new Logger('SplitExecutor');

/**
 * Configuration for split execution
 */
export interface SplitExecutionConfig {
  // From cost calculator
  costConfig: ExecutionCostConfig;

  // From capital tier
  tierConfig: CapitalTierConfig;
  splitConfig: SplitDecisionConfig;

  // Timing
  delayBetweenChunksMs: number;
  maxChunkRetries: number;
  quoteRefreshBeforeEachChunk: boolean;

  // Abort conditions
  abortOnSlippageSpike: boolean;
  slippageSpikeThresholdBps: number;
  abortOnPriceMove: boolean;
  priceMoveAbortThresholdPct: number;
}

/**
 * Result of a single chunk execution
 */
export interface ChunkResult {
  chunkIndex: number;
  success: boolean;
  quote?: QuoteResult;
  swap?: SwapResult;
  executedBaseQty: number;
  executedQuoteQty: number;
  executedPrice: number;
  actualSlippageBps: number | null;
  feeNativeUsdc: number;
  error?: string;
  attemptedAt: Date;
  completedAt?: Date;
}

/**
 * Result of split execution
 */
export interface SplitExecutionResult {
  parentOrderId: string;
  side: TradeSide;
  totalIntendedSize: number;
  totalChunks: number;

  // Aggregated results
  completedChunks: number;
  abortedChunks: number;
  totalBaseExecuted: number;
  totalQuoteExecuted: number;
  weightedAvgPrice: number | null;
  totalFees: number;
  totalSlippageCost: number;

  // Status
  success: boolean;
  fullyExecuted: boolean;
  abortReason: string | null;

  // Individual chunks
  chunks: ChunkResult[];

  // Timing
  startedAt: Date;
  completedAt: Date;
  totalDurationMs: number;
}

/**
 * Sequential split executor for large trades
 *
 * Executes trades in sequential chunks to minimize slippage impact.
 * Each chunk is quoted and executed independently with abort conditions.
 */
export class SplitExecutor {
  private costCalculator: ExecutionCostCalculator;
  private tierEvaluator: CapitalTierEvaluator;

  constructor(private config: SplitExecutionConfig) {
    this.costCalculator = new ExecutionCostCalculator(config.costConfig);
    this.tierEvaluator = new CapitalTierEvaluator(config.tierConfig, config.splitConfig);
  }

  /**
   * Execute a trade, potentially split into chunks
   */
  async execute(
    adapter: ChainAdapter,
    side: TradeSide,
    totalAmountUsdc: number,
    portfolioValueUsdc: number,
    slippageBps: number,
    clientOrderId: string,
    allowedSources?: string[],
    excludedSources?: string[]
  ): Promise<SplitExecutionResult> {
    const startedAt = new Date();

    // Evaluate if we should split
    const tierResult = this.tierEvaluator.evaluate(portfolioValueUsdc, totalAmountUsdc);

    if (!tierResult.shouldSplit) {
      // Single-shot execution
      logger.info('Executing single-shot trade', {
        side,
        amount: totalAmountUsdc,
        reason: tierResult.reason,
      });

      return this.executeSingleShot(
        adapter,
        side,
        totalAmountUsdc,
        slippageBps,
        clientOrderId,
        startedAt,
        allowedSources,
        excludedSources
      );
    }

    // Calculate chunk count based on estimated slippage
    const initialQuote = await this.getQuote(
      adapter,
      side,
      totalAmountUsdc,
      slippageBps,
      allowedSources,
      excludedSources
    );

    const estimatedSlippagePerUsdc = initialQuote.priceImpactBps !== null
      ? safeDivide(initialQuote.priceImpactBps, totalAmountUsdc)
      : 0.1; // Default estimate

    const chunkCount = this.tierEvaluator.calculateChunkCount(
      totalAmountUsdc,
      estimatedSlippagePerUsdc
    );

    logger.info('Executing split trade', {
      side,
      totalAmount: totalAmountUsdc,
      chunks: chunkCount,
      tier: tierResult.tier,
      reason: tierResult.reason,
    });

    return this.executeSplit(
      adapter,
      side,
      totalAmountUsdc,
      chunkCount,
      slippageBps,
      clientOrderId,
      startedAt,
      initialQuote.price,
      allowedSources,
      excludedSources
    );
  }

  /**
   * Execute a single-shot trade
   */
  private async executeSingleShot(
    adapter: ChainAdapter,
    side: TradeSide,
    amountUsdc: number,
    slippageBps: number,
    clientOrderId: string,
    startedAt: Date,
    allowedSources?: string[],
    excludedSources?: string[]
  ): Promise<SplitExecutionResult> {
    const chunk = await this.executeChunk(
      adapter,
      side,
      amountUsdc,
      slippageBps,
      0,
      clientOrderId,
      allowedSources,
      excludedSources
    );

    const completedAt = new Date();

    return {
      parentOrderId: clientOrderId,
      side,
      totalIntendedSize: amountUsdc,
      totalChunks: 1,
      completedChunks: chunk.success ? 1 : 0,
      abortedChunks: chunk.success ? 0 : 1,
      totalBaseExecuted: chunk.executedBaseQty,
      totalQuoteExecuted: chunk.executedQuoteQty,
      weightedAvgPrice: chunk.executedPrice || null,
      totalFees: chunk.feeNativeUsdc,
      totalSlippageCost: this.calculateSlippageCost(chunk),
      success: chunk.success,
      fullyExecuted: chunk.success,
      abortReason: chunk.error || null,
      chunks: [chunk],
      startedAt,
      completedAt,
      totalDurationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  /**
   * Execute a split trade in sequential chunks
   */
  private async executeSplit(
    adapter: ChainAdapter,
    side: TradeSide,
    totalAmountUsdc: number,
    chunkCount: number,
    slippageBps: number,
    clientOrderId: string,
    startedAt: Date,
    initialPrice: number,
    allowedSources?: string[],
    excludedSources?: string[]
  ): Promise<SplitExecutionResult> {
    const chunkSize = totalAmountUsdc / chunkCount;
    const chunks: ChunkResult[] = [];

    let totalBaseExecuted = 0;
    let totalQuoteExecuted = 0;
    let totalFees = 0;
    let totalSlippageCost = 0;
    let abortReason: string | null = null;
    let lastPrice = initialPrice;

    for (let i = 0; i < chunkCount; i++) {
      // Check abort conditions before each chunk (except first)
      if (i > 0) {
        // Delay between chunks
        await this.delay(this.config.delayBetweenChunksMs);

        // Check price movement if enabled
        if (this.config.abortOnPriceMove) {
          const currentQuote = await this.getQuote(
            adapter,
            side,
            chunkSize,
            slippageBps,
            allowedSources,
            excludedSources
          );

          const priceMovePercent = Math.abs(currentQuote.price - initialPrice) / initialPrice * 100;

          if (priceMovePercent > this.config.priceMoveAbortThresholdPct) {
            abortReason = `Price moved ${priceMovePercent.toFixed(2)}% during split execution`;
            logger.warn('Aborting split execution due to price movement', {
              initialPrice,
              currentPrice: currentQuote.price,
              movePercent: priceMovePercent,
              threshold: this.config.priceMoveAbortThresholdPct,
            });
            break;
          }
        }
      }

      // Execute chunk
      const chunkOrderId = `${clientOrderId}-chunk-${i}`;
      const chunk = await this.executeChunk(
        adapter,
        side,
        chunkSize,
        slippageBps,
        i,
        chunkOrderId,
        allowedSources,
        excludedSources
      );

      chunks.push(chunk);

      if (chunk.success) {
        totalBaseExecuted = safeAdd(totalBaseExecuted, chunk.executedBaseQty);
        totalQuoteExecuted = safeAdd(totalQuoteExecuted, chunk.executedQuoteQty);
        totalFees = safeAdd(totalFees, chunk.feeNativeUsdc);
        totalSlippageCost = safeAdd(totalSlippageCost, this.calculateSlippageCost(chunk));
        lastPrice = chunk.executedPrice;

        // Check for slippage spike
        if (
          this.config.abortOnSlippageSpike &&
          chunk.actualSlippageBps !== null &&
          chunk.actualSlippageBps > this.config.slippageSpikeThresholdBps
        ) {
          abortReason = `Slippage spike: ${chunk.actualSlippageBps}bps exceeds threshold ${this.config.slippageSpikeThresholdBps}bps`;
          logger.warn('Aborting split execution due to slippage spike', {
            actualSlippage: chunk.actualSlippageBps,
            threshold: this.config.slippageSpikeThresholdBps,
          });
          break;
        }
      } else {
        // Chunk failed - decide whether to continue or abort
        if (i === 0) {
          // First chunk failed - abort entirely
          abortReason = `First chunk failed: ${chunk.error}`;
          break;
        }

        // Subsequent chunk failed - log and continue with remaining
        logger.warn('Chunk failed, continuing with remaining', {
          chunkIndex: i,
          error: chunk.error,
        });
      }
    }

    const completedAt = new Date();
    const completedChunks = chunks.filter(c => c.success).length;
    const abortedChunks = chunkCount - completedChunks;

    // Calculate weighted average price
    const weightedAvgPrice = totalBaseExecuted > 0
      ? safeDivide(totalQuoteExecuted, totalBaseExecuted)
      : null;

    return {
      parentOrderId: clientOrderId,
      side,
      totalIntendedSize: totalAmountUsdc,
      totalChunks: chunkCount,
      completedChunks,
      abortedChunks,
      totalBaseExecuted,
      totalQuoteExecuted,
      weightedAvgPrice,
      totalFees,
      totalSlippageCost,
      success: completedChunks > 0,
      fullyExecuted: completedChunks === chunkCount && abortReason === null,
      abortReason,
      chunks,
      startedAt,
      completedAt,
      totalDurationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  /**
   * Execute a single chunk
   */
  private async executeChunk(
    adapter: ChainAdapter,
    side: TradeSide,
    amountUsdc: number,
    slippageBps: number,
    chunkIndex: number,
    clientOrderId: string,
    allowedSources?: string[],
    excludedSources?: string[]
  ): Promise<ChunkResult> {
    const attemptedAt = new Date();

    try {
      // Get fresh quote if configured
      const quote = await this.getQuote(
        adapter,
        side,
        amountUsdc,
        slippageBps,
        allowedSources,
        excludedSources
      );

      // Validate execution cost
      const costResult = this.costCalculator.calculateExecutionCost(quote);
      if (!costResult.shouldExecute) {
        return {
          chunkIndex,
          success: false,
          quote,
          executedBaseQty: 0,
          executedQuoteQty: 0,
          executedPrice: 0,
          actualSlippageBps: null,
          feeNativeUsdc: 0,
          error: costResult.rejectionReason || 'Execution cost check failed',
          attemptedAt,
        };
      }

      // Execute swap
      const swapResult = await adapter.executeSwap({
        quote,
        clientOrderId,
      });

      if (!swapResult.success) {
        return {
          chunkIndex,
          success: false,
          quote,
          swap: swapResult,
          executedBaseQty: 0,
          executedQuoteQty: 0,
          executedPrice: 0,
          actualSlippageBps: null,
          feeNativeUsdc: 0,
          error: swapResult.error?.message || 'Swap execution failed',
          attemptedAt,
          completedAt: new Date(),
        };
      }

      return {
        chunkIndex,
        success: true,
        quote,
        swap: swapResult,
        executedBaseQty: side === 'BUY' ? swapResult.outputAmount : swapResult.inputAmount,
        executedQuoteQty: side === 'BUY' ? swapResult.inputAmount : swapResult.outputAmount,
        executedPrice: swapResult.executedPrice,
        actualSlippageBps: swapResult.actualSlippageBps,
        feeNativeUsdc: swapResult.feeNativeUsdc,
        attemptedAt,
        completedAt: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Chunk execution failed', { chunkIndex, error: errorMessage });

      return {
        chunkIndex,
        success: false,
        executedBaseQty: 0,
        executedQuoteQty: 0,
        executedPrice: 0,
        actualSlippageBps: null,
        feeNativeUsdc: 0,
        error: errorMessage,
        attemptedAt,
      };
    }
  }

  /**
   * Get a quote for a trade
   */
  private async getQuote(
    adapter: ChainAdapter,
    side: TradeSide,
    amountUsdc: number,
    slippageBps: number,
    allowedSources?: string[],
    excludedSources?: string[]
  ): Promise<QuoteResult> {
    return adapter.getQuote({
      side,
      amount: amountUsdc,
      amountIsBase: false, // Always quote in USDC
      slippageBps,
      allowedSources,
      excludedSources,
    });
  }

  /**
   * Calculate slippage cost from a chunk result
   */
  private calculateSlippageCost(chunk: ChunkResult): number {
    if (!chunk.quote || chunk.actualSlippageBps === null) {
      return 0;
    }

    // Slippage cost = (actual slippage - expected slippage) * trade size
    const expectedSlippageBps = chunk.quote.priceImpactBps || 0;
    const excessSlippageBps = Math.max(0, chunk.actualSlippageBps - expectedSlippageBps);
    return safeMultiply(chunk.executedQuoteQty, excessSlippageBps / 10000);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Default split execution configuration
 */
export const DEFAULT_SPLIT_EXECUTION_CONFIG: Partial<SplitExecutionConfig> = {
  delayBetweenChunksMs: 2000,
  maxChunkRetries: 2,
  quoteRefreshBeforeEachChunk: true,
  abortOnSlippageSpike: true,
  slippageSpikeThresholdBps: 200,
  abortOnPriceMove: true,
  priceMoveAbortThresholdPct: 2.0,
};
