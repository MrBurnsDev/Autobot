import { Logger, safeDivide, safeMultiply, safeSubtract, safeAdd } from '../utils/index.js';
import type { QuoteResult } from '../types/index.js';
import { ExecutionCostCalculator, type ExecutionCostConfig, type ExecutionCostResult } from './cost-calculator.js';
import type { MarketRegime } from './regime-classifier.js';
import type { CapitalTier } from './capital-tier.js';

const logger = new Logger('ScaleOutManager');

/**
 * Exit mode configuration
 */
export type ExitMode = 'FULL_EXIT' | 'SCALE_OUT';

/**
 * Extension state for scale-out mode
 */
export type ExtensionState = 'NONE' | 'ACTIVE' | 'TRAILING';

/**
 * Scale-out configuration
 */
export interface ScaleOutConfig {
  exitMode: ExitMode;
  primaryPct: number;           // e.g., 0.65 = 65%
  secondaryPct: number;         // e.g., 0.35 = 35%
  secondaryTargetPct: number;   // e.g., 1.9%
  trailingEnabled: boolean;
  minExtensionPct: number;      // e.g., 0.3%
  minDollarProfit: number;      // e.g., $2
  trailingStopPct: number;      // e.g., 1.0%
  allowWhale: boolean;
}

/**
 * Extension state tracking
 */
export interface ExtensionStateData {
  state: ExtensionState;
  baseQty: number;
  baseCost: number;
  entryPrice: number | null;
  peakPrice: number | null;
  startedAt: Date | null;
  primaryPnl: number;
}

/**
 * Scale-out decision result
 */
export interface ScaleOutDecision {
  action: 'FULL_EXIT' | 'PRIMARY_EXIT' | 'EXTENSION_EXIT' | 'HOLD_EXTENSION' | 'ABORT_SCALE_OUT';
  sellQty: number;              // Base amount to sell
  reason: string;
  expectedPnl: number;
  isExtensionExit: boolean;
  shouldStartExtension: boolean;
  extensionQty: number;         // Remaining qty for extension
  extensionCost: number;        // Cost basis for extension portion
}

/**
 * Extension exit decision
 */
export interface ExtensionExitDecision {
  shouldExit: boolean;
  reason: string;
  exitType: 'TARGET_HIT' | 'TRAILING_STOP' | 'PULLBACK_PROTECTION' | 'REGIME_FORCED' | 'HOLD';
  expectedPnl: number;
}

/**
 * Default scale-out configuration
 */
export const DEFAULT_SCALE_OUT_CONFIG: ScaleOutConfig = {
  exitMode: 'FULL_EXIT',
  primaryPct: 0.65,
  secondaryPct: 0.35,
  secondaryTargetPct: 1.9,
  trailingEnabled: false,
  minExtensionPct: 0.3,
  minDollarProfit: 2.0,
  trailingStopPct: 1.0,
  allowWhale: false,
};

/**
 * Scale-out exit manager
 *
 * Manages the scale-out exit strategy while preserving all existing safety systems.
 * This is an OPTIONAL feature that defaults to FULL_EXIT behavior.
 */
export class ScaleOutManager {
  private costCalculator: ExecutionCostCalculator;

  constructor(
    private config: ScaleOutConfig,
    private costConfig: ExecutionCostConfig
  ) {
    this.costCalculator = new ExecutionCostCalculator(costConfig);

    // Validate config
    if (config.primaryPct + config.secondaryPct !== 1.0) {
      logger.warn('Scale-out percentages do not sum to 100%, adjusting secondary', {
        primary: config.primaryPct,
        secondary: config.secondaryPct,
      });
      this.config.secondaryPct = 1.0 - config.primaryPct;
    }
  }

