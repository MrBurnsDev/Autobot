import { Logger, safeDivide, safeSubtract } from '../utils/index.js';

const logger = new Logger('RegimeClassifier');

/**
 * Market regime types
 */
export type MarketRegime = 'CHOP' | 'TREND' | 'CHAOS' | 'UNKNOWN';

/**
 * Configuration for regime detection
 */
export interface RegimeConfig {
  // Volatility threshold for CHAOS detection (%)
  chaosVolatilityThreshold: number;

  // Range threshold for CHOP detection (%)
  chopRangeThreshold: number;

  // Minimum samples required for classification
  minSamplesForClassification: number;

  // Time thresholds
  fastCycleThresholdMinutes: number;   // Below this = fast cycle
  slowCycleThresholdMinutes: number;   // Above this = slow cycle
}

/**
 * Hourly analytics input for regime detection
 */
export interface HourlyAnalytics {
  priceRangePct: number;           // (high - low) / open * 100
  volatility1h: number;            // Std dev of price samples
  avgSlippageBps: number;
  cyclesCompleted: number;
  avgCycleTimeMinutes: number | null;
  buyCount: number;
  sellCount: number;
  rejectedCount: number;
  failedCount: number;
}

/**
 * Result of regime classification
 */
export interface RegimeClassification {
  regime: MarketRegime;
  confidence: number;          // 0-1 confidence score
  signals: RegimeSignal[];     // Individual signals that contributed
  recommendation: RegimeRecommendation;
}

export interface RegimeSignal {
  name: string;
  value: number;
  threshold: number;
  direction: 'above' | 'below';
  weight: number;
}

export interface RegimeRecommendation {
  shouldTrade: boolean;
  buyDipMultiplier: number;      // 1.0 = use base, <1.0 = tighten, >1.0 = widen
  sellTargetMultiplier: number;
  cooldownMultiplier: number;    // >1.0 = increase cooldown
  reason: string;
}

/**
 * Rule-based market regime classifier
 * NO ML, NO PREDICTION - purely deterministic thresholds
 */
export class RegimeClassifier {
  constructor(private config: RegimeConfig) {}

