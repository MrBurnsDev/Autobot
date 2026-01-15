import type {
  StrategyConfig,
  StrategyState,
  StrategyAction,
  StrategyContext,
  BalanceInfo,
  TradeSize,
  FillForPnL,
  PnLCalculation,
} from '../types/index.js';
import { CircuitBreakerError } from '../errors/index.js';
import {
  safeMultiply,
  safeDivide,
  safeSubtract,
  safeAdd,
  calculatePercentChange,
  isSameHour,
  isSameDay,
  Logger,
} from '../utils/index.js';

const logger = new Logger('Strategy');

/**
 * Core strategy engine that determines trading actions
 */
export class TradingStrategy {
  constructor(private config: StrategyConfig) {}

  /**
   * Evaluate current conditions and decide on action
   */
  evaluate(context: StrategyContext): StrategyAction {
    const { state, balances, currentPrice, quote } = context;

    // First, check all circuit breakers
    const circuitBreakerCheck = this.checkCircuitBreakers(state, balances, currentPrice);
    if (circuitBreakerCheck) {
      return circuitBreakerCheck;
    }

    // Check cooldown
    if (state.lastTradeAt) {
      const secondsSinceLastTrade = (Date.now() - state.lastTradeAt.getTime()) / 1000;
      if (secondsSinceLastTrade < this.config.cooldownSeconds) {
        return {
          type: 'HOLD',
          reason: `Cooldown active: ${Math.ceil(this.config.cooldownSeconds - secondsSinceLastTrade)}s remaining`,
        };
      }
    }

    // Check hourly rate limit
    const now = new Date();
    let tradesThisHour = state.tradesThisHour;
    if (!isSameHour(state.hourlyResetAt, now)) {
      tradesThisHour = 0;
    }
    if (tradesThisHour >= this.config.maxTradesPerHour) {
      return {
        type: 'HOLD',
        reason: `Hourly trade limit reached: ${tradesThisHour}/${this.config.maxTradesPerHour}`,
      };
    }

    // Check price impact
    if (
      this.config.maxPriceImpactBps !== null &&
      quote.priceImpactBps !== null &&
      quote.priceImpactBps > this.config.maxPriceImpactBps
    ) {
      return {
        type: 'HOLD',
        reason: `Price impact too high: ${quote.priceImpactBps} bps > ${this.config.maxPriceImpactBps} bps`,
      };
    }

    // Determine if we should buy or sell based on reference prices
    const action = this.determineAction(state, currentPrice, balances);
    return action;
  }

  /**
   * Determine trading action based on price thresholds
   */
  private determineAction(
    state: StrategyState,
    currentPrice: number,
    balances: BalanceInfo
  ): StrategyAction {
    const { lastBuyPrice, lastSellPrice } = state;

    // Bootstrap case: no reference prices yet
    if (lastBuyPrice === null && lastSellPrice === null) {
      return this.handleBootstrap(balances);
    }

    // Check SELL condition: price rose above threshold from last buy
    if (lastBuyPrice !== null) {
      const sellThreshold = safeMultiply(lastBuyPrice, 1 + this.config.sellRisePct / 100);
      if (currentPrice >= sellThreshold) {
        const size = this.calculateTradeSize('SELL', balances);
        if (size) {
          const pctChange = calculatePercentChange(lastBuyPrice, currentPrice);
          return {
            type: 'SELL',
            reason: `Price rose ${pctChange.toFixed(2)}% from last buy (${lastBuyPrice.toFixed(4)} -> ${currentPrice.toFixed(4)})`,
            size,
          };
        }
        return {
          type: 'HOLD',
          reason: 'Sell signal but insufficient base balance or below minimum',
        };
      }
    }

    // Check BUY condition: price dropped below threshold from last sell
    if (lastSellPrice !== null) {
      const buyThreshold = safeMultiply(lastSellPrice, 1 - this.config.buyDipPct / 100);
      if (currentPrice <= buyThreshold) {
        const size = this.calculateTradeSize('BUY', balances);
        if (size) {
          const pctChange = calculatePercentChange(lastSellPrice, currentPrice);
          return {
            type: 'BUY',
            reason: `Price dropped ${Math.abs(pctChange).toFixed(2)}% from last sell (${lastSellPrice.toFixed(4)} -> ${currentPrice.toFixed(4)})`,
            size,
          };
        }
        return {
          type: 'HOLD',
          reason: 'Buy signal but insufficient quote balance or below minimum',
        };
      }
    }

    // No action threshold met
    return {
      type: 'HOLD',
      reason: this.generateHoldReason(state, currentPrice),
    };
  }

