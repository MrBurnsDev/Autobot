import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@autobot/db';
import { PnLCalculator, Logger } from '@autobot/core';
import { startWorker, stopWorker, isWorkerRunning } from '../workers/trading-worker.js';
import { getAdapter } from '../services/adapter-factory.js';

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

    if (instance.status === 'RUNNING') {
      return reply.badRequest('Bot is already running');
    }

    // Check connectivity before starting
    try {
      const adapter = getAdapter(instance.config.chain, instance.id);
      const connectivity = await adapter.checkConnectivity();

      if (!connectivity.rpcConnected || !connectivity.apiConnected) {
        return reply.badRequest(`Connectivity check failed: ${connectivity.errors.join(', ')}`);
      }
    } catch (err) {
      return reply.badRequest(`Failed to initialize adapter: ${(err as Error).message}`);
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

    if (instance.status !== 'RUNNING') {
      return reply.badRequest('Bot is not running');
    }

    await stopWorker(instance.id, 'Stopped by user');

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
};