  /**
   * Classify market regime from recent analytics
   */
  classify(recentHours: HourlyAnalytics[]): RegimeClassification {
    if (recentHours.length < this.config.minSamplesForClassification) {
      return {
        regime: 'UNKNOWN',
        confidence: 0,
        signals: [],
        recommendation: this.getDefaultRecommendation(),
      };
    }

    const signals: RegimeSignal[] = [];

    // Calculate aggregate metrics
    const avgVolatility = this.average(recentHours.map(h => h.volatility1h));
    const avgRange = this.average(recentHours.map(h => h.priceRangePct));
    const avgSlippage = this.average(recentHours.map(h => h.avgSlippageBps));
    const totalCycles = recentHours.reduce((sum, h) => sum + h.cyclesCompleted, 0);
    const totalRejections = recentHours.reduce((sum, h) => sum + h.rejectedCount, 0);
    const totalFailures = recentHours.reduce((sum, h) => sum + h.failedCount, 0);

    // Get avg cycle time from hours that have it
    const cycleTimeHours = recentHours.filter(h => h.avgCycleTimeMinutes !== null);
    const avgCycleTime = cycleTimeHours.length > 0
      ? this.average(cycleTimeHours.map(h => h.avgCycleTimeMinutes!))
      : null;

    // ===== CHAOS DETECTION =====
    // High volatility OR high slippage instability OR many failures
    const volatilitySignal: RegimeSignal = {
      name: 'volatility',
      value: avgVolatility,
      threshold: this.config.chaosVolatilityThreshold,
      direction: 'above',
      weight: 0.4,
    };
    signals.push(volatilitySignal);

    const slippageInstabilitySignal: RegimeSignal = {
      name: 'slippage_instability',
      value: avgSlippage,
      threshold: 100, // 100 bps = 1%
      direction: 'above',
      weight: 0.3,
    };
    signals.push(slippageInstabilitySignal);

    const failureRateSignal: RegimeSignal = {
      name: 'failure_rate',
      value: totalFailures,
      threshold: 3,
      direction: 'above',
      weight: 0.3,
    };
    signals.push(failureRateSignal);

    // Check for CHAOS
    const chaosScore = this.calculateRegimeScore([
      { signal: volatilitySignal, isMet: avgVolatility > this.config.chaosVolatilityThreshold },
      { signal: slippageInstabilitySignal, isMet: avgSlippage > 100 },
      { signal: failureRateSignal, isMet: totalFailures > 3 },
    ]);

    if (chaosScore >= 0.5) {
      return {
        regime: 'CHAOS',
        confidence: chaosScore,
        signals,
        recommendation: {
          shouldTrade: false,
          buyDipMultiplier: 1.5,
          sellTargetMultiplier: 1.5,
          cooldownMultiplier: 2.0,
          reason: 'CHAOS: High volatility/instability detected. Trading paused.',
        },
      };
    }

    // ===== CHOP DETECTION =====
    // Tight ranges, fast cycles, frequent reversals
    const rangeSignal: RegimeSignal = {
      name: 'price_range',
      value: avgRange,
      threshold: this.config.chopRangeThreshold,
      direction: 'below',
      weight: 0.4,
    };
    signals.push(rangeSignal);

    const fastCycleSignal: RegimeSignal = {
      name: 'cycle_speed',
      value: avgCycleTime ?? 999,
      threshold: this.config.fastCycleThresholdMinutes,
      direction: 'below',
      weight: 0.4,
    };
    signals.push(fastCycleSignal);

    const cycleFrequencySignal: RegimeSignal = {
      name: 'cycle_frequency',
      value: totalCycles,
      threshold: 2,
      direction: 'above',
      weight: 0.2,
    };
    signals.push(cycleFrequencySignal);

    const chopScore = this.calculateRegimeScore([
      { signal: rangeSignal, isMet: avgRange < this.config.chopRangeThreshold },
      { signal: fastCycleSignal, isMet: (avgCycleTime ?? 999) < this.config.fastCycleThresholdMinutes },
      { signal: cycleFrequencySignal, isMet: totalCycles >= 2 },
    ]);

    if (chopScore >= 0.5) {
      return {
        regime: 'CHOP',
        confidence: chopScore,
        signals,
        recommendation: {
          shouldTrade: true,
          buyDipMultiplier: 0.9,      // Slightly tighter entry
          sellTargetMultiplier: 0.95,  // Slightly tighter exit
          cooldownMultiplier: 0.8,     // Shorter cooldown
          reason: 'CHOP: Favorable conditions for range trading.',
        },
      };
    }

    // ===== TREND DETECTION =====
    // Wide ranges, slow cycles, one-sided movement
    const wideRangeSignal: RegimeSignal = {
      name: 'wide_range',
      value: avgRange,
      threshold: this.config.chopRangeThreshold * 2,
      direction: 'above',
      weight: 0.4,
    };
    signals.push(wideRangeSignal);

    const slowCycleSignal: RegimeSignal = {
      name: 'slow_cycles',
      value: avgCycleTime ?? 0,
      threshold: this.config.slowCycleThresholdMinutes,
      direction: 'above',
      weight: 0.4,
    };
    signals.push(slowCycleSignal);

    const lowCycleSignal: RegimeSignal = {
      name: 'low_cycle_count',
      value: totalCycles,
      threshold: 1,
      direction: 'below',
      weight: 0.2,
    };
    signals.push(lowCycleSignal);

    const trendScore = this.calculateRegimeScore([
      { signal: wideRangeSignal, isMet: avgRange > this.config.chopRangeThreshold * 2 },
      { signal: slowCycleSignal, isMet: (avgCycleTime ?? 0) > this.config.slowCycleThresholdMinutes },
      { signal: lowCycleSignal, isMet: totalCycles <= 1 },
    ]);

    if (trendScore >= 0.4) {
      return {
        regime: 'TREND',
        confidence: trendScore,
        signals,
        recommendation: {
          shouldTrade: true,
          buyDipMultiplier: 1.2,       // Wider entry
          sellTargetMultiplier: 1.3,   // Wider exit
          cooldownMultiplier: 1.5,     // Longer cooldown
          reason: 'TREND: One-sided movement detected. Widen targets, reduce frequency.',
        },
      };
    }

    // Default: Unknown/neutral
    return {
      regime: 'UNKNOWN',
      confidence: 0.5,
      signals,
      recommendation: this.getDefaultRecommendation(),
    };
  }

  /**
   * Calculate weighted regime score
   */
  private calculateRegimeScore(
    conditions: Array<{ signal: RegimeSignal; isMet: boolean }>
  ): number {
    let totalWeight = 0;
    let metWeight = 0;

    for (const { signal, isMet } of conditions) {
      totalWeight += signal.weight;
      if (isMet) {
        metWeight += signal.weight;
      }
    }

    return totalWeight > 0 ? safeDivide(metWeight, totalWeight) : 0;
  }

  /**
   * Get default recommendation for unknown regime
   */
  private getDefaultRecommendation(): RegimeRecommendation {
    return {
      shouldTrade: true,
      buyDipMultiplier: 1.0,
      sellTargetMultiplier: 1.0,
      cooldownMultiplier: 1.0,
      reason: 'Insufficient data for regime classification. Using default parameters.',
    };
  }

  /**
   * Calculate average of numbers
   */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}

/**
 * Format regime classification for logging
 */
export function formatRegimeLog(classification: RegimeClassification): string {
  const signalStrs = classification.signals
    .filter(s => s.value !== 999 && s.value !== null)
    .map(s => `${s.name}=${s.value.toFixed(2)}`)
    .join(', ');

  return `Regime: ${classification.regime} (${(classification.confidence * 100).toFixed(0)}% conf) | ${signalStrs} | ${classification.recommendation.reason}`;
}
