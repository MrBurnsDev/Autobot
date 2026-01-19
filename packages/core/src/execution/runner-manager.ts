import { Logger, safeDivide, safeMultiply, safeSubtract, safeAdd } from '../utils/index.js';
import { ExecutionCostCalculator, type ExecutionCostConfig, type ExecutionCostResult } from './cost-calculator.js';

const logger = new Logger('RunnerManager');

/**
 * Runner mode for exit strategy
 */
export type RunnerMode = 'LADDER' | 'TRAILING';

/**
 * Runner state
 */
export type RunnerState = 'NONE' | 'ACTIVE';

/**
 * Runner configuration
 */
export interface RunnerConfig {
  enabled: boolean;
  runnerPct: number;                 // e.g., 20 = 20% of position
  mode: RunnerMode;
  // Ladder mode config
  ladderTargets: number[];           // Target percentages above entry (e.g., [2.5, 4.0])
  ladderPercents: number[];          // Percent of runner to sell at each target (e.g., [50, 50])
  // Trailing mode config
  trailActivatePct: number;          // % above entry to start trailing (e.g., 1.8)
  trailStopPct: number;              // % below peak to exit (e.g., 0.7)
  minDollarProfit: number;           // Minimum profit to exit runner
}

/**
 * Runner state data (persisted)
 */
export interface RunnerStateData {
  state: RunnerState;
  qty: number;                       // Quantity held in runner leg
  costBasis: number;                 // Total cost for runner portion (for PnL)
  entryPrice: number | null;         // Price at which runner was created
  peakPrice: number | null;          // Peak price since active (for trailing)
  startedAt: Date | null;
  ladderStep: number;                // Current ladder step (0 = none completed)
}

/**
 * Runner decision result
 */
export interface RunnerDecision {
  action: 'NONE' | 'CREATE_RUNNER' | 'SELL_LADDER_STEP' | 'SELL_TRAILING_EXIT' | 'SELL_MIN_PROFIT' | 'BLOCKED_COST' | 'BLOCKED_PROFIT';
  sellQty: number;
  reason: string;
  expectedPnl: number;
  netEdgePct: number;
  executionCostPct: number;
  // For CREATE_RUNNER action
  newRunnerQty?: number;
  newRunnerCostBasis?: number;
  newRunnerEntryPrice?: number;
}

/**
 * Context for runner decisions
 */
export interface RunnerContext {
  executablePrice: number;
  executionCost: ExecutionCostResult;
  totalPositionQty: number;
  totalPositionCost: number;
  lastBuyPrice: number;
}

/**
 * Default runner configuration
 */
export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: false,
  runnerPct: 20,
  mode: 'TRAILING',
  ladderTargets: [],
  ladderPercents: [],
  trailActivatePct: 1.8,
  trailStopPct: 0.7,
  minDollarProfit: 0,
};

/**
 * Format runner decision for logging
 */
export function formatRunnerLog(
  instanceId: string,
  state: RunnerStateData,
  config: RunnerConfig,
  executablePrice: number,
  decision: RunnerDecision
): string {
  const parts = [
    `[${decision.action}]`,
    `Runner ${state.state}`,
    `mode=${config.mode}`,
    `qty=${state.qty.toFixed(4)}`,
    `entry=${state.entryPrice?.toFixed(4) ?? 'N/A'}`,
    `peak=${state.peakPrice?.toFixed(4) ?? 'N/A'}`,
    `price=${executablePrice.toFixed(4)}`,
    `netEdge=${decision.netEdgePct.toFixed(2)}%`,
    `cost=${decision.executionCostPct.toFixed(2)}%`,
  ];

  if (decision.action !== 'NONE') {
    parts.push(`sellQty=${decision.sellQty.toFixed(4)}`);
    parts.push(`pnl=$${decision.expectedPnl.toFixed(2)}`);
  }

  parts.push(`reason="${decision.reason}"`);

  return parts.join(' | ');
}

