import { Logger, safeDivide, safeMultiply, safeSubtract } from '../utils/index.js';
import type { MarketRegime } from './regime-classifier.js';

const logger = new Logger('ReserveResetManager');

/**
 * Regime gate types for reserve reset conditions
 */
export type RescueRegimeGate = 'NONE' | 'TREND_ONLY' | 'CHAOS_ONLY' | 'TREND_OR_CHAOS';
export type ChaseRegimeGate = 'NONE' | 'TREND_UP_ONLY' | 'TREND_ONLY';

/**
 * Reserve reset configuration
 */
export interface ReserveResetConfig {
  // Enable reserve reset behavior
  enableReserveReset: boolean;

  // Percentage of allocated capital reserved for resets (default 66%)
  resetReservePct: number;

  // Maximum reserve deployments per cycle before reverting to standard behavior
  maxReserveDeploymentsPerCycle: number;

  // --- Rescue Buy (downside reset) ---
  // Price drop % from lastBuyPrice to trigger rescue buy
  rescueTriggerPct: number;

  // Percentage of reserve to deploy on rescue (default 50%)
  rescueDeployPctOfReserve: number;

  // Max rescue buys per cycle
  maxRescueBuysPerCycle: number;

  // Rescue regime gate
  rescueRegimeGate: RescueRegimeGate;

  // --- Chase Buy (upside reset) ---
  // Price rise % above lastSellPrice to trigger chase buy
  chaseTriggerPct: number;

  // Percentage of reserve to deploy on chase (default 33%)
  chaseDeployPctOfReserve: number;

  // Profit target for chase exit (from new basis)
  chaseExitTargetPct: number;

  // Chase regime gate
  chaseRegimeGate: ChaseRegimeGate;
}

/**
 * Reserve state for a cycle
 */
export interface ReserveState {
  // Initial reserve amount at cycle start
  initialReserveUsdc: number;

  // Remaining reserve available for deployment
  availableReserveUsdc: number;

  // Number of rescue buys executed in current cycle
  rescueBuyCount: number;

  // Number of chase buys executed in current cycle
  chaseBuyCount: number;

  // Total deployments (rescue + chase) in current cycle
  totalDeployments: number;

  // Whether bot is in "chase mode" (holding chase position)
  inChaseMode: boolean;

  // Entry price for current chase position
  chaseEntryPrice: number | null;

  // Cost basis for chase position
  chaseCostBasis: number;

  // Quantity of base held in chase position
  chaseBaseQty: number;
}

/**
 * Reserve reset action types
 */
export type ReserveResetAction =
  | 'RESCUE_BUY'     // Downside reset - buy on deep dip
  | 'CHASE_BUY'      // Upside reset - buy after missing run-up
  | 'CHASE_EXIT'     // Exit from chase position
  | 'NONE';          // No action needed

/**
 * Decision result from reserve reset manager
 */
export interface ReserveResetDecision {
  action: ReserveResetAction;

  // Whether action should be taken
  shouldAct: boolean;

  // Amount to deploy (for BUY actions)
  deployAmountUsdc: number;

  // Sell target price (for CHASE_EXIT)
  sellTargetPrice: number | null;

  // Reason for decision
  reason: string;

  // Gate/condition that was checked
  gateResult: {
    regimePassed: boolean;
    reserveAvailable: boolean;
    triggerMet: boolean;
    withinLimits: boolean;
  };
}

/**
 * Price context for making reserve reset decisions
 */
export interface ReserveResetContext {
  currentPrice: number;
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  currentRegime: MarketRegime;

  // Price direction context (for TREND_UP detection)
  priceChange24h?: number;
  priceChange1h?: number;
}

/**
 * Default configuration for reserve reset
 */
export const DEFAULT_RESERVE_RESET_CONFIG: ReserveResetConfig = {
  enableReserveReset: false,
  resetReservePct: 66.0,
  maxReserveDeploymentsPerCycle: 2,
  rescueTriggerPct: 2.5,
  rescueDeployPctOfReserve: 50.0,
  maxRescueBuysPerCycle: 1,
  rescueRegimeGate: 'TREND_OR_CHAOS',
  chaseTriggerPct: 3.0,
  chaseDeployPctOfReserve: 33.0,
  chaseExitTargetPct: 1.2,
  chaseRegimeGate: 'TREND_UP_ONLY',
};

/**
 * Reserve Reset Manager
 *
 * Manages the 3-bucket capital strategy for handling large directional days:
 * 1. Trading Bucket: ~34% of capital for normal buy/sell cycles
 * 2. Rescue Reserve: Deployed on deep dips to reset cost basis
 * 3. Chase Reserve: Deployed on breakouts to participate in run-ups
 *
 * Key invariants:
 * - Reserve deployments are tracked per cycle (reset when selling all base)
 * - Rescue buys blend into existing position (averaged cost basis)
 * - Chase buys create a separate position with fixed exit target
 * - All trades still respect capital allocation limits
 */
