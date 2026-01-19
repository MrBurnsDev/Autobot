/**
 * CapitalAllocator - Capital Isolation and Internal Accounting
 *
 * This module implements virtual wallet accounting for multiple bots sharing a single on-chain wallet.
 * It enforces solvency rules to ensure no bot can spend another's capital or unrealized profits.
 *
 * Key Rules:
 * 1. BUY: Bot must have sufficient allocated USDC minus reserved fees
 * 2. SELL: Only allowed if NET PROFITABLE after fees
 * 3. Fees are accounted BEFORE execution
 * 4. "NO L" invariant: sells must be net profitable
 */

import { Logger } from '../utils/index.js';

const logger = new Logger('CapitalAllocator');

// ============================================================================
// Types
// ============================================================================

/**
 * Per-bot capital allocation state
 */
export interface BotCapitalState {
  botId: string;

  // Allocated capital (virtual balance)
  allocatedUSDC: number;
  allocatedSOL: number;

  // Reserved for pending transactions
  reservedUSDCForFees: number;
  pendingBuyUSDC: number;
  pendingSellSOL: number;

  // PnL tracking
  realizedPnL: number;
  unrealizedPnL: number;

  // Cost basis for position
  totalBaseCost: number; // Total USDC spent on current SOL holdings
  totalBaseQty: number; // Current SOL quantity held

  // Timestamp of last update
  lastUpdated: Date;
}

/**
 * Trade plan for solvency check
 */
export interface TradePlan {
  side: 'BUY' | 'SELL';
  quoteAmount: number; // USDC amount (spent for BUY, received for SELL)
  baseAmount: number; // SOL amount (received for BUY, sold for SELL)
  estimatedFeeUSDC: number; // Estimated total execution cost in USDC
  currentPrice: number; // Current market price
}

/**
 * Result of capital allocation check
 */
export interface CapitalCheckResult {
  allowed: boolean;
  reason: string;

  // Detailed breakdown
  details: {
    // For BUY
    availableUSDC?: number;
    requiredUSDC?: number;
    reservedForFees?: number;

    // For SELL
    costBasis?: number;
    expectedProceeds?: number;
    expectedFees?: number;
    expectedNetProfit?: number;
    minProfitRequired?: number;

    // General
    currentAllocation?: BotCapitalState;
  };
}

/**
 * Wallet-level check result
 */
export interface WalletGuardrailResult {
  safe: boolean;
  reason: string;

  details: {
    totalAllocatedUSDC: number;
    totalAllocatedSOL: number;
    actualWalletUSDC: number;
    actualWalletSOL: number;
    usdcSurplus: number;
    solSurplus: number;
  };
}

/**
 * Capital allocator configuration
 */
export interface CapitalAllocatorConfig {
  // Minimum profit required for sells (in USDC)
  minProfitForSellUSDC: number;

  // Fee buffer multiplier (e.g., 1.2 = 20% buffer on fee estimates)
  feeBufferMultiplier: number;

  // Minimum reserve to keep in wallet (USDC)
  minWalletReserveUSDC: number;

  // Minimum reserve to keep in wallet (SOL) for gas
  minWalletReserveSOL: number;

  // Enable strict mode (reject trades on any discrepancy)
  strictMode: boolean;
}

export const DEFAULT_CAPITAL_ALLOCATOR_CONFIG: CapitalAllocatorConfig = {
  minProfitForSellUSDC: 0.01, // $0.01 minimum profit
  feeBufferMultiplier: 1.2, // 20% buffer on fees
  minWalletReserveUSDC: 5.0, // $5 minimum USDC reserve
  minWalletReserveSOL: 0.01, // 0.01 SOL for gas
  strictMode: true,
};

// ============================================================================
// CapitalAllocator Class
// ============================================================================

export class CapitalAllocator {
  private config: CapitalAllocatorConfig;
  private allocations: Map<string, BotCapitalState>;

