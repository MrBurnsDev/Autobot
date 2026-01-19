import type { BotConfig } from './api';

/**
 * Strategy Presets
 *
 * These presets provide pre-configured strategy parameters for 3-bot comparison testing.
 * All presets use opt-in fields - applying a preset does NOT change fields it doesn't specify.
 * Existing configs remain fully backward compatible.
 */

export type PresetId = 'baseline-scale-out' | 'full-exit-scalp' | 'rolling-rebuy-harvest' | 'adaptive-reserve-reset' | 'best-roi-velocity';

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
 * Designed to prevent being stuck on large directional days while preserving profit-only exits.
 *
 * Uses pre-allocated reserves to handle large up-only and down-only days:
 * - Trading Bucket: ~34% for normal buy/sell cycles
 * - Rescue Reserve: Deployed on deep dips (2.5%+) to reset cost basis
 * - Chase Reserve: Deployed on breakouts (3%+) to participate in run-ups
 *
 * Key constraints:
 * - Profit-only sells (net-profit guard enforced)
 * - No forced stop-loss behavior
 * - Capital isolation per bot
 * - Rolling rebuy + reserve reset logic
 * - No ML, no prediction
 */
const adaptiveReserveReset: StrategyPreset = {
  id: 'adaptive-reserve-reset',
  name: 'Adaptive Reserve Reset (3-Bucket)',
  shortName: 'Reserve',
  description: 'Designed to prevent being stuck on large directional days while preserving profit-only exits.',
  config: {
    // Thresholds
    buyDipPct: 0.6,
    sellRisePct: 1.2,

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

    // Rate limiting
    cooldownSeconds: 90,
    maxTradesPerHour: 6,
    maxSlippageBps: 50,

    // Sizing
    compoundingMode: 'CALCULATED',
    compoundingReservePct: 7,

    // No daily loss limit interference - set extremely high
    dailyLossLimitUsdc: null,

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
 * Preset E: Best ROI (Velocity)
 *
 * High-velocity profit harvesting with profit-only exits.
 * Optimized for realistic ROI through frequent, net-profitable trades.
 *
 * Key characteristics:
 * - NOT a trend-hold bot - prioritizes frequent exits over large % moves
 * - 1.2% sell rise clears fees while maximizing capital velocity
 * - 0.6% dip matches real SOL intraday volatility
 * - 80% sell ensures frequent capital recycling
 * - Run-pullback rebuy prevents idle capital during strong trends
 * - Reserve reset prevents getting stuck on directional days
 * - High maxTradesPerHour (60) as safety guardrail, not strategy limiter
 *
 * Designed for $400 initial capital with natural compounding.
 */
const bestRoiVelocity: StrategyPreset = {
  id: 'best-roi-velocity',
  name: 'Best ROI (Velocity)',
  shortName: 'Velocity',
  description: 'High-velocity profit harvesting with profit-only exits. Optimized for realistic ROI, not long holds.',
  config: {
    // Chain
    chain: 'SOLANA',

    // Strategy thresholds
    buyDipPct: 0.6,
    sellRisePct: 1.2,

    // Trade sizing
    compoundingMode: 'CALCULATED',
    initialTradeSizeUsdc: 100,
    compoundingReservePct: 7,

    // Safety controls
    maxSlippageBps: 50,
    cooldownSeconds: 60,
    maxTradesPerHour: 60, // High ceiling - safety guardrail only
    dailyLossLimitUsdc: null, // Disabled - profit-only sells, no interference

    // Execution
    dryRunMode: false,

    // Exit strategy - full exit, no scale-out
    exitMode: 'FULL_EXIT',
    scaleOutSteps: 1,

    // Liquidity sources
    allowedSources: ['Orca', 'Raydium', 'Meteora', 'Phoenix', 'Lifinity', 'Openbook'],

    // Cycle mode - rolling rebuy for capital velocity
    cycleMode: 'ROLLING_REBUY',
    primarySellPct: 80,
    allowRebuy: true,
    rebuyDipPct: 0.6,
    maxRebuyCount: 1,
    exposureCapPct: 100,
    rebuyRegimeGate: true,

    // Runner (two-leg position model)
    // After CORE sell (80%), the remaining 20% becomes a RUNNER leg
    // Runner exits independently via trailing stop, doesn't block CORE trading
    runnerEnabled: true,
    runnerPct: 20, // primarySellPct + runnerPct = 100
    runnerMode: 'TRAILING',
    runnerTrailActivatePct: 1.8, // Start trailing after 1.8% profit
    runnerTrailStopPct: 0.7, // Exit on 0.7% pullback from peak
    runnerMinDollarProfit: 0.10, // Minimum $0.10 profit to exit (avoid dust)

    // Reserve reset (directional safety)
    enableReserveReset: true,
    resetReservePct: 66,
    rescueTriggerPct: 2.5,
    rescueDeployPctOfReserve: 50,
    maxRescueBuysPerCycle: 1,
    chaseTriggerPct: 3.0,
    chaseDeployPctOfReserve: 33,
    chaseExitTargetPct: 1.2,
    maxReserveDeploymentsPerCycle: 2,

    // Capital isolation
    initialCapitalUSDC: 400.03,
  },
};

/**
 * All available presets
 */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  bestRoiVelocity,
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
