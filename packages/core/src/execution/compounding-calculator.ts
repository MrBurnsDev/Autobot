import { Logger, safeDivide, safeMultiply, safeSubtract, safeAdd, safeMax } from '../utils/index.js';

const logger = new Logger('CompoundingCalculator');

/**
 * Compounding mode for trade size calculation
 */
export type CompoundingMode = 'FIXED' | 'FULL_BALANCE' | 'CALCULATED';

/**
 * Configuration for compounding calculator
 */
export interface CompoundingConfig {
  mode: CompoundingMode;
  fixedTradeSize: number;          // Base trade size in USDC
  initialTradeSizeUsdc: number | null;  // Starting size for CALCULATED mode
  reservePct: number;              // Reserve percentage (e.g., 5.0 = 5%)
  minTradeNotional: number;        // Minimum trade size in USDC
  minQuoteReserve: number;         // Minimum quote reserve to maintain
}

/**
 * Result of trade size calculation
 */
export interface TradeSizeResult {
  tradeSizeUsdc: number;           // Final trade size in USDC
  mode: CompoundingMode;
  reason: string;
  details: {
    availableBalance: number;
    reserveAmount: number;
    realizedGains: number | null;
    compoundedAmount: number | null;
  };
}

/**
 * Default compounding configuration
 */
export const DEFAULT_COMPOUNDING_CONFIG: CompoundingConfig = {
  mode: 'FIXED',
  fixedTradeSize: 25.0,
  initialTradeSizeUsdc: null,
  reservePct: 5.0,
  minTradeNotional: 10.0,
  minQuoteReserve: 5.0,
};

/**
 * Compounding calculator for dynamic trade sizing
 *
 * Three modes:
 * - FIXED: Always use the configured fixed trade size (original behavior)
 * - FULL_BALANCE: Use full available balance minus reserves
 * - CALCULATED: Base + portion of realized gains, with reserve buffer
 */
export class CompoundingCalculator {
  constructor(private config: CompoundingConfig) {}

  /**
   * Calculate the trade size for a BUY order
   *
   * @param quoteBalance - Current USDC balance
   * @param dailyRealizedPnl - Realized PnL since last reset
   * @param totalRealizedPnl - All-time realized PnL (optional, for advanced sizing)
   */
  calculateBuySize(
    quoteBalance: number,
    dailyRealizedPnl: number = 0,
    totalRealizedPnl: number = 0
  ): TradeSizeResult {
    // Calculate available balance after reserve
    const reserveAmount = safeMax(
      this.config.minQuoteReserve,
      safeMultiply(quoteBalance, this.config.reservePct / 100)
    );
    const availableBalance = safeSubtract(quoteBalance, reserveAmount);

    // Check if we have enough balance at all
    if (availableBalance < this.config.minTradeNotional) {
      return {
        tradeSizeUsdc: 0,
        mode: this.config.mode,
        reason: `Insufficient balance after reserve: ${availableBalance.toFixed(2)} < ${this.config.minTradeNotional}`,
        details: {
          availableBalance,
          reserveAmount,
          realizedGains: null,
          compoundedAmount: null,
        },
      };
    }

    switch (this.config.mode) {
      case 'FIXED':
        return this.calculateFixedSize(availableBalance, reserveAmount);

      case 'FULL_BALANCE':
        return this.calculateFullBalanceSize(availableBalance, reserveAmount);

      case 'CALCULATED':
        return this.calculateCompoundedSize(
          availableBalance,
          reserveAmount,
          dailyRealizedPnl,
          totalRealizedPnl
        );

      default:
        // Fallback to FIXED for unknown modes
        logger.warn(`Unknown compounding mode: ${this.config.mode}, using FIXED`);
        return this.calculateFixedSize(availableBalance, reserveAmount);
    }
  }

  /**
   * FIXED mode: Use configured trade size, capped by available balance
   */
  private calculateFixedSize(
    availableBalance: number,
    reserveAmount: number
  ): TradeSizeResult {
    const tradeSizeUsdc = Math.min(this.config.fixedTradeSize, availableBalance);

    // Enforce minimum
    if (tradeSizeUsdc < this.config.minTradeNotional) {
      return {
        tradeSizeUsdc: 0,
        mode: 'FIXED',
        reason: `Fixed size ${this.config.fixedTradeSize} exceeds available ${availableBalance.toFixed(2)}`,
        details: {
          availableBalance,
          reserveAmount,
          realizedGains: null,
          compoundedAmount: null,
        },
      };
    }

    return {
      tradeSizeUsdc,
      mode: 'FIXED',
      reason: `Fixed trade size: $${tradeSizeUsdc.toFixed(2)}`,
      details: {
        availableBalance,
        reserveAmount,
        realizedGains: null,
        compoundedAmount: null,
      },
    };
  }

