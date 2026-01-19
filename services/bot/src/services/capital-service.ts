/**
 * CapitalService - Persistence layer for capital allocation
 *
 * This service bridges the in-memory CapitalAllocator with the database,
 * ensuring capital allocations are persisted and can be restored on restart.
 */

import { prisma } from '@autobot/db';
import {
  CapitalAllocator,
  type BotCapitalState,
  type TradePlan,
  type CapitalCheckResult,
  type WalletGuardrailResult,
  Logger,
} from '@autobot/core';

const logger = new Logger('CapitalService');

// Global capital allocator instance (per-process singleton)
let allocatorInstance: CapitalAllocator | null = null;

/**
 * Get or create the capital allocator instance
 */
export function getCapitalAllocator(): CapitalAllocator {
  if (!allocatorInstance) {
    allocatorInstance = new CapitalAllocator({
      minProfitForSellUSDC: 0.01,
      feeBufferMultiplier: 1.2,
      minWalletReserveUSDC: 5.0,
      minWalletReserveSOL: 0.01,
      strictMode: true,
    });
  }
  return allocatorInstance;
}

/**
 * Initialize capital allocation for a bot from database state
 * Call this when starting a bot worker
 */
export async function initializeBotCapital(instanceId: string): Promise<BotCapitalState | null> {
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
    include: { config: true },
  });

  if (!instance) {
    logger.error('Cannot initialize capital - instance not found', { instanceId });
    return null;
  }

  const allocator = getCapitalAllocator();

  // Check if capital isolation is enabled for this bot
  const initialCapital = instance.config.initialCapitalUSDC;

  if (initialCapital === null || initialCapital === undefined) {
    // Capital isolation not enabled - bot uses full wallet (legacy mode)
    logger.info('Capital isolation not enabled for bot (legacy mode)', { instanceId });
    return null;
  }

  // Initialize or restore allocation from database state
  const allocation: Partial<BotCapitalState> = {
    allocatedUSDC: instance.allocatedUSDC,
    allocatedSOL: instance.allocatedSOL,
    reservedUSDCForFees: instance.reservedUSDCForFees,
    pendingBuyUSDC: instance.pendingBuyUSDC,
    pendingSellSOL: instance.pendingSellSOL,
    realizedPnL: instance.cumulativeRealizedPnL,
    unrealizedPnL: 0, // Will be calculated from current price
    totalBaseCost: instance.totalBaseCost,
    totalBaseQty: instance.totalBaseQty,
  };

  // If this is a fresh bot with no allocation, initialize with initial capital
  if (instance.allocatedUSDC === 0 && instance.allocatedSOL === 0 && instance.totalBaseQty === 0) {
    allocation.allocatedUSDC = initialCapital;
    allocation.allocatedSOL = 0;

    // Persist the initial allocation
    await prisma.botInstance.update({
      where: { id: instanceId },
      data: {
        allocatedUSDC: initialCapital,
        allocatedSOL: 0,
      },
    });

    logger.info('Initial capital allocated', {
      instanceId,
      initialCapitalUSDC: initialCapital,
    });
  }

  allocator.setAllocation(instanceId, allocation);

  logger.info('Bot capital initialized', {
    instanceId,
    allocatedUSDC: allocation.allocatedUSDC,
    allocatedSOL: allocation.allocatedSOL,
    totalBaseCost: allocation.totalBaseCost,
    totalBaseQty: allocation.totalBaseQty,
  });

  return allocator.getAllocation(instanceId) ?? null;
}

/**
 * Check if a trade can be executed (pre-trade validation)
 */
export function checkTradeAllowed(instanceId: string, tradePlan: TradePlan): CapitalCheckResult {
  const allocator = getCapitalAllocator();
  return allocator.canExecute(instanceId, tradePlan);
}

/**
 * Check if capital isolation is enabled for a bot
 */
export async function isCapitalIsolationEnabled(instanceId: string): Promise<boolean> {
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
    include: { config: true },
  });

  if (!instance) return false;

  return instance.config.initialCapitalUSDC !== null;
}

/**
 * Reserve capital before executing a trade
 */
export async function reserveCapitalForTrade(
  instanceId: string,
  tradePlan: TradePlan
): Promise<boolean> {
  const allocator = getCapitalAllocator();

  if (!allocator.reserveCapital(instanceId, tradePlan)) {
    return false;
  }

  // Persist the reservation to database
  const allocation = allocator.getAllocation(instanceId);
  if (allocation) {
    await persistAllocation(instanceId, allocation);
  }

  return true;
}

/**
 * Settle a completed transaction
 */
