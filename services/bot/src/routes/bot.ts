import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@autobot/db';
import { PnLCalculator, Logger } from '@autobot/core';
import { startWorker, stopWorker, isWorkerRunning, getPriceHistory, executeManualTrade } from '../workers/trading-worker.js';
import { getAdapter } from '../services/adapter-factory.js';
import { getAllocation, getAllocationSummary, isCapitalIsolationEnabled } from '../services/capital-service.js';

const logger = new Logger('BotRoutes');

export const botRoutes: FastifyPluginAsync = async (fastify) => {
  // List all bot instances
  fastify.get('/bots', async () => {
    const instances = await prisma.botInstance.findMany({
      include: {
        config: {
          select: {
            id: true,
            name: true,
            chain: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return instances;
  });

  // Get single bot instance with details
  fastify.get<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
      include: {
        config: true,
        tradeAttempts: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { fill: true },
        },
        positionSnapshots: {
          take: 1,
          orderBy: { snapshotAt: 'desc' },
        },
      },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    return instance;
  });

  // Create bot instance from config
  fastify.post<{ Body: { configId: string } }>('/bots', async (request, reply) => {
    const { configId } = request.body;

    const config = await prisma.botConfig.findUnique({
      where: { id: configId },
    });

    if (!config) {
      return reply.notFound('Config not found');
    }

    // Check if there's already an instance for this config
    const existingInstance = await prisma.botInstance.findFirst({
      where: {
        configId,
        status: { in: ['RUNNING', 'PAUSED'] },
      },
    });

    if (existingInstance) {
      return reply.badRequest('An active instance already exists for this config');
    }

    const instance = await prisma.botInstance.create({
      data: {
        configId,
        status: 'STOPPED',
      },
      include: { config: true },
    });

    return reply.code(201).send(instance);
  });

  // Start bot
  fastify.post<{ Params: { id: string } }>('/bots/:id/start', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
      include: { config: true },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    if (instance.status === 'RUNNING' && isWorkerRunning(instance.id)) {
      // Return success for idempotency - already in desired state
      return instance;
    }

    // Check connectivity before starting
    let adapter;
    try {
      adapter = getAdapter(instance.config.chain, instance.id);
      const connectivity = await adapter.checkConnectivity();

      if (!connectivity.rpcConnected || !connectivity.apiConnected) {
        return reply.badRequest(`Connectivity check failed: ${connectivity.errors.join(', ')}`);
      }
    } catch (err) {
      return reply.badRequest(`Failed to initialize adapter: ${(err as Error).message}`);
    }

    // Preflight capital check if capital isolation is enabled
    if (instance.config.initialCapitalUSDC !== null) {
      try {
        // Get actual wallet balance
        const balances = await adapter.getBalances();
        const walletUSDC = balances.quote;

        // Get sum of all active bot allocations (excluding this bot if already allocated)
        const activeBots = await prisma.botInstance.findMany({
          where: {
            status: { in: ['RUNNING', 'PAUSED'] },
            id: { not: instance.id },
            config: {
              initialCapitalUSDC: { not: null },
            },
          },
          include: { config: true },
        });

        const otherAllocations = activeBots.reduce((sum, bot) => {
          return sum + (bot.config.initialCapitalUSDC ?? 0);
        }, 0);

        const thisAllocation = instance.config.initialCapitalUSDC;
        const totalRequired = otherAllocations + thisAllocation;
        const feeBuffer = 5; // $5 buffer for fees

        if (walletUSDC < totalRequired + feeBuffer) {
          return reply.badRequest(
            `Insufficient wallet balance for allocated capital. ` +
            `Wallet: $${walletUSDC.toFixed(2)} USDC, ` +
            `Required: $${totalRequired.toFixed(2)} + $${feeBuffer} buffer = $${(totalRequired + feeBuffer).toFixed(2)}. ` +
            `Other active bots: $${otherAllocations.toFixed(2)}, This bot: $${thisAllocation.toFixed(2)}`
          );
        }

        logger.info('Capital preflight check passed', {
          instanceId: instance.id,
          walletUSDC,
          totalRequired,
          thisAllocation,
          otherAllocations,
        });
      } catch (err) {
        logger.warn('Capital preflight check failed, continuing anyway', {
          instanceId: instance.id,
          error: (err as Error).message,
        });
        // Don't block start if we can't check - the wallet guardrail will catch it
      }
    }

    // Start the worker
    await startWorker(instance.id);

    const updated = await prisma.botInstance.findUnique({
      where: { id: instance.id },
      include: { config: true },
    });

    return updated;
  });

  // Stop bot
  fastify.post<{ Params: { id: string } }>('/bots/:id/stop', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    // Check if already stopped (both DB status and worker)
    const workerRunning = isWorkerRunning(instance.id);
    if (instance.status === 'STOPPED' && !workerRunning) {
      // Return success for idempotency - already in desired state
      return instance;
    }

    // Stop the worker if it's running
    if (workerRunning) {
      await stopWorker(instance.id, 'Stopped by user');
    } else {
      // Worker not running but DB shows RUNNING/PAUSED - sync the state
      // This can happen after container restart
      await prisma.botInstance.update({
        where: { id: instance.id },
        data: {
          status: 'STOPPED',
          pauseReason: 'Stopped by user (state sync)',
        },
      });
    }

    const updated = await prisma.botInstance.findUnique({
      where: { id: instance.id },
    });

    return updated;
  });

  // Get bot status with live data
  fastify.get<{ Params: { id: string } }>('/bots/:id/status', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
      include: { config: true },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    // Get current balances and price if possible
    let balances = null;
    let currentPrice = null;
    let connectivity = null;

    try {
      const adapter = getAdapter(instance.config.chain, instance.id);
      connectivity = await adapter.checkConnectivity();

      if (connectivity.rpcConnected) {
        balances = await adapter.getBalances();

        if (connectivity.apiConnected) {
          const quote = await adapter.getQuote({
            side: 'BUY',
            amount: instance.config.minTradeNotional,
            amountIsBase: false,
            slippageBps: instance.config.maxSlippageBps,
            allowedSources: instance.config.allowedSources,
            excludedSources: instance.config.excludedSources,
          });
          currentPrice = quote.price;
        }
      }
    } catch (err) {
      logger.warn('Failed to get live data', { error: (err as Error).message });
    }

    // Calculate PnL
    const pnlCalculator = new PnLCalculator(instance.config.pnlMethod);
    const pnl = currentPrice
      ? pnlCalculator.calculatePnLSummary(
          instance.totalBaseQty,
          instance.totalBaseCost,
          balances?.quote ?? 0,
          currentPrice,
          instance.dailyRealizedPnl
        )
      : null;

    // Calculate next action thresholds
    let nextBuyThreshold = null;
    let nextSellThreshold = null;

    if (instance.lastSellPrice) {
      nextBuyThreshold = instance.lastSellPrice * (1 - instance.config.buyDipPct / 100);
    }
    if (instance.lastBuyPrice) {
      nextSellThreshold = instance.lastBuyPrice * (1 + instance.config.sellRisePct / 100);
    }

    return {
      instance,
      isWorkerRunning: isWorkerRunning(instance.id),
      balances,
      currentPrice,
      connectivity,
      pnl,
      thresholds: {
        nextBuyThreshold,
        nextSellThreshold,
      },
    };
  });

  // Get price history for live chart
  fastify.get<{ Params: { id: string } }>('/bots/:id/prices', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
      select: { id: true, config: { select: { chain: true } } },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    const history = getPriceHistory(instance.id);
    return {
      chain: instance.config.chain,
      pair: instance.config.chain === 'SOLANA' ? 'SOL/USDC' : 'AVAX/USDC',
      prices: history,
    };
  });

  // Manual trade execution (for testing)
  fastify.post<{ Params: { id: string }; Body: { side: 'BUY' | 'SELL' } }>(
    '/bots/:id/trade',
    async (request, reply) => {
      const { side } = request.body;

      if (!side || !['BUY', 'SELL'].includes(side)) {
        return reply.badRequest('Invalid side. Must be BUY or SELL');
      }

      const instance = await prisma.botInstance.findUnique({
        where: { id: request.params.id },
      });

      if (!instance) {
        return reply.notFound('Bot instance not found');
      }

      const result = await executeManualTrade(instance.id, side);

      if (!result.success) {
        return reply.badRequest(result.message);
      }

      return result;
    }
  );

  // Delete bot instance
  fastify.delete<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    if (instance.status === 'RUNNING') {
      await stopWorker(instance.id, 'Instance deleted');
    }

    await prisma.botInstance.delete({
      where: { id: instance.id },
    });

    return reply.code(204).send();
  });

  // Get capital allocation for a bot
  fastify.get<{ Params: { id: string } }>('/bots/:id/capital', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.id },
      include: { config: true },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    const capitalEnabled = await isCapitalIsolationEnabled(request.params.id);

    if (!capitalEnabled) {
      return {
        enabled: false,
        message: 'Capital isolation not enabled for this bot (using full wallet balance)',
        initialCapitalUSDC: null,
      };
    }

    const allocation = getAllocation(request.params.id);

    return {
      enabled: true,
      initialCapitalUSDC: instance.config.initialCapitalUSDC,
      allocation: allocation ?? {
        allocatedUSDC: instance.allocatedUSDC,
        allocatedSOL: instance.allocatedSOL,
        reservedUSDCForFees: instance.reservedUSDCForFees,
        pendingBuyUSDC: instance.pendingBuyUSDC,
        pendingSellSOL: instance.pendingSellSOL,
        cumulativeRealizedPnL: instance.cumulativeRealizedPnL,
        totalBaseCost: instance.totalBaseCost,
        totalBaseQty: instance.totalBaseQty,
      },
    };
  });

  // Get capital allocation summary across all bots
  fastify.get('/capital/summary', async () => {
    return getAllocationSummary();
  });
};