  /**
   * FULL_BALANCE mode: Use entire available balance minus reserve
   */
  private calculateFullBalanceSize(
    availableBalance: number,
    reserveAmount: number
  ): TradeSizeResult {
    const tradeSizeUsdc = Math.max(0, availableBalance);

    if (tradeSizeUsdc < this.config.minTradeNotional) {
      return {
        tradeSizeUsdc: 0,
        mode: 'FULL_BALANCE',
        reason: `Full balance ${tradeSizeUsdc.toFixed(2)} below minimum ${this.config.minTradeNotional}`,
        details: {
          availableBalance,
          reserveAmount,
          realizedGains: null,
          compoundedAmount: null,
        },
      };
    }

    logger.info('Full balance trade size calculated', {
      tradeSizeUsdc,
      availableBalance,
      reserveAmount,
    });

    return {
      tradeSizeUsdc,
      mode: 'FULL_BALANCE',
      reason: `Full balance: $${tradeSizeUsdc.toFixed(2)} (reserve: $${reserveAmount.toFixed(2)})`,
      details: {
        availableBalance,
        reserveAmount,
        realizedGains: null,
        compoundedAmount: null,
      },
    };
  }

  /**
   * CALCULATED mode: Initial size + portion of realized gains
   *
   * Formula: tradeSize = initialSize + (realizedGains * (1 - reservePct))
   * This allows profits to compound while maintaining a safety buffer
   */
  private calculateCompoundedSize(
    availableBalance: number,
    reserveAmount: number,
    dailyRealizedPnl: number,
    totalRealizedPnl: number
  ): TradeSizeResult {
    // Use initialTradeSizeUsdc if set, otherwise fall back to fixedTradeSize
    const baseSize = this.config.initialTradeSizeUsdc ?? this.config.fixedTradeSize;

    // Only compound positive gains
    const gains = safeMax(0, totalRealizedPnl);

    // Apply reserve percentage to gains
    const compoundablePct = safeSubtract(100, this.config.reservePct) / 100;
    const compoundedAmount = safeMultiply(gains, compoundablePct);

    // Calculate total trade size
    let tradeSizeUsdc = safeAdd(baseSize, compoundedAmount);

    // Cap at available balance
    tradeSizeUsdc = Math.min(tradeSizeUsdc, availableBalance);

    // Enforce minimum
    if (tradeSizeUsdc < this.config.minTradeNotional) {
      return {
        tradeSizeUsdc: 0,
        mode: 'CALCULATED',
        reason: `Calculated size ${tradeSizeUsdc.toFixed(2)} below minimum ${this.config.minTradeNotional}`,
        details: {
          availableBalance,
          reserveAmount,
          realizedGains: gains,
          compoundedAmount,
        },
      };
    }

    logger.info('Compounded trade size calculated', {
      baseSize,
      totalRealizedPnl,
      compoundedAmount,
      tradeSizeUsdc,
      availableBalance,
    });

    return {
      tradeSizeUsdc,
      mode: 'CALCULATED',
      reason: `Compounded: $${baseSize.toFixed(2)} base + $${compoundedAmount.toFixed(2)} gains = $${tradeSizeUsdc.toFixed(2)}`,
      details: {
        availableBalance,
        reserveAmount,
        realizedGains: gains,
        compoundedAmount,
      },
    };
  }

  /**
   * Get the effective trade size for a SELL order
   * For sells, we typically sell the entire position or a portion (scale-out)
   * This method calculates the quote value of a base amount sale
   */
  calculateSellValue(
    baseAmount: number,
    currentPrice: number
  ): number {
    return safeMultiply(baseAmount, currentPrice);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CompoundingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CompoundingConfig {
    return { ...this.config };
  }
}

/**
 * Format compounding result for logging
 */
export function formatCompoundingLog(result: TradeSizeResult): string {
  const details = result.details.compoundedAmount !== null
    ? ` | Gains: $${result.details.realizedGains?.toFixed(2)} -> Compounded: $${result.details.compoundedAmount.toFixed(2)}`
    : '';
  return `[${result.mode}] Size: $${result.tradeSizeUsdc.toFixed(2)} | Available: $${result.details.availableBalance.toFixed(2)}${details}`;
}
