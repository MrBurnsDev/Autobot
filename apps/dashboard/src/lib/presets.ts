import type { BotConfig } from './api';

/**
 * Strategy Presets
 *
 * These presets provide pre-configured strategy parameters for 3-bot comparison testing.
 * All presets use opt-in fields - applying a preset does NOT change fields it doesn't specify.
 * Existing configs remain fully backward compatible.
 */

export type PresetId = 'baseline-scale-out' | 'full-exit-scalp' | 'rolling-rebuy-harvest' | 'adaptive-reserve-reset';

export interface StrategyPreset {
  id: PresetId;
  name: string;
  shortName: string;
  description: string;
  /**
   * Partial BotConfig fields that this preset applies.
   * Only specified fields will be set when applying the preset.
   */
  config: Partial<BotConfig>;
}

/**
 * Preset A: Baseline Scale-Out
 *
 * Multi-step ladder exits with calculated sizing.
 * Control group for scale-out vs full-exit comparison.
 */
const baselineScaleOut: StrategyPreset = {
  id: 'baseline-scale-out',
  name: 'Baseline Scale-Out',
  shortName: 'Scale-Out',
  description: '3-step ladder exits with calculated sizing. Control group for scale-out comparison.',
  config: {
    // Exit strategy
    exitMode: 'SCALE_OUT',
    scaleOutSteps: 3,
    scaleOutRangePct: 1.8,

    // Thresholds
    buyDipPct: 0.6,
    sellRisePct: 1.2,

    // Rate limiting
    cooldownSeconds: 90,
    maxTradesPerHour: 6,
    maxSlippageBps: 50,

    // Sizing
    compoundingMode: 'CALCULATED',
    compoundingReservePct: 7,

    // Standard cycle mode (no rebuy)
    cycleMode: 'STANDARD',
    allowRebuy: false,
  },
};

/**
 * Preset B: Full Exit Scalp
 *
 * 100% exit at target, no scale-out.
 * BENCHMARK: Identical thresholds to baseline except full exit.
 */
const fullExitScalp: StrategyPreset = {
  id: 'full-exit-scalp',
  name: 'Full Exit Benchmark',
  shortName: 'Full Exit',
  description: '100% exit at target. Benchmark with identical thresholds to baseline (no scale-out).',
  config: {
    // Exit strategy - full exit, no scale-out
    exitMode: 'FULL_EXIT',
    scaleOutSteps: 1,

    // Thresholds - MUST MATCH BASELINE
    buyDipPct: 0.6,
    sellRisePct: 1.2,

    // Rate limiting - MUST MATCH BASELINE
    cooldownSeconds: 90,
    maxTradesPerHour: 6,
    maxSlippageBps: 50,

    // Sizing - MUST MATCH BASELINE
    compoundingMode: 'CALCULATED',
    compoundingReservePct: 7,

    // Standard cycle mode (no rebuy)
    cycleMode: 'STANDARD',
    allowRebuy: false,
  },
};

/**
 * Preset C: Rolling Rebuy Harvest
 *
 * 80/20 partial sells with rebuy on dip.
 * Tests rebuy strategy vs full exit.
 */
const rollingRebuyHarvest: StrategyPreset = {
  id: 'rolling-rebuy-harvest',
  name: 'Rolling Rebuy Harvest',
  shortName: 'Rebuy',
  description: '80/20 partial sells with rebuy on dip. Tests rebuy strategy vs full exit.',
  config: {
    // Exit strategy - full exit style (scale-out disabled)
    exitMode: 'FULL_EXIT',
    scaleOutSteps: 1,

    // Rolling rebuy cycle mode
    cycleMode: 'ROLLING_REBUY',
    primarySellPct: 80,
    allowRebuy: true,
    maxRebuyCount: 1,
    exposureCapPct: 100,
    rebuyRegimeGate: true, // CHOP_ONLY
    rebuyDipPct: 0.6,

    // Thresholds
    buyDipPct: 0.6,
    sellRisePct: 1.2,

    // Rate limiting - MUST MATCH BASELINE
    cooldownSeconds: 90,
    maxTradesPerHour: 6,
    maxSlippageBps: 50,

    // Sizing - MUST MATCH BASELINE
    compoundingMode: 'CALCULATED',
    compoundingReservePct: 7,
  },
};