  /**
   * Handle bootstrap case when bot has no trade history
   */
  private handleBootstrap(balances: BalanceInfo): StrategyAction {
    switch (this.config.startingMode) {
      case 'START_BY_BUYING': {
        const size = this.calculateTradeSize('BUY', balances);
        if (size) {
          return {
            type: 'BUY',
            reason: 'Initial buy to bootstrap strategy',
            size,
          };
        }
        return {
          type: 'HOLD',
          reason: 'Configured to start by buying but insufficient quote balance',
        };
      }

      case 'START_BY_SELLING': {
        const size = this.calculateTradeSize('SELL', balances);
        if (size) {
          return {
            type: 'SELL',
            reason: 'Initial sell to bootstrap strategy',
            size,
          };
        }
        return {
          type: 'HOLD',
          reason: 'Configured to start by selling but insufficient base balance',
        };
      }

      case 'START_NEUTRAL':
      default:
        return {
          type: 'HOLD',
          reason: 'Waiting for manual trade to establish reference price',
        };
    }
  }

  /**
   * Calculate trade size based on configuration
   */
  calculateTradeSize(side: 'BUY' | 'SELL', balances: BalanceInfo): TradeSize | null {
    let baseAmount: number | undefined;
    let quoteAmount: number | undefined;

    switch (this.config.tradeSizeMode) {
      case 'FIXED_QUOTE':
        if (side === 'BUY') {
          quoteAmount = this.config.tradeSize;
        } else {
          // For SELL with FIXED_QUOTE: sell all available base (quote validation at execution)
          baseAmount = safeSubtract(balances.base, this.config.minBaseReserve);
        }
        break;

      case 'FIXED_BASE':
        baseAmount = this.config.tradeSize;
        break;

      case 'PERCENT_BALANCE':
        if (side === 'BUY') {
          quoteAmount = safeMultiply(balances.quote, this.config.tradeSize / 100);
        } else {
          baseAmount = safeMultiply(balances.base, this.config.tradeSize / 100);
        }
        break;
    }

    // Validate against reserves and minimums
    if (side === 'BUY') {
      const availableQuote = safeSubtract(balances.quote, this.config.minQuoteReserve);
      if (quoteAmount !== undefined) {
        if (quoteAmount > availableQuote) {
          quoteAmount = availableQuote;
        }
        if (quoteAmount < this.config.minTradeNotional) {
          logger.debug('Trade size below minimum', { quoteAmount, minTradeNotional: this.config.minTradeNotional });
          return null;
        }
        return { quoteAmount };
      }
    } else {
      const availableBase = safeSubtract(balances.base, this.config.minBaseReserve);
      if (baseAmount !== undefined) {
        if (baseAmount > availableBase) {
          baseAmount = availableBase;
        }
        // Validate base amount meets minimum notional (rough estimate)
        // Actual validation happens at quote time
        if (baseAmount <= 0) {
          logger.debug('Trade size below zero after reserves', { baseAmount });
          return null;
        }
        return { baseAmount };
      }
    }

    return null;
  }

  /**
   * Check all circuit breaker conditions
   */
  private checkCircuitBreakers(
    state: StrategyState,
    balances: BalanceInfo,
    _currentPrice: number
  ): StrategyAction | null {
    // Check consecutive failures
    if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return {
        type: 'PAUSE',
        reason: `Max consecutive failures reached: ${state.consecutiveFailures}`,
      };
    }

    // Check daily loss limit
    if (this.config.dailyLossLimitUsdc !== null) {
      const now = new Date();
      let dailyPnl = state.dailyRealizedPnl;
      if (!isSameDay(state.dailyResetAt, now)) {
        dailyPnl = 0;
      }
      if (dailyPnl < -this.config.dailyLossLimitUsdc) {
        return {
          type: 'PAUSE',
          reason: `Daily loss limit exceeded: $${Math.abs(dailyPnl).toFixed(2)} > $${this.config.dailyLossLimitUsdc}`,
        };
      }
    }

    // Check gas reserves
    if (balances.nativeForGas < this.config.minBaseReserve * 0.1) {
      return {
        type: 'PAUSE',
        reason: 'Insufficient native token for gas fees',
      };
    }

