import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@autobot/db';
import { PnLCalculator } from '@autobot/core';
import { getAdapter } from '../services/adapter-factory.js';

const DateRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const pnlRoutes: FastifyPluginAsync = async (fastify) => {
  // Get PnL summary for an instance
  fastify.get<{ Params: { instanceId: string } }>(
    '/bots/:instanceId/pnl',
    async (request, reply) => {
      const instance = await prisma.botInstance.findUnique({
        where: { id: request.params.instanceId },
        include: { config: true },
      });

      if (!instance) {
        return reply.notFound('Bot instance not found');
      }

      // Get current balances and price
      let balances = { base: 0, quote: 0 };
      let currentPrice = 0;

      try {
        const adapter = getAdapter(instance.config.chain, instance.id);
        balances = await adapter.getBalances();

        const quote = await adapter.getQuote({
          side: 'BUY',
          amount: instance.config.minTradeNotional,
          amountIsBase: false,
          slippageBps: instance.config.maxSlippageBps,
          allowedSources: instance.config.allowedSources,
          excludedSources: instance.config.excludedSources,
        });
        currentPrice = quote.price;
      } catch {
        // Use last known price if available
        currentPrice = instance.lastBuyPrice ?? instance.lastSellPrice ?? 0;
      }

      const pnlCalculator = new PnLCalculator(instance.config.pnlMethod);
      const pnl = pnlCalculator.calculatePnLSummary(
        instance.totalBaseQty,
        instance.totalBaseCost,
        balances.quote,
        currentPrice,
        0 // We'll calculate total realized below
      );

      // Get total realized PnL from all fills
      const fills = await prisma.tradeFill.aggregate({
        where: {
          attempt: {
            instanceId: request.params.instanceId,
          },
          side: 'SELL',
        },
        _sum: {
          realizedPnl: true,
          feeNativeUsdc: true,
        },
      });

      const totalRealizedPnl = fills._sum.realizedPnl ?? 0;
      const totalFees = fills._sum.feeNativeUsdc ?? 0;

      return {
        realizedPnl: totalRealizedPnl,
        unrealizedPnl: pnl.unrealizedPnl,
        totalPnl: totalRealizedPnl + pnl.unrealizedPnl,
        costBasis: pnl.costBasis,
        portfolioValue: pnl.portfolioValue,
        totalFees,
        netPnl: totalRealizedPnl + pnl.unrealizedPnl - totalFees,
        balances,
        currentPrice,
        dailyRealizedPnl: instance.dailyRealizedPnl,
      };
    }
  );

  // Get daily PnL snapshots
  fastify.get<{
    Params: { instanceId: string };
    Querystring: z.infer<typeof DateRangeSchema>;
  }>('/bots/:instanceId/pnl/daily', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.instanceId },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    const query = DateRangeSchema.parse(request.query);

    const where: Record<string, unknown> = {
      instanceId: request.params.instanceId,
    };

    if (query.startDate || query.endDate) {
      where.date = {};
      if (query.startDate) {
        (where.date as Record<string, Date>).gte = new Date(query.startDate);
      }
      if (query.endDate) {
        (where.date as Record<string, Date>).lte = new Date(query.endDate);
      }
    }

    const snapshots = await prisma.pnLSnapshot.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 30,
    });

    return snapshots;
  });

  // Get position history
  fastify.get<{
    Params: { instanceId: string };
    Querystring: { limit?: string };
  }>('/bots/:instanceId/positions', async (request, reply) => {
    const instance = await prisma.botInstance.findUnique({
      where: { id: request.params.instanceId },
    });

    if (!instance) {
      return reply.notFound('Bot instance not found');
    }

    const limit = Math.min(parseInt(request.query.limit ?? '100', 10), 500);

    const snapshots = await prisma.positionSnapshot.findMany({
      where: { instanceId: request.params.instanceId },
      orderBy: { snapshotAt: 'desc' },
      take: limit,
    });

    return snapshots;
  });

  // Export trades to CSV
  fastify.get<{ Params: { instanceId: string } }>(
    '/bots/:instanceId/export/csv',
    async (request, reply) => {
      const instance = await prisma.botInstance.findUnique({
        where: { id: request.params.instanceId },
        include: { config: true },
      });

      if (!instance) {
        return reply.notFound('Bot instance not found');
      }

      const fills = await prisma.tradeFill.findMany({
        where: {
          attempt: {
            instanceId: request.params.instanceId,
          },
        },
        include: {
          attempt: {
            select: {
              clientOrderId: true,
              quotePrice: true,
            },
          },
        },
        orderBy: { executedAt: 'asc' },
      });

      // Build CSV
      const headers = [
        'Date',
        'Side',
        'Base Qty',
        'Quote Qty',
        'Price',
        'Fee (USDC)',
        'Realized PnL',
        'Tx Hash',
      ];

      const rows = fills.map((fill) => [
        fill.executedAt.toISOString(),
        fill.side,
        fill.baseQty.toFixed(8),
        fill.quoteQty.toFixed(2),
        fill.executedPrice.toFixed(6),
        fill.feeNativeUsdc.toFixed(4),
        fill.realizedPnl?.toFixed(2) ?? '',
        fill.txSignature,
      ]);

      const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header(
        'Content-Disposition',
        `attachment; filename="trades-${instance.config.name}-${new Date().toISOString().split('T')[0]}.csv"`
      );

      return csv;
    }
  );
};