/**
 * Preset D: Adaptive Reserve Reset (3-Bucket)
 *
 * Uses pre-allocated reserves to handle large directional days:
 * - Trading Bucket: ~34% for normal buy/sell cycles
 * - Rescue Reserve: Deployed on deep dips (2.5%+) to reset cost basis
 * - Chase Reserve: Deployed on breakouts (3%+) to participate in run-ups
 *
 * Key features:
 * - Rolling rebuy mode with 80% primary sells
 * - Rescue buys in TREND/CHAOS regimes only
 * - Chase buys in TREND_UP only (upward trending)
 * - Chase exits at 1.2% profit target
 */
const adaptiveReserveReset: StrategyPreset = {
  id: 'adaptive-reserve-reset',
  name: 'Adaptive Reserve Reset (3-Bucket)',
  shortName: 'Reserve',
  description: 'Uses 66% reserve for rescue buys (downside) and chase buys (upside) to handle directional days.',
  config: {
    // Exit strategy - full exit style
    exitMode: 'FULL_EXIT',
    scaleOutSteps: 1,

    // Rolling rebuy cycle mode (required for reserve reset)
    cycleMode: 'ROLLING_REBUY',
    primarySellPct: 80,
    allowRebuy: true,
    maxRebuyCount: 1,
    exposureCapPct: 100,
    rebuyRegimeGate: true,
    rebuyDipPct: 0.6,

    // Thresholds - MUST MATCH BASELINE
    buyDipPct: 0.6,
    sellRisePct: 1.2,

    // Rate limiting - MUST MATCH BASELINE
    cooldownSeconds: 90,
    maxTradesPerHour: 6,
    maxSlippageBps: 50,

    // Sizing - MUST MATCH BASELINE
    compoundingMode: 'CALCULATED',
    compoundingReservePct: 7,

    // === RESERVE RESET CONFIGURATION (3-Bucket Strategy) ===
    enableReserveReset: true,
    resetReservePct: 66, // 66% in reserve, 34% for trading

    // Rescue buy (downside reset)
    rescueTriggerPct: 2.5,           // Trigger when price drops 2.5% from lastBuyPrice
    rescueDeployPctOfReserve: 50,    // Deploy 50% of reserve on rescue
    maxRescueBuysPerCycle: 1,        // Max 1 rescue per cycle
    rescueRegimeGate: 'TREND_OR_CHAOS', // Only in trending or volatile markets

    // Chase buy (upside reset)
    chaseTriggerPct: 3.0,            // Trigger when price rises 3% above lastSellPrice
    chaseDeployPctOfReserve: 33,     // Deploy 33% of reserve on chase
    chaseExitTargetPct: 1.2,         // Exit chase at 1.2% profit
    chaseRegimeGate: 'TREND_UP_ONLY', // Only in upward trends

    // Limit total deployments per cycle
    maxReserveDeploymentsPerCycle: 2, // Max 2 reserve deployments per cycle
  },
};

/**
 * All available presets
 */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  baselineScaleOut,
  fullExitScalp,
  rollingRebuyHarvest,
  adaptiveReserveReset,
];

/**
 * Get a preset by ID
 */
export function getPresetById(id: PresetId): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((p) => p.id === id);
}

/**
 * Apply a preset to existing config values.
 * Only overwrites fields specified in the preset.
 *
 * @param currentConfig - Current form values
 * @param preset - Preset to apply
 * @returns Merged config with preset values applied
 */
export function applyPreset<T extends Partial<BotConfig>>(
  currentConfig: T,
  preset: StrategyPreset
): T {
  return {
    ...currentConfig,
    ...preset.config,
  };
}
