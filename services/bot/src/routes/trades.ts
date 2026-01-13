import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@autobot/db';

const TradesQuerySchema = z.object({
  instanceId: z.string().optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  status: z.enum(['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const tradesRoutes: FastifyPluginAsync = async (fastify) => {
  // List trades
  fastify.get<{ Querystring: z.infer<typeof TradesQuerySchema> }>('/trades', async (request) => {
    const query = TradesQuerySchema.parse(request.query);

    const where: Record<string, unknown> = {};
    if (query.instanceId) where.instanceId = query.instanceId;
    if (query.side) where.side = query.side;
    if (query.status) where.status = query.status;

    const [trades, total] = await Promise.all([
      prisma.tradeAttempt.findMany({
        where,
        include: {
          fill: true,
          instance: {
            select: {
              config: {
                select: {
                  name: true,
                  chain: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.tradeAttempt.count({ where }),
    ]);

    return {
      trades,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + trades.length < total,
      },
    };
  });

  // Get single trade
  fastify.get<{ Params: { id: string } }>('/trades/:id', async (request, reply) => {
    const trade = await prisma.tradeAttempt.findUnique({
      where: { id: request.params.id },
      include: {
        fill: true,
        instance: {
          include: { config: true },
        },
      },
    });

    if (!trade) {
      return reply.notFound('Trade not found');
    }

    return trade;
  });

  // Get trade statistics for an instance
  fastify.get<{ Params: { instanceId: string } }>(
    '/bots/:instanceId/trades/stats',
    async (request, reply) => {
      const instance = await prisma.botInstance.findUnique({
        where: { id: request.params.instanceId },
      });

      if (!instance) {
        return reply.notFound('Bot instance not found');
      }

      // Get aggregated stats
      const [totalTrades, successfulTrades, failedTrades, fills] = await Promise.all([
        prisma.tradeAttempt.count({
          where: { instanceId: request.params.instanceId },
        }),
        prisma.tradeAttempt.count({
          where: {
            instanceId: request.params.instanceId,
            status: 'CONFIRMED',
          },
        }),
        prisma.tradeAttempt.count({
          where: {
            instanceId: request.params.instanceId,
            status: 'FAILED',
          },
        }),
        prisma.tradeFill.findMany({
          where: {
            attempt: {
              instanceId: request.params.instanceId,
            },
          },
          select: {
            side: true,
            baseQty: true,
            quoteQty: true,
            feeNativeUsdc: true,
            realizedPnl: true,
          },
        }),
      ]);

      // Calculate totals
      let totalBuyVolume = 0;
      let totalSellVolume = 0;
      let totalFees = 0;
      let totalRealizedPnl = 0;
      let buyCount = 0;
      let sellCount = 0;

      for (const fill of fills) {
        if (fill.side === 'BUY') {
          totalBuyVolume += fill.quoteQty;
          buyCount++;
        } else {
          totalSellVolume += fill.quoteQty;
          sellCount++;
          totalRealizedPnl += fill.realizedPnl ?? 0;
        }
        totalFees += fill.feeNativeUsdc;
      }

      return {
        totalTrades,
        successfulTrades,
        failedTrades,
        successRate: totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0,
        buyCount,
        sellCount,
        totalBuyVolume,
        totalSellVolume,
        totalVolume: totalBuyVolume + totalSellVolume,
        totalFees,
        totalRealizedPnl,
      };
    }
  );
};