    return null;
  }

  /**
   * Generate descriptive hold reason
   */
  private generateHoldReason(state: StrategyState, currentPrice: number): string {
    const reasons: string[] = [];

    if (state.lastBuyPrice !== null) {
      const sellThreshold = safeMultiply(state.lastBuyPrice, 1 + this.config.sellRisePct / 100);
      const pctToSell = calculatePercentChange(currentPrice, sellThreshold);
      reasons.push(`${Math.abs(pctToSell).toFixed(2)}% to sell threshold`);
    }

    if (state.lastSellPrice !== null) {
      const buyThreshold = safeMultiply(state.lastSellPrice, 1 - this.config.buyDipPct / 100);
      const pctToBuy = calculatePercentChange(currentPrice, buyThreshold);
      reasons.push(`${Math.abs(pctToBuy).toFixed(2)}% to buy threshold`);
    }

    return reasons.length > 0
      ? `Waiting for threshold: ${reasons.join(', ')}`
      : 'No action required';
  }
}

/**
 * PnL calculator using average cost basis method
 */
export class PnLCalculator {
  private method: 'AVERAGE_COST' | 'FIFO';

  constructor(method: 'AVERAGE_COST' | 'FIFO' = 'AVERAGE_COST') {
    this.method = method;
  }

  /**
   * Calculate realized PnL for a sell trade
   */
  calculateRealizedPnL(
    fill: FillForPnL,
    costBasisPerUnit: number
  ): { realizedPnl: number; costBasis: number } {
    if (fill.side !== 'SELL') {
      return { realizedPnl: 0, costBasis: 0 };
    }

    const proceeds = safeSubtract(fill.quoteQty, fill.feeQuote);
    const costBasis = safeMultiply(fill.baseQty, costBasisPerUnit);
    const realizedPnl = safeSubtract(proceeds, safeAdd(costBasis, fill.feeNativeUsdc));

    return { realizedPnl, costBasis };
  }

  /**
   * Update cost basis after a buy
   */
  updateCostBasis(
    currentTotalCost: number,
    currentTotalQty: number,
    fill: FillForPnL
  ): { newTotalCost: number; newTotalQty: number; newCostBasisPerUnit: number } {
    if (fill.side !== 'BUY') {
      return {
        newTotalCost: currentTotalCost,
        newTotalQty: currentTotalQty,
        newCostBasisPerUnit: currentTotalQty > 0 ? safeDivide(currentTotalCost, currentTotalQty) : 0,
      };
    }

    // Total cost includes quote spent plus fees
    const tradeCost = safeAdd(fill.quoteQty, fill.feeNativeUsdc);
    const newTotalCost = safeAdd(currentTotalCost, tradeCost);
    const newTotalQty = safeAdd(currentTotalQty, fill.baseQty);
    const newCostBasisPerUnit = safeDivide(newTotalCost, newTotalQty);

    return { newTotalCost, newTotalQty, newCostBasisPerUnit };
  }

  /**
   * Update position after a sell
   */
  updatePositionAfterSell(
    currentTotalCost: number,
    currentTotalQty: number,
    fill: FillForPnL
  ): { newTotalCost: number; newTotalQty: number } {
    if (fill.side !== 'SELL') {
      return { newTotalCost: currentTotalCost, newTotalQty: currentTotalQty };
    }

    const costBasisPerUnit = currentTotalQty > 0 ? safeDivide(currentTotalCost, currentTotalQty) : 0;
    const costRemoved = safeMultiply(fill.baseQty, costBasisPerUnit);
    const newTotalCost = Math.max(0, safeSubtract(currentTotalCost, costRemoved));
    const newTotalQty = Math.max(0, safeSubtract(currentTotalQty, fill.baseQty));

    return { newTotalCost, newTotalQty };
  }

  /**
   * Calculate unrealized PnL
   */
  calculateUnrealizedPnL(
    totalBaseQty: number,
    totalBaseCost: number,
    currentPrice: number
  ): number {
    if (totalBaseQty <= 0) return 0;
    const marketValue = safeMultiply(totalBaseQty, currentPrice);
    return safeSubtract(marketValue, totalBaseCost);
  }

  /**
   * Calculate complete PnL summary
   */
  calculatePnLSummary(
    totalBaseQty: number,
    totalBaseCost: number,
    quoteBalance: number,
    currentPrice: number,
    cumulativeRealizedPnl: number
  ): PnLCalculation {
    const unrealizedPnl = this.calculateUnrealizedPnL(totalBaseQty, totalBaseCost, currentPrice);
    const portfolioValue = safeAdd(safeMultiply(totalBaseQty, currentPrice), quoteBalance);

    return {
      realizedPnl: cumulativeRealizedPnl,
      unrealizedPnl,
      totalPnl: safeAdd(cumulativeRealizedPnl, unrealizedPnl),
      costBasis: totalBaseCost,
      portfolioValue,
    };
  }
}