/**
 * Runner Manager
 *
 * Manages the two-leg position model where CORE trades frequently
 * and RUNNER captures occasional larger moves without blocking CORE.
 *
 * Key invariants:
 * - RUNNER qty is SEPARATE from CORE qty
 * - RUNNER never participates in CORE rebuy or CORE sell sizing
 * - RUNNER has its own exit lifecycle (ladder or trailing)
 * - Profit-only: RUNNER exits must realize positive PnL vs entry price
 */
export class RunnerManager {
  private costCalculator: ExecutionCostCalculator;

  constructor(
    private config: RunnerConfig,
    private costConfig: ExecutionCostConfig
  ) {
    this.costCalculator = new ExecutionCostCalculator(costConfig);

    // Validate ladder config
    if (config.mode === 'LADDER' && config.enabled) {
      if (config.ladderTargets.length !== config.ladderPercents.length) {
        logger.warn('Ladder targets and percents array length mismatch', {
          targets: config.ladderTargets.length,
          percents: config.ladderPercents.length,
        });
      }
      const sum = config.ladderPercents.reduce((a, b) => a + b, 0);
      if (config.ladderPercents.length > 0 && Math.abs(sum - 100) > 0.01) {
        logger.warn('Ladder percents do not sum to 100', { sum });
      }
    }
  }

  /**
   * Check if runner should be created after a CORE sell
   * Called when primary sell (e.g., 80%) executes
   */
  shouldCreateRunner(
    remainingQty: number,
    remainingCost: number,
    coreExitPrice: number
  ): RunnerDecision {
    if (!this.config.enabled) {
      return {
        action: 'NONE',
        sellQty: 0,
        reason: 'Runner not enabled',
        expectedPnl: 0,
        netEdgePct: 0,
        executionCostPct: 0,
      };
    }

    if (remainingQty <= 0) {
      return {
        action: 'NONE',
        sellQty: 0,
        reason: 'No remaining quantity for runner',
        expectedPnl: 0,
        netEdgePct: 0,
        executionCostPct: 0,
      };
    }

    const runnerCostBasis = remainingCost;
    const runnerEntryPrice = coreExitPrice; // Use CORE exit price as runner entry

    logger.info('Creating runner leg', {
      runnerQty: remainingQty,
      runnerCostBasis,
      runnerEntryPrice,
      mode: this.config.mode,
    });

    return {
      action: 'CREATE_RUNNER',
      sellQty: 0,
      reason: `Runner created with ${this.config.runnerPct}% of position`,
      expectedPnl: 0,
      netEdgePct: 0,
      executionCostPct: 0,
      newRunnerQty: remainingQty,
      newRunnerCostBasis: runnerCostBasis,
      newRunnerEntryPrice: runnerEntryPrice,
    };
  }