  /**
   * Determine if scale-out is allowed given current context
   */
  isScaleOutAllowed(
    regime: MarketRegime,
    capitalTier: CapitalTier
  ): { allowed: boolean; reason: string } {
    // FULL_EXIT mode - always use full exit
    if (this.config.exitMode === 'FULL_EXIT') {
      return { allowed: false, reason: 'Exit mode is FULL_EXIT' };
    }

    // CHAOS regime - immediately exit, no scale-out
    if (regime === 'CHAOS') {
      return { allowed: false, reason: 'CHAOS regime detected, scale-out disabled' };
    }

    // WHALE tier requires explicit enable
    if (capitalTier === 'WHALE' && !this.config.allowWhale) {
      return { allowed: false, reason: 'WHALE tier requires explicit scaleOutAllowWhale=true' };
    }

    return { allowed: true, reason: 'Scale-out allowed' };
  }

  /**
   * Evaluate sell action and decide between full exit or scale-out
   */
  evaluateSellDecision(
    totalBaseQty: number,
    totalBaseCost: number,
    currentPrice: number,
    lastBuyPrice: number,
    quote: QuoteResult,
    regime: MarketRegime,
    capitalTier: CapitalTier,
    extensionState: ExtensionStateData
  ): ScaleOutDecision {
    // Check if scale-out is allowed
    const scaleOutCheck = this.isScaleOutAllowed(regime, capitalTier);

    // If in extension state, handle differently
    if (extensionState.state !== 'NONE') {
      return this.evaluateExtensionExit(
        extensionState,
        currentPrice,
        quote,
        regime
      );
    }

    // Not in extension - this is a fresh sell decision
    if (!scaleOutCheck.allowed) {
      // Use full exit
      return this.buildFullExitDecision(totalBaseQty, totalBaseCost, currentPrice, lastBuyPrice);
    }

    // Calculate execution cost
    const costResult = this.costCalculator.calculateExecutionCost(quote);

    // Calculate expected profit for primary exit
    const primaryQty = safeMultiply(totalBaseQty, this.config.primaryPct);
    const primaryCost = safeMultiply(totalBaseCost, this.config.primaryPct);
    const primaryProceeds = safeMultiply(primaryQty, currentPrice);
    const primaryPnl = safeSubtract(primaryProceeds, primaryCost);

    // Check if primary exit meets minimum profit threshold
    const primaryPnlAfterFees = safeSubtract(primaryPnl, safeMultiply(primaryProceeds, costResult.totalExecutionCostPct / 100));

    if (primaryPnlAfterFees < this.config.minDollarProfit) {
      logger.info('Scale-out primary profit too low, using full exit', {
        primaryPnl: primaryPnlAfterFees,
        minRequired: this.config.minDollarProfit,
      });
      return this.buildFullExitDecision(totalBaseQty, totalBaseCost, currentPrice, lastBuyPrice);
    }

    // Check if secondary extension has enough edge potential
    const secondaryQty = safeMultiply(totalBaseQty, this.config.secondaryPct);
    const secondaryCost = safeMultiply(totalBaseCost, this.config.secondaryPct);
    const secondaryTargetPrice = safeMultiply(currentPrice, 1 + this.config.secondaryTargetPct / 100);
    const potentialSecondaryPnl = safeSubtract(safeMultiply(secondaryQty, secondaryTargetPrice), secondaryCost);

    // Estimate secondary execution cost at target
    const estimatedSecondaryFees = safeMultiply(safeMultiply(secondaryQty, secondaryTargetPrice), costResult.totalExecutionCostPct / 100);
    const netSecondaryPotential = safeSubtract(potentialSecondaryPnl, estimatedSecondaryFees);

    if (netSecondaryPotential < this.config.minDollarProfit) {
      logger.info('Scale-out secondary potential too low, using full exit', {
        potentialPnl: netSecondaryPotential,
        minRequired: this.config.minDollarProfit,
      });
      return this.buildFullExitDecision(totalBaseQty, totalBaseCost, currentPrice, lastBuyPrice);
    }

    // Scale-out approved
    logger.info('Scale-out approved', {
      primaryQty,
      primaryPnl: primaryPnlAfterFees,
      secondaryQty,
      potentialSecondaryPnl: netSecondaryPotential,
    });

    return {
      action: 'PRIMARY_EXIT',
      sellQty: primaryQty,
      reason: `Scale-out primary exit: ${(this.config.primaryPct * 100).toFixed(0)}% at ${currentPrice.toFixed(4)}`,
      expectedPnl: primaryPnlAfterFees,
      isExtensionExit: false,
      shouldStartExtension: true,
      extensionQty: secondaryQty,
      extensionCost: secondaryCost,
    };
  }

