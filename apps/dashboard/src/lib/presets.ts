import type { BotConfig } from './api';

/**
 * Strategy Presets
 *
 * These presets provide pre-configured strategy parameters for 3-bot comparison testing.
 * All presets use opt-in fields - applying a preset does NOT change fields it doesn't specify.
 * Existing configs remain fully backward compatible.
 */

export type PresetId = 'baseline-scale-out' | 'full-exit-scalp' | 'rolling-rebuy-harvest';

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
 * All available presets
 */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  baselineScaleOut,
  fullExitScalp,
  rollingRebuyHarvest,
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