export class ReserveResetManager {
  constructor(private config: ReserveResetConfig) {}

  /**
   * Initialize reserve state for a new cycle
   */
  initializeReserveState(allocatedCapitalUsdc: number): ReserveState {
    const initialReserve = safeMultiply(
      allocatedCapitalUsdc,
      this.config.resetReservePct / 100
    );

    return {
      initialReserveUsdc: initialReserve,
      availableReserveUsdc: initialReserve,
      rescueBuyCount: 0,
      chaseBuyCount: 0,
      totalDeployments: 0,
      inChaseMode: false,
      chaseEntryPrice: null,
      chaseCostBasis: 0,
      chaseBaseQty: 0,
    };
  }

  /**
   * Get the trading bucket size (capital available for normal trading)
   */
  getTradingBucketUsdc(allocatedCapitalUsdc: number): number {
    const reservePct = this.config.enableReserveReset
      ? this.config.resetReservePct
      : 0;

    return safeMultiply(allocatedCapitalUsdc, (100 - reservePct) / 100);
  }

  /**
   * Evaluate whether a rescue buy should be triggered
   */
  evaluateRescueBuy(
    state: ReserveState,
    context: ReserveResetContext
  ): ReserveResetDecision {
    const defaultResult: ReserveResetDecision = {
      action: 'RESCUE_BUY',
      shouldAct: false,
      deployAmountUsdc: 0,
      sellTargetPrice: null,
      reason: '',
      gateResult: {
        regimePassed: false,
        reserveAvailable: false,
        triggerMet: false,
        withinLimits: false,
      },
    };

    // Check if feature is enabled
    if (!this.config.enableReserveReset) {
      return { ...defaultResult, reason: 'Reserve reset not enabled' };
    }

    // Check if we have a reference price
    if (context.lastBuyPrice === null) {
      return { ...defaultResult, reason: 'No last buy price for rescue trigger' };
    }

    // Gate 1: Check regime
    const regimePassed = this.checkRescueRegimeGate(context.currentRegime);
    defaultResult.gateResult.regimePassed = regimePassed;
    if (!regimePassed) {
      return {
        ...defaultResult,
        reason: `Regime ${context.currentRegime} not allowed for rescue (gate: ${this.config.rescueRegimeGate})`,
      };
    }

    // Gate 2: Check reserve availability
    const deployAmount = safeMultiply(
      state.availableReserveUsdc,
      this.config.rescueDeployPctOfReserve / 100
    );
    const reserveAvailable = deployAmount > 0 && state.availableReserveUsdc > 0;
    defaultResult.gateResult.reserveAvailable = reserveAvailable;
    if (!reserveAvailable) {
      return { ...defaultResult, reason: 'No reserve available for rescue buy' };
    }

    // Gate 3: Check trigger condition (price dropped enough)
    const priceDropPct = safeMultiply(
      safeDivide(safeSubtract(context.lastBuyPrice, context.currentPrice), context.lastBuyPrice),
      100
    );
    const triggerMet = priceDropPct >= this.config.rescueTriggerPct;
    defaultResult.gateResult.triggerMet = triggerMet;
    if (!triggerMet) {
      return {
        ...defaultResult,
        reason: `Price drop ${priceDropPct.toFixed(2)}% below rescue trigger ${this.config.rescueTriggerPct}%`,
      };
    }

    // Gate 4: Check limits
    const withinLimits =
      state.rescueBuyCount < this.config.maxRescueBuysPerCycle &&
      state.totalDeployments < this.config.maxReserveDeploymentsPerCycle;
    defaultResult.gateResult.withinLimits = withinLimits;
    if (!withinLimits) {
      return {
        ...defaultResult,
        reason: `Rescue limits exceeded (count: ${state.rescueBuyCount}/${this.config.maxRescueBuysPerCycle}, total: ${state.totalDeployments}/${this.config.maxReserveDeploymentsPerCycle})`,
      };
    }

    // All gates passed - recommend rescue buy
    return {
      action: 'RESCUE_BUY',
      shouldAct: true,
      deployAmountUsdc: deployAmount,
      sellTargetPrice: null,
      reason: `Rescue buy triggered: price dropped ${priceDropPct.toFixed(2)}% from last buy`,
      gateResult: {
        regimePassed: true,
        reserveAvailable: true,
        triggerMet: true,
        withinLimits: true,
      },
    };
  }