  /**
   * Evaluate whether to exit an active extension
   */
  private evaluateExtensionExit(
    extensionState: ExtensionStateData,
    currentPrice: number,
    quote: QuoteResult,
    regime: MarketRegime
  ): ScaleOutDecision {
    const { baseQty, baseCost, entryPrice, peakPrice } = extensionState;

    if (entryPrice === null) {
      logger.error('Extension state invalid: no entry price');
      return this.buildExtensionAbort(baseQty, baseCost, currentPrice, 'Invalid extension state');
    }

    // CHAOS regime - exit immediately
    if (regime === 'CHAOS') {
      logger.warn('CHAOS regime - forcing extension exit');
      return this.buildExtensionAbort(baseQty, baseCost, currentPrice, 'CHAOS regime forced exit');
    }

    // Calculate current PnL
    const currentProceeds = safeMultiply(baseQty, currentPrice);
    const currentPnl = safeSubtract(currentProceeds, baseCost);

    // Check execution cost
    const costResult = this.costCalculator.calculateExecutionCost(quote);
    const pnlAfterFees = safeSubtract(currentPnl, safeMultiply(currentProceeds, costResult.totalExecutionCostPct / 100));

    // Check secondary target
    const secondaryTargetPrice = safeMultiply(entryPrice, 1 + this.config.secondaryTargetPct / 100);
    if (currentPrice >= secondaryTargetPrice) {
      logger.info('Extension hit secondary target', {
        currentPrice,
        targetPrice: secondaryTargetPrice,
        pnl: pnlAfterFees,
      });
      return {
        action: 'EXTENSION_EXIT',
        sellQty: baseQty,
        reason: `Extension target hit: ${currentPrice.toFixed(4)} >= ${secondaryTargetPrice.toFixed(4)}`,
        expectedPnl: pnlAfterFees,
        isExtensionExit: true,
        shouldStartExtension: false,
        extensionQty: 0,
        extensionCost: 0,
      };
    }

    // Check trailing stop if enabled
    if (this.config.trailingEnabled && peakPrice !== null) {
      const trailingStopPrice = safeMultiply(peakPrice, 1 - this.config.trailingStopPct / 100);

      // Only activate trailing if we've moved enough from entry
      const extensionGain = safeDivide(safeSubtract(peakPrice, entryPrice), entryPrice) * 100;

      if (extensionGain >= this.config.minExtensionPct && currentPrice <= trailingStopPrice) {
        logger.info('Extension trailing stop triggered', {
          currentPrice,
          peakPrice,
          trailingStop: trailingStopPrice,
          pnl: pnlAfterFees,
        });
        return {
          action: 'EXTENSION_EXIT',
          sellQty: baseQty,
          reason: `Trailing stop: ${currentPrice.toFixed(4)} <= ${trailingStopPrice.toFixed(4)} (peak: ${peakPrice.toFixed(4)})`,
          expectedPnl: pnlAfterFees,
          isExtensionExit: true,
          shouldStartExtension: false,
          extensionQty: 0,
          extensionCost: 0,
        };
      }
    }

    // Check pullback protection - don't let extension turn into a loss
    const pullbackThreshold = safeMultiply(entryPrice, 1 + this.costConfig.minimumNetEdgePct / 100);
    if (currentPrice < pullbackThreshold && pnlAfterFees < this.config.minDollarProfit) {
      logger.warn('Extension pullback protection triggered', {
        currentPrice,
        pullbackThreshold,
        pnl: pnlAfterFees,
      });
      return {
        action: 'EXTENSION_EXIT',
        sellQty: baseQty,
        reason: `Pullback protection: ${currentPrice.toFixed(4)} near entry with insufficient profit`,
        expectedPnl: pnlAfterFees,
        isExtensionExit: true,
        shouldStartExtension: false,
        extensionQty: 0,
        extensionCost: 0,
      };
    }

    // Hold extension
    return {
      action: 'HOLD_EXTENSION',
      sellQty: 0,
      reason: `Holding extension: price ${currentPrice.toFixed(4)}, target ${secondaryTargetPrice.toFixed(4)}`,
      expectedPnl: pnlAfterFees,
      isExtensionExit: false,
      shouldStartExtension: false,
      extensionQty: baseQty,
      extensionCost: baseCost,
    };
  }