  constructor(config: Partial<CapitalAllocatorConfig> = {}) {
    this.config = { ...DEFAULT_CAPITAL_ALLOCATOR_CONFIG, ...config };
    this.allocations = new Map();
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Check if a trade can be executed given capital constraints
   * This is the main entry point for pre-trade validation
   */
  canExecute(botId: string, tradePlan: TradePlan): CapitalCheckResult {
    const allocation = this.getAllocation(botId);

    if (!allocation) {
      return {
        allowed: false,
        reason: 'No capital allocation found for bot',
        details: {},
      };
    }

    if (tradePlan.side === 'BUY') {
      return this.checkBuyAllowed(allocation, tradePlan);
    } else {
      return this.checkSellAllowed(allocation, tradePlan);
    }
  }

  /**
   * Reserve capital for a pending transaction
   * Call this BEFORE executing the trade
   */
  reserveCapital(botId: string, tradePlan: TradePlan): boolean {
    const allocation = this.getAllocation(botId);
    if (!allocation) return false;

    const check = this.canExecute(botId, tradePlan);
    if (!check.allowed) {
      logger.warn('Cannot reserve capital - check failed', {
        botId,
        reason: check.reason,
      });
      return false;
    }

    const feeWithBuffer = tradePlan.estimatedFeeUSDC * this.config.feeBufferMultiplier;

    if (tradePlan.side === 'BUY') {
      allocation.pendingBuyUSDC += tradePlan.quoteAmount;
      allocation.reservedUSDCForFees += feeWithBuffer;
    } else {
      allocation.pendingSellSOL += tradePlan.baseAmount;
      allocation.reservedUSDCForFees += feeWithBuffer;
    }

    allocation.lastUpdated = new Date();
    this.allocations.set(botId, allocation);

    logger.info('Capital reserved', {
      botId,
      side: tradePlan.side,
      amount: tradePlan.side === 'BUY' ? tradePlan.quoteAmount : tradePlan.baseAmount,
      feeReserved: feeWithBuffer,
    });

    return true;
  }

  /**
   * Settle a completed transaction
   * Call this AFTER the trade is confirmed
   */
  settleTransaction(
    botId: string,
    tradePlan: TradePlan,
    actualResult: {
      success: boolean;
      actualQuoteAmount: number;
      actualBaseAmount: number;
      actualFeeUSDC: number;
      realizedPnL?: number;
    }
  ): void {
    const allocation = this.getAllocation(botId);
    if (!allocation) {
      logger.error('Cannot settle - no allocation found', { botId });
      return;
    }

    // Release reserved capital
    const feeWithBuffer = tradePlan.estimatedFeeUSDC * this.config.feeBufferMultiplier;

    if (tradePlan.side === 'BUY') {
      allocation.pendingBuyUSDC = Math.max(0, allocation.pendingBuyUSDC - tradePlan.quoteAmount);
    } else {
      allocation.pendingSellSOL = Math.max(0, allocation.pendingSellSOL - tradePlan.baseAmount);
    }
    allocation.reservedUSDCForFees = Math.max(0, allocation.reservedUSDCForFees - feeWithBuffer);

    if (actualResult.success) {
      if (tradePlan.side === 'BUY') {
        // BUY: Spent USDC, received SOL
        allocation.allocatedUSDC -= actualResult.actualQuoteAmount + actualResult.actualFeeUSDC;
        allocation.allocatedSOL += actualResult.actualBaseAmount;

        // Update cost basis
        allocation.totalBaseCost += actualResult.actualQuoteAmount + actualResult.actualFeeUSDC;
        allocation.totalBaseQty += actualResult.actualBaseAmount;
      } else {
        // SELL: Sold SOL, received USDC
        const soldQty = actualResult.actualBaseAmount;
        const proceeds = actualResult.actualQuoteAmount - actualResult.actualFeeUSDC;

        // Calculate proportional cost basis
        const costBasisPerUnit =
          allocation.totalBaseQty > 0 ? allocation.totalBaseCost / allocation.totalBaseQty : 0;
        const costBasisSold = costBasisPerUnit * soldQty;

        allocation.allocatedSOL -= soldQty;
        allocation.allocatedUSDC += proceeds;

        // Update cost basis (remove sold portion)
        allocation.totalBaseCost = Math.max(0, allocation.totalBaseCost - costBasisSold);
        allocation.totalBaseQty = Math.max(0, allocation.totalBaseQty - soldQty);

        // Update realized PnL
        if (actualResult.realizedPnL !== undefined) {
          allocation.realizedPnL += actualResult.realizedPnL;
        }
      }

      logger.info('Transaction settled', {
        botId,
        side: tradePlan.side,
        quoteAmount: actualResult.actualQuoteAmount,
        baseAmount: actualResult.actualBaseAmount,
        fee: actualResult.actualFeeUSDC,
        newUSDC: allocation.allocatedUSDC,
        newSOL: allocation.allocatedSOL,
      });
    } else {
      logger.warn('Transaction failed - capital released', { botId, side: tradePlan.side });
    }

    allocation.lastUpdated = new Date();
    this.allocations.set(botId, allocation);
  }

  /**
   * Update unrealized PnL based on current market price
   */
  updateUnrealizedPnL(botId: string, currentPrice: number): void {
    const allocation = this.getAllocation(botId);
    if (!allocation) return;

    const marketValue = allocation.totalBaseQty * currentPrice;
    allocation.unrealizedPnL = marketValue - allocation.totalBaseCost;
    allocation.lastUpdated = new Date();

    this.allocations.set(botId, allocation);
  }

  // ==========================================================================
  // Wallet-Level Guardrail
  // ==========================================================================

  /**
   * Check that sum of all bot allocations doesn't exceed actual wallet balance
   * This is the last line of defense before any trade
   */
  checkWalletGuardrail(
    actualWalletUSDC: number,
    actualWalletSOL: number
  ): WalletGuardrailResult {
    let totalAllocatedUSDC = 0;
    let totalAllocatedSOL = 0;

    for (const allocation of this.allocations.values()) {
      totalAllocatedUSDC +=
        allocation.allocatedUSDC +
        allocation.pendingBuyUSDC +
        allocation.reservedUSDCForFees;
      totalAllocatedSOL += allocation.allocatedSOL + allocation.pendingSellSOL;
    }

    // Add minimum reserves
    const requiredUSDC = totalAllocatedUSDC + this.config.minWalletReserveUSDC;
    const requiredSOL = totalAllocatedSOL + this.config.minWalletReserveSOL;

    const usdcSurplus = actualWalletUSDC - requiredUSDC;
    const solSurplus = actualWalletSOL - requiredSOL;

    const safe = usdcSurplus >= 0 && solSurplus >= 0;

    const result: WalletGuardrailResult = {
      safe,
      reason: safe
        ? 'Wallet has sufficient balance for all allocations'
        : `Wallet insufficient: USDC surplus=${usdcSurplus.toFixed(2)}, SOL surplus=${solSurplus.toFixed(4)}`,
      details: {
        totalAllocatedUSDC,
        totalAllocatedSOL,
        actualWalletUSDC,
        actualWalletSOL,
        usdcSurplus,
        solSurplus,
      },
    };

    if (!safe) {
      logger.error('Wallet guardrail FAILED', result.details);
    }

    return result;
  }

  // ==========================================================================
  // Allocation Management
  // ==========================================================================

  /**
   * Initialize or update a bot's capital allocation
   */
  setAllocation(botId: string, state: Partial<BotCapitalState>): void {
    const existing = this.allocations.get(botId);

    const allocation: BotCapitalState = {
      botId,
      allocatedUSDC: state.allocatedUSDC ?? existing?.allocatedUSDC ?? 0,
      allocatedSOL: state.allocatedSOL ?? existing?.allocatedSOL ?? 0,
      reservedUSDCForFees: state.reservedUSDCForFees ?? existing?.reservedUSDCForFees ?? 0,
      pendingBuyUSDC: state.pendingBuyUSDC ?? existing?.pendingBuyUSDC ?? 0,
      pendingSellSOL: state.pendingSellSOL ?? existing?.pendingSellSOL ?? 0,
      realizedPnL: state.realizedPnL ?? existing?.realizedPnL ?? 0,
      unrealizedPnL: state.unrealizedPnL ?? existing?.unrealizedPnL ?? 0,
      totalBaseCost: state.totalBaseCost ?? existing?.totalBaseCost ?? 0,
      totalBaseQty: state.totalBaseQty ?? existing?.totalBaseQty ?? 0,
      lastUpdated: new Date(),
    };

    this.allocations.set(botId, allocation);

    logger.info('Allocation set', {
      botId,
      allocatedUSDC: allocation.allocatedUSDC,
      allocatedSOL: allocation.allocatedSOL,
    });
  }

  /**
   * Get a bot's current allocation
   */
  getAllocation(botId: string): BotCapitalState | undefined {
    return this.allocations.get(botId);
  }

  /**
   * Get all allocations
   */
  getAllAllocations(): Map<string, BotCapitalState> {
    return new Map(this.allocations);
  }

  /**
   * Remove a bot's allocation (when bot is deleted)
   */
  removeAllocation(botId: string): boolean {
    return this.allocations.delete(botId);
  }

  /**
   * Clear all allocations (for testing)
   */
  clearAllAllocations(): void {
    this.allocations.clear();
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * RULE 1: BUY Check
   * Bot must have sufficient allocatedUSDC minus:
   * - Reserved fees
   * - Pending buys
   * - The trade amount + estimated fees
   */
  private checkBuyAllowed(
    allocation: BotCapitalState,
    tradePlan: TradePlan
  ): CapitalCheckResult {
    // Available = allocated - reserved - pending
    const availableUSDC =
      allocation.allocatedUSDC -
      allocation.reservedUSDCForFees -
      allocation.pendingBuyUSDC;

    // Required = trade amount + fees with buffer
    const feeWithBuffer = tradePlan.estimatedFeeUSDC * this.config.feeBufferMultiplier;
    const requiredUSDC = tradePlan.quoteAmount + feeWithBuffer;

    const allowed = availableUSDC >= requiredUSDC;

    return {
      allowed,
      reason: allowed
        ? 'Sufficient USDC available for BUY'
        : `Insufficient USDC: available=${availableUSDC.toFixed(2)}, required=${requiredUSDC.toFixed(2)}`,
      details: {
        availableUSDC,
        requiredUSDC,
        reservedForFees: allocation.reservedUSDCForFees,
        currentAllocation: allocation,
      },
    };
  }

  /**
   * RULE 2 + 4: SELL Check
   * - Bot must have sufficient SOL to sell
   * - Sell must be NET PROFITABLE after fees ("NO L" rule)
   */
  private checkSellAllowed(
    allocation: BotCapitalState,
    tradePlan: TradePlan
  ): CapitalCheckResult {
    // Check SOL availability
    const availableSOL = allocation.allocatedSOL - allocation.pendingSellSOL;
    if (availableSOL < tradePlan.baseAmount) {
      return {
        allowed: false,
        reason: `Insufficient SOL: available=${availableSOL.toFixed(4)}, required=${tradePlan.baseAmount.toFixed(4)}`,
        details: {
          currentAllocation: allocation,
        },
      };
    }

    // Calculate cost basis for the portion being sold
    const costBasisPerUnit =
      allocation.totalBaseQty > 0 ? allocation.totalBaseCost / allocation.totalBaseQty : 0;
    const costBasisForSale = costBasisPerUnit * tradePlan.baseAmount;

    // Calculate expected proceeds after fees
    const expectedProceeds = tradePlan.quoteAmount;
    const feeWithBuffer = tradePlan.estimatedFeeUSDC * this.config.feeBufferMultiplier;
    const netProceeds = expectedProceeds - feeWithBuffer;

    // Calculate expected profit
    const expectedNetProfit = netProceeds - costBasisForSale;

    // "NO L" rule: must be net profitable
    const minProfit = this.config.minProfitForSellUSDC;
    const allowed = expectedNetProfit >= minProfit;

    return {
      allowed,
      reason: allowed
        ? `SELL allowed: expected net profit $${expectedNetProfit.toFixed(2)}`
        : `SELL rejected (NO L rule): expected profit $${expectedNetProfit.toFixed(2)} < min $${minProfit.toFixed(2)}`,
      details: {
        costBasis: costBasisForSale,
        expectedProceeds,
        expectedFees: feeWithBuffer,
        expectedNetProfit,
        minProfitRequired: minProfit,
        currentAllocation: allocation,
      },
    };
  }
}

// ============================================================================
// Logging Helper
// ============================================================================

export function formatCapitalCheckLog(result: CapitalCheckResult): string {
  const status = result.allowed ? 'ALLOWED' : 'REJECTED';
  const details = result.details;

  let log = `[${status}] ${result.reason}`;

  if (details.availableUSDC !== undefined) {
    log += ` | Available: $${details.availableUSDC.toFixed(2)}`;
  }
  if (details.requiredUSDC !== undefined) {
    log += ` | Required: $${details.requiredUSDC.toFixed(2)}`;
  }
  if (details.expectedNetProfit !== undefined) {
    log += ` | Expected Profit: $${details.expectedNetProfit.toFixed(2)}`;
  }

  return log;
}

export function formatWalletGuardrailLog(result: WalletGuardrailResult): string {
  const status = result.safe ? 'SAFE' : 'UNSAFE';
  const d = result.details;

  return (
    `[${status}] ${result.reason} | ` +
    `Allocated: $${d.totalAllocatedUSDC.toFixed(2)} USDC, ${d.totalAllocatedSOL.toFixed(4)} SOL | ` +
    `Wallet: $${d.actualWalletUSDC.toFixed(2)} USDC, ${d.actualWalletSOL.toFixed(4)} SOL | ` +
    `Surplus: $${d.usdcSurplus.toFixed(2)} USDC, ${d.solSurplus.toFixed(4)} SOL`
  );
}
