import { Logger, safeDivide, safeMultiply, safeSubtract, safeAdd } from '../utils/index.js';
import type { QuoteResult } from '../types/index.js';

const logger = new Logger('ExecutionCostCalculator');

/**
 * Configuration for execution cost calculations
 */
export interface ExecutionCostConfig {
  estimatedDexFeePct: number;      // e.g., 0.05 for 0.05%
  priorityFeeImpactPct: number;    // e.g., 0.02 for 0.02%
  minimumNetEdgePct: number;       // e.g., 0.40 for 0.40%
  maxExecutionCostPct: number;     // e.g., 0.70 for 0.70%

  // Dynamic profit target tiers
  baseSellTargetPct: number;       // Base sell target from config
  sellTargetTier1Pct: number;      // When cost > 0.30%
  sellTargetTier2Pct: number;      // When cost > 0.50%
}

/**
 * Result of execution cost calculation
 */
export interface ExecutionCostResult {
  quotedSlippagePct: number;
  estimatedDexFeePct: number;
  priorityFeeImpactPct: number;
  totalExecutionCostPct: number;

  // Net edge calculation
  effectiveSellTargetPct: number;
  netEdgePct: number;

  // Decision
  shouldExecute: boolean;
  rejectionReason: string | null;
  rejectionCode: string | null;
}

/**
 * Calculates execution costs and determines if trade has positive net edge
 */
export class ExecutionCostCalculator {
  constructor(private config: ExecutionCostConfig) {}

  /**
   * Calculate total execution cost from a quote
   */
  calculateExecutionCost(quote: QuoteResult): ExecutionCostResult {
    // Extract slippage from quote (convert bps to percentage)
    const quotedSlippagePct = quote.priceImpactBps !== null
      ? quote.priceImpactBps / 100
      : 0;

    // Total execution cost
    const totalExecutionCostPct = safeAdd(
      safeAdd(quotedSlippagePct, this.config.estimatedDexFeePct),
      this.config.priorityFeeImpactPct
    );

    // Determine effective sell target based on execution cost tiers
    const effectiveSellTargetPct = this.getEffectiveSellTarget(totalExecutionCostPct);

    // Calculate net edge
    const netEdgePct = safeSubtract(effectiveSellTargetPct, totalExecutionCostPct);

    // Decision logic
    let shouldExecute = true;
    let rejectionReason: string | null = null;
    let rejectionCode: string | null = null;

    // Check if execution cost is too high (DO NOT TRADE threshold)
    if (totalExecutionCostPct > this.config.maxExecutionCostPct) {
      shouldExecute = false;
      rejectionReason = `Execution cost ${totalExecutionCostPct.toFixed(2)}% exceeds maximum ${this.config.maxExecutionCostPct.toFixed(2)}%`;
      rejectionCode = 'EXECUTION_COST_TOO_HIGH';
    }
    // Check minimum net edge requirement
    else if (netEdgePct < this.config.minimumNetEdgePct) {
      shouldExecute = false;
      rejectionReason = `Net edge ${netEdgePct.toFixed(2)}% below minimum ${this.config.minimumNetEdgePct.toFixed(2)}%`;
      rejectionCode = 'NET_EDGE_TOO_LOW';
    }

    const result: ExecutionCostResult = {
      quotedSlippagePct,
      estimatedDexFeePct: this.config.estimatedDexFeePct,
      priorityFeeImpactPct: this.config.priorityFeeImpactPct,
      totalExecutionCostPct,
      effectiveSellTargetPct,
      netEdgePct,
      shouldExecute,
      rejectionReason,
      rejectionCode,
    };

    logger.debug('Execution cost calculated', {
      quotedSlippagePct: quotedSlippagePct.toFixed(3),
      totalCost: totalExecutionCostPct.toFixed(3),
      effectiveTarget: effectiveSellTargetPct.toFixed(3),
      netEdge: netEdgePct.toFixed(3),
      shouldExecute,
    });

    return result;
  }

  /**
   * Get effective sell target based on execution cost tier
   */
  private getEffectiveSellTarget(executionCostPct: number): number {
    if (executionCostPct > 0.50) {
      return this.config.sellTargetTier2Pct;
    }
    if (executionCostPct > 0.30) {
      return this.config.sellTargetTier1Pct;
    }
    return this.config.baseSellTargetPct;
  }

  /**
   * Estimate execution cost for a given trade size (for split planning)
   */
  estimateCostForSize(
    tradeSize: number,
    priceImpactBpsPerUnit: number,
    baseAmount: number
  ): number {
    // Estimate price impact based on trade size
    // This is a rough estimate - real impact depends on liquidity depth
    const estimatedImpactBps = safeMultiply(priceImpactBpsPerUnit, safeDivide(tradeSize, baseAmount));
    const impactPct = estimatedImpactBps / 100;

    return safeAdd(
      safeAdd(impactPct, this.config.estimatedDexFeePct),
      this.config.priorityFeeImpactPct
    );
  }
}

/**
 * Format execution cost details for logging
 */
export function formatExecutionCostLog(result: ExecutionCostResult): string {
  const lines = [
    `Slippage: ${result.quotedSlippagePct.toFixed(3)}%`,
    `DEX Fee: ${result.estimatedDexFeePct.toFixed(3)}%`,
    `Priority Fee: ${result.priorityFeeImpactPct.toFixed(3)}%`,
    `Total Cost: ${result.totalExecutionCostPct.toFixed(3)}%`,
    `Sell Target: ${result.effectiveSellTargetPct.toFixed(3)}%`,
    `Net Edge: ${result.netEdgePct.toFixed(3)}%`,
    `Execute: ${result.shouldExecute ? 'YES' : 'NO'}`,
  ];

  if (result.rejectionReason) {
    lines.push(`Reason: ${result.rejectionReason}`);
  }

  return lines.join(' | ');
}