  /**
   * Build a full exit decision
   */
  private buildFullExitDecision(
    totalBaseQty: number,
    totalBaseCost: number,
    currentPrice: number,
    lastBuyPrice: number
  ): ScaleOutDecision {
    const proceeds = safeMultiply(totalBaseQty, currentPrice);
    const pnl = safeSubtract(proceeds, totalBaseCost);

    return {
      action: 'FULL_EXIT',
      sellQty: totalBaseQty,
      reason: `Full exit at ${currentPrice.toFixed(4)} (from buy at ${lastBuyPrice.toFixed(4)})`,
      expectedPnl: pnl,
      isExtensionExit: false,
      shouldStartExtension: false,
      extensionQty: 0,
      extensionCost: 0,
    };
  }

  /**
   * Build an extension abort decision (forced exit)
   */
  private buildExtensionAbort(
    baseQty: number,
    baseCost: number,
    currentPrice: number,
    reason: string
  ): ScaleOutDecision {
    const proceeds = safeMultiply(baseQty, currentPrice);
    const pnl = safeSubtract(proceeds, baseCost);

    return {
      action: 'ABORT_SCALE_OUT',
      sellQty: baseQty,
      reason: `Extension aborted: ${reason}`,
      expectedPnl: pnl,
      isExtensionExit: true,
      shouldStartExtension: false,
      extensionQty: 0,
      extensionCost: 0,
    };
  }

  /**
   * Update peak price for trailing stop
   */
  updatePeakPrice(currentPeak: number | null, currentPrice: number): number {
    if (currentPeak === null) {
      return currentPrice;
    }
    return Math.max(currentPeak, currentPrice);
  }

  /**
   * Calculate PnL attribution for scale-out
   */
  calculateScaleOutPnL(
    primaryQty: number,
    primaryProceeds: number,
    primaryCost: number,
    secondaryQty: number,
    secondaryProceeds: number,
    secondaryCost: number,
    totalFees: number
  ): { primaryPnl: number; secondaryPnl: number; totalPnl: number } {
    // Allocate fees proportionally by proceeds
    const totalProceeds = safeAdd(primaryProceeds, secondaryProceeds);
    const primaryFeeShare = totalProceeds > 0
      ? safeMultiply(totalFees, safeDivide(primaryProceeds, totalProceeds))
      : 0;
    const secondaryFeeShare = safeSubtract(totalFees, primaryFeeShare);

    const primaryPnl = safeSubtract(safeSubtract(primaryProceeds, primaryCost), primaryFeeShare);
    const secondaryPnl = safeSubtract(safeSubtract(secondaryProceeds, secondaryCost), secondaryFeeShare);
    const totalPnl = safeAdd(primaryPnl, secondaryPnl);

    return { primaryPnl, secondaryPnl, totalPnl };
  }
}

/**
 * Format scale-out decision for logging
 */
export function formatScaleOutLog(decision: ScaleOutDecision): string {
  return `${decision.action}: ${decision.reason} | Qty: ${decision.sellQty.toFixed(4)} | ExpPnL: $${decision.expectedPnl.toFixed(2)}`;
}