  /**
   * Evaluate whether a chase buy should be triggered
   */
  evaluateChaseBuy(
    state: ReserveState,
    context: ReserveResetContext
  ): ReserveResetDecision {
    const defaultResult: ReserveResetDecision = {
      action: 'CHASE_BUY',
      shouldAct: false,
      deployAmountUsdc: 0,
      sellTargetPrice: null,
      reason: '',
      gateResult: {
        regimePassed: false,
        reserveAvailable: false,
        triggerMet: false,
        withinLimits: false,
      },
    };

    // Check if feature is enabled
    if (!this.config.enableReserveReset) {
      return { ...defaultResult, reason: 'Reserve reset not enabled' };
    }

    // Don't chase if already in chase mode
    if (state.inChaseMode) {
      return { ...defaultResult, reason: 'Already in chase mode' };
    }

    // Check if we have a reference price
    if (context.lastSellPrice === null) {
      return { ...defaultResult, reason: 'No last sell price for chase trigger' };
    }

    // Gate 1: Check regime (including TREND_UP detection)
    const regimePassed = this.checkChaseRegimeGate(context.currentRegime, context);
    defaultResult.gateResult.regimePassed = regimePassed;
    if (!regimePassed) {
      return {
        ...defaultResult,
        reason: `Regime ${context.currentRegime} not allowed for chase (gate: ${this.config.chaseRegimeGate})`,
      };
    }

    // Gate 2: Check reserve availability
    const deployAmount = safeMultiply(
      state.availableReserveUsdc,
      this.config.chaseDeployPctOfReserve / 100
    );
    const reserveAvailable = deployAmount > 0 && state.availableReserveUsdc > 0;
    defaultResult.gateResult.reserveAvailable = reserveAvailable;
    if (!reserveAvailable) {
      return { ...defaultResult, reason: 'No reserve available for chase buy' };
    }

    // Gate 3: Check trigger condition (price rose enough above last sell)
    const priceRisePct = safeMultiply(
      safeDivide(safeSubtract(context.currentPrice, context.lastSellPrice), context.lastSellPrice),
      100
    );
    const triggerMet = priceRisePct >= this.config.chaseTriggerPct;
    defaultResult.gateResult.triggerMet = triggerMet;
    if (!triggerMet) {
      return {
        ...defaultResult,
        reason: `Price rise ${priceRisePct.toFixed(2)}% below chase trigger ${this.config.chaseTriggerPct}%`,
      };
    }

    // Gate 4: Check limits
    const withinLimits = state.totalDeployments < this.config.maxReserveDeploymentsPerCycle;
    defaultResult.gateResult.withinLimits = withinLimits;
    if (!withinLimits) {
      return {
        ...defaultResult,
        reason: `Deployment limits exceeded (total: ${state.totalDeployments}/${this.config.maxReserveDeploymentsPerCycle})`,
      };
    }

    // Calculate exit target
    const exitTargetPrice = safeMultiply(
      context.currentPrice,
      1 + this.config.chaseExitTargetPct / 100
    );

    // All gates passed - recommend chase buy
    return {
      action: 'CHASE_BUY',
      shouldAct: true,
      deployAmountUsdc: deployAmount,
      sellTargetPrice: exitTargetPrice,
      reason: `Chase buy triggered: price rose ${priceRisePct.toFixed(2)}% above last sell`,
      gateResult: {
        regimePassed: true,
        reserveAvailable: true,
        triggerMet: true,
        withinLimits: true,
      },
    };
  }

  /**
   * Evaluate whether chase position should be exited
   */
  evaluateChaseExit(
    state: ReserveState,
    context: ReserveResetContext
  ): ReserveResetDecision {
    const defaultResult: ReserveResetDecision = {
      action: 'CHASE_EXIT',
      shouldAct: false,
      deployAmountUsdc: 0,
      sellTargetPrice: null,
      reason: '',
      gateResult: {
        regimePassed: true, // Not checked for exit
        reserveAvailable: true, // Not applicable
        triggerMet: false,
        withinLimits: true, // Not applicable
      },
    };

    // Only applicable if in chase mode
    if (!state.inChaseMode || state.chaseEntryPrice === null) {
      return { ...defaultResult, reason: 'Not in chase mode' };
    }

    // Calculate target price
    const exitTargetPrice = safeMultiply(
      state.chaseEntryPrice,
      1 + this.config.chaseExitTargetPct / 100
    );

    // Check if target is reached
    if (context.currentPrice >= exitTargetPrice) {
      return {
        action: 'CHASE_EXIT',
        shouldAct: true,
        deployAmountUsdc: 0,
        sellTargetPrice: exitTargetPrice,
        reason: `Chase exit triggered: price ${context.currentPrice.toFixed(4)} >= target ${exitTargetPrice.toFixed(4)}`,
        gateResult: {
          regimePassed: true,
          reserveAvailable: true,
          triggerMet: true,
          withinLimits: true,
        },
      };
    }

    return {
      ...defaultResult,
      sellTargetPrice: exitTargetPrice,
      reason: `Chase exit waiting: price ${context.currentPrice.toFixed(4)} < target ${exitTargetPrice.toFixed(4)}`,
    };
  }