  /**
   * Evaluate runner leg for potential exit
   * Called every trading loop iteration when runner is ACTIVE
   */
  evaluateRunnerExit(
    state: RunnerStateData,
    executablePrice: number,
    executionCost: ExecutionCostResult
  ): RunnerDecision {
    if (state.state !== 'ACTIVE' || state.qty <= 0 || state.entryPrice === null) {
      return {
        action: 'NONE',
        sellQty: 0,
        reason: 'No active runner',
        expectedPnl: 0,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    // Calculate current profit metrics
    const entryPrice = state.entryPrice;
    const priceGainPct = safeDivide(safeSubtract(executablePrice, entryPrice), entryPrice) * 100;
    const grossProfit = safeMultiply(state.qty, safeSubtract(executablePrice, safeDivide(state.costBasis, state.qty)));
    const costBasisPerUnit = safeDivide(state.costBasis, state.qty);
    const netProfit = grossProfit - safeMultiply(grossProfit, executionCost.totalExecutionCostPct / 100);

    // Check profit-only invariant
    if (grossProfit < 0) {
      return {
        action: 'BLOCKED_PROFIT',
        sellQty: 0,
        reason: `Runner exit would realize loss ($${grossProfit.toFixed(2)})`,
        expectedPnl: grossProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    // Check minimum dollar profit if configured
    if (this.config.minDollarProfit > 0 && netProfit < this.config.minDollarProfit) {
      return {
        action: 'NONE',
        sellQty: 0,
        reason: `Net profit $${netProfit.toFixed(2)} below min $${this.config.minDollarProfit}`,
        expectedPnl: netProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    // Check execution cost gating
    if (executionCost.netEdgePct < 0) {
      return {
        action: 'BLOCKED_COST',
        sellQty: 0,
        reason: `Net edge ${executionCost.netEdgePct.toFixed(2)}% negative, holding`,
        expectedPnl: netProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    // Evaluate based on mode
    if (this.config.mode === 'LADDER') {
      return this.evaluateLadderExit(state, executablePrice, priceGainPct, netProfit, executionCost);
    } else {
      return this.evaluateTrailingExit(state, executablePrice, priceGainPct, netProfit, executionCost);
    }
  }

  /**
   * Evaluate ladder mode exit
   */
  private evaluateLadderExit(
    state: RunnerStateData,
    executablePrice: number,
    priceGainPct: number,
    netProfit: number,
    executionCost: ExecutionCostResult
  ): RunnerDecision {
    const targets = this.config.ladderTargets;
    const percents = this.config.ladderPercents;

    if (targets.length === 0) {
      // No ladder configured, fall back to single exit at trailActivatePct
      if (priceGainPct >= this.config.trailActivatePct) {
        return {
          action: 'SELL_LADDER_STEP',
          sellQty: state.qty,
          reason: `Ladder fallback: price +${priceGainPct.toFixed(2)}% >= ${this.config.trailActivatePct}%`,
          expectedPnl: netProfit,
          netEdgePct: executionCost.netEdgePct,
          executionCostPct: executionCost.totalExecutionCostPct,
        };
      }
      return {
        action: 'NONE',
        sellQty: 0,
        reason: `Price +${priceGainPct.toFixed(2)}% below ladder target ${this.config.trailActivatePct}%`,
        expectedPnl: netProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    // Check if current step target is hit
    const currentStep = state.ladderStep;
    if (currentStep >= targets.length) {
      // All ladder steps completed
      return {
        action: 'NONE',
        sellQty: 0,
        reason: 'All ladder steps completed',
        expectedPnl: 0,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    const targetPct = targets[currentStep] ?? 999; // Default to very high target if undefined
    const stepPercent = percents[currentStep] ?? 100; // Default to 100% if undefined
    if (priceGainPct >= targetPct) {
      // Target hit! Calculate qty for this step
      const originalRunnerQty = safeDivide(state.qty, (100 - percents.slice(0, currentStep).reduce((a, b) => a + b, 0)) / 100);
      const sellQty = safeMultiply(originalRunnerQty, stepPercent / 100);
      const stepProfit = safeMultiply(netProfit, sellQty / state.qty);

      return {
        action: 'SELL_LADDER_STEP',
        sellQty: Math.min(sellQty, state.qty), // Don't exceed available qty
        reason: `Ladder step ${currentStep + 1}/${targets.length}: price +${priceGainPct.toFixed(2)}% >= ${targetPct}%, selling ${stepPercent}%`,
        expectedPnl: stepProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    return {
      action: 'NONE',
      sellQty: 0,
      reason: `Price +${priceGainPct.toFixed(2)}% below ladder step ${currentStep + 1} target ${targetPct}%`,
      expectedPnl: netProfit,
      netEdgePct: executionCost.netEdgePct,
      executionCostPct: executionCost.totalExecutionCostPct,
    };
  }

  /**
   * Evaluate trailing mode exit
   */
  private evaluateTrailingExit(
    state: RunnerStateData,
    executablePrice: number,
    priceGainPct: number,
    netProfit: number,
    executionCost: ExecutionCostResult
  ): RunnerDecision {
    const entryPrice = state.entryPrice!;
    const peakPrice = state.peakPrice ?? executablePrice;

    // Calculate pullback from peak
    const pullbackFromPeakPct = safeDivide(safeSubtract(peakPrice, executablePrice), peakPrice) * 100;

    // Check if trailing is activated (price above activation threshold)
    const trailingActivated = priceGainPct >= this.config.trailActivatePct;

    if (trailingActivated) {
      // Check if pullback exceeds stop threshold
      if (pullbackFromPeakPct >= this.config.trailStopPct) {
        return {
          action: 'SELL_TRAILING_EXIT',
          sellQty: state.qty,
          reason: `Trailing stop: pullback ${pullbackFromPeakPct.toFixed(2)}% >= ${this.config.trailStopPct}% from peak $${peakPrice.toFixed(4)}`,
          expectedPnl: netProfit,
          netEdgePct: executionCost.netEdgePct,
          executionCostPct: executionCost.totalExecutionCostPct,
        };
      }

      return {
        action: 'NONE',
        sellQty: 0,
        reason: `Trailing active: gain +${priceGainPct.toFixed(2)}%, pullback ${pullbackFromPeakPct.toFixed(2)}% < stop ${this.config.trailStopPct}%`,
        expectedPnl: netProfit,
        netEdgePct: executionCost.netEdgePct,
        executionCostPct: executionCost.totalExecutionCostPct,
      };
    }

    return {
      action: 'NONE',
      sellQty: 0,
      reason: `Trailing not activated: gain +${priceGainPct.toFixed(2)}% < activation ${this.config.trailActivatePct}%`,
      expectedPnl: netProfit,
      netEdgePct: executionCost.netEdgePct,
      executionCostPct: executionCost.totalExecutionCostPct,
    };
  }

  /**
   * Update runner peak price (call every loop when runner is active)
   */
  updatePeakPrice(state: RunnerStateData, currentPrice: number): RunnerStateData {
    if (state.state !== 'ACTIVE') {
      return state;
    }

    const newPeak = Math.max(state.peakPrice ?? 0, currentPrice);
    if (newPeak !== state.peakPrice) {
      logger.debug('Runner peak price updated', {
        oldPeak: state.peakPrice,
        newPeak,
        currentPrice,
      });
    }

    return {
      ...state,
      peakPrice: newPeak,
    };
  }

  /**
   * Apply runner sell to state
   */
  applyRunnerSell(
    state: RunnerStateData,
    sellQty: number,
    isLadderStep: boolean
  ): RunnerStateData {
    const newQty = safeSubtract(state.qty, sellQty);
    const soldCostBasis = safeMultiply(state.costBasis, safeDivide(sellQty, state.qty));
    const newCostBasis = safeSubtract(state.costBasis, soldCostBasis);

    const newState: RunnerStateData = {
      ...state,
      qty: newQty,
      costBasis: newCostBasis,
    };

    // Advance ladder step if this was a ladder exit
    if (isLadderStep) {
      newState.ladderStep = state.ladderStep + 1;
    }

    // If runner is depleted, reset state
    if (newQty <= 0.0001) {
      newState.state = 'NONE';
      newState.qty = 0;
      newState.costBasis = 0;
      newState.entryPrice = null;
      newState.peakPrice = null;
      newState.startedAt = null;
      newState.ladderStep = 0;
      logger.info('Runner leg fully exited');
    }

    return newState;
  }

  /**
   * Calculate CORE position qty (excluding runner)
   */
  getCoreQty(totalQty: number, runnerQty: number): number {
    return Math.max(0, safeSubtract(totalQty, runnerQty));
  }

  /**
   * Calculate CORE position cost (excluding runner)
   */
  getCoreCost(totalCost: number, runnerCost: number): number {
    return Math.max(0, safeSubtract(totalCost, runnerCost));
  }

  /**
   * Check if runner is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get runner percentage
   */
  getRunnerPct(): number {
    return this.config.runnerPct;
  }
}