export async function settleTransaction(
  instanceId: string,
  tradePlan: TradePlan,
  actualResult: {
    success: boolean;
    actualQuoteAmount: number;
    actualBaseAmount: number;
    actualFeeUSDC: number;
    realizedPnL?: number;
  }
): Promise<void> {
  const allocator = getCapitalAllocator();

  allocator.settleTransaction(instanceId, tradePlan, actualResult);

  // Persist updated allocation to database
  const allocation = allocator.getAllocation(instanceId);
  if (allocation) {
    await persistAllocation(instanceId, allocation);
  }
}

/**
 * Update unrealized PnL based on current price
 */
export function updateUnrealizedPnL(instanceId: string, currentPrice: number): void {
  const allocator = getCapitalAllocator();
  allocator.updateUnrealizedPnL(instanceId, currentPrice);
}

/**
 * Check wallet-level guardrail before any trade
 */
export function checkWalletGuardrail(
  actualWalletUSDC: number,
  actualWalletSOL: number
): WalletGuardrailResult {
  const allocator = getCapitalAllocator();
  return allocator.checkWalletGuardrail(actualWalletUSDC, actualWalletSOL);
}

/**
 * Get current allocation for a bot
 */
export function getAllocation(instanceId: string): BotCapitalState | undefined {
  const allocator = getCapitalAllocator();
  return allocator.getAllocation(instanceId);
}

/**
 * Remove allocation when bot is deleted or stopped
 */
export function removeAllocation(instanceId: string): void {
  const allocator = getCapitalAllocator();
  allocator.removeAllocation(instanceId);
}

/**
 * Persist allocation to database
 */
async function persistAllocation(
  instanceId: string,
  allocation: BotCapitalState
): Promise<void> {
  try {
    await prisma.botInstance.update({
      where: { id: instanceId },
      data: {
        allocatedUSDC: allocation.allocatedUSDC,
        allocatedSOL: allocation.allocatedSOL,
        reservedUSDCForFees: allocation.reservedUSDCForFees,
        pendingBuyUSDC: allocation.pendingBuyUSDC,
        pendingSellSOL: allocation.pendingSellSOL,
        cumulativeRealizedPnL: allocation.realizedPnL,
        // Note: totalBaseCost and totalBaseQty are already managed by trading-worker
      },
    });

    logger.debug('Allocation persisted', {
      instanceId,
      allocatedUSDC: allocation.allocatedUSDC,
      allocatedSOL: allocation.allocatedSOL,
    });
  } catch (err) {
    logger.error('Failed to persist allocation', {
      instanceId,
      error: (err as Error).message,
    });
  }
}

/**
 * Sync all running bot allocations from database
 * Call this on server startup to restore state
 */
export async function syncAllAllocations(): Promise<void> {
  const allocator = getCapitalAllocator();

  // Find all running bots with capital isolation enabled
  const runningBots = await prisma.botInstance.findMany({
    where: {
      status: 'RUNNING',
      config: {
        initialCapitalUSDC: { not: null },
      },
    },
    include: { config: true },
  });

  for (const instance of runningBots) {
    const allocation: Partial<BotCapitalState> = {
      allocatedUSDC: instance.allocatedUSDC,
      allocatedSOL: instance.allocatedSOL,
      reservedUSDCForFees: instance.reservedUSDCForFees,
      pendingBuyUSDC: instance.pendingBuyUSDC,
      pendingSellSOL: instance.pendingSellSOL,
      realizedPnL: instance.cumulativeRealizedPnL,
      unrealizedPnL: 0,
      totalBaseCost: instance.totalBaseCost,
      totalBaseQty: instance.totalBaseQty,
    };

    allocator.setAllocation(instance.id, allocation);
  }

  logger.info('Synced allocations from database', {
    botCount: runningBots.length,
  });
}

/**
 * Get summary of all allocations for dashboard
 */
export function getAllocationSummary(): {
  totalAllocatedUSDC: number;
  totalAllocatedSOL: number;
  botCount: number;
  allocations: Array<{ botId: string; allocatedUSDC: number; allocatedSOL: number }>;
} {
  const allocator = getCapitalAllocator();
  const allAllocations = allocator.getAllAllocations();

  let totalAllocatedUSDC = 0;
  let totalAllocatedSOL = 0;
  const allocations: Array<{ botId: string; allocatedUSDC: number; allocatedSOL: number }> = [];

  for (const [botId, allocation] of allAllocations) {
    totalAllocatedUSDC += allocation.allocatedUSDC + allocation.pendingBuyUSDC;
    totalAllocatedSOL += allocation.allocatedSOL + allocation.pendingSellSOL;
    allocations.push({
      botId,
      allocatedUSDC: allocation.allocatedUSDC,
      allocatedSOL: allocation.allocatedSOL,
    });
  }

  return {
    totalAllocatedUSDC,
    totalAllocatedSOL,
    botCount: allAllocations.size,
    allocations,
  };
}