  /**
   * Update state after rescue buy execution
   */
  recordRescueBuy(
    state: ReserveState,
    deployedUsdc: number,
    executedPrice: number,
    baseQtyReceived: number
  ): ReserveState {
    return {
      ...state,
      availableReserveUsdc: safeSubtract(state.availableReserveUsdc, deployedUsdc),
      rescueBuyCount: state.rescueBuyCount + 1,
      totalDeployments: state.totalDeployments + 1,
    };
  }

  /**
   * Update state after chase buy execution
   */
  recordChaseBuy(
    state: ReserveState,
    deployedUsdc: number,
    executedPrice: number,
    baseQtyReceived: number
  ): ReserveState {
    return {
      ...state,
      availableReserveUsdc: safeSubtract(state.availableReserveUsdc, deployedUsdc),
      chaseBuyCount: state.chaseBuyCount + 1,
      totalDeployments: state.totalDeployments + 1,
      inChaseMode: true,
      chaseEntryPrice: executedPrice,
      chaseCostBasis: deployedUsdc,
      chaseBaseQty: baseQtyReceived,
    };
  }

  /**
   * Update state after chase exit execution
   */
  recordChaseExit(state: ReserveState): ReserveState {
    return {
      ...state,
      inChaseMode: false,
      chaseEntryPrice: null,
      chaseCostBasis: 0,
      chaseBaseQty: 0,
    };
  }

  /**
   * Reset cycle state (call when starting new cycle after selling all base)
   */
  resetCycle(state: ReserveState, newAllocatedCapitalUsdc: number): ReserveState {
    return this.initializeReserveState(newAllocatedCapitalUsdc);
  }

  /**
   * Check if rescue regime gate passes
   */
  private checkRescueRegimeGate(regime: MarketRegime): boolean {
    switch (this.config.rescueRegimeGate) {
      case 'NONE':
        return true;
      case 'TREND_ONLY':
        return regime === 'TREND';
      case 'CHAOS_ONLY':
        return regime === 'CHAOS';
      case 'TREND_OR_CHAOS':
        return regime === 'TREND' || regime === 'CHAOS';
      default:
        return false;
    }
  }

  /**
   * Check if chase regime gate passes
   */
  private checkChaseRegimeGate(regime: MarketRegime, context: ReserveResetContext): boolean {
    switch (this.config.chaseRegimeGate) {
      case 'NONE':
        return true;
      case 'TREND_ONLY':
        return regime === 'TREND';
      case 'TREND_UP_ONLY':
        // Check for TREND regime AND upward price direction
        if (regime !== 'TREND') return false;
        // Use 1h or 24h price change to determine direction
        const priceChange = context.priceChange1h ?? context.priceChange24h ?? 0;
        return priceChange > 0;
      default:
        return false;
    }
  }
}

/**
 * Format reserve reset decision for logging
 */
export function formatReserveResetLog(decision: ReserveResetDecision): string {
  const gates = decision.gateResult;
  const gateStr = `regime=${gates.regimePassed ? 'Y' : 'N'} reserve=${gates.reserveAvailable ? 'Y' : 'N'} trigger=${gates.triggerMet ? 'Y' : 'N'} limits=${gates.withinLimits ? 'Y' : 'N'}`;

  if (decision.shouldAct) {
    return `${decision.action}: $${decision.deployAmountUsdc.toFixed(2)} | ${decision.reason} | [${gateStr}]`;
  }

  return `${decision.action}: SKIP | ${decision.reason} | [${gateStr}]`;
}

/**
 * Format reserve state for logging
 */
export function formatReserveStateLog(state: ReserveState): string {
  const parts = [
    `reserve=$${state.availableReserveUsdc.toFixed(2)}/$${state.initialReserveUsdc.toFixed(2)}`,
    `rescues=${state.rescueBuyCount}`,
    `chases=${state.chaseBuyCount}`,
    `deploys=${state.totalDeployments}`,
  ];

  if (state.inChaseMode) {
    parts.push(`chase@${state.chaseEntryPrice?.toFixed(4)}`);
  }

  return parts.join(' | ');
}
