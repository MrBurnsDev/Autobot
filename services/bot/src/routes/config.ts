import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma, Chain, TradeSizeMode, StartingMode, PnLMethod } from '@autobot/db';
import { StrategyConfigSchema } from '@autobot/core';

const CreateConfigSchema = z.object({
  name: z.string().min(1).max(100),
  chain: z.enum(['SOLANA', 'AVALANCHE']),
  baseMint: z.string().optional(),
  quoteMint: z.string().optional(),
  buyDipPct: z.number().min(0.1).max(50).default(2),
  sellRisePct: z.number().min(0.1).max(100).default(5),
  tradeSizeMode: z.enum(['FIXED_QUOTE', 'FIXED_BASE', 'PERCENT_BALANCE']).default('FIXED_QUOTE'),
  tradeSize: z.number().positive().default(25),
  minTradeNotional: z.number().min(1).default(10),
  maxSlippageBps: z.number().int().min(1).max(1000).default(50),
  maxPriceImpactBps: z.number().int().min(1).max(1000).nullable().default(100),
  cooldownSeconds: z.number().int().min(0).default(60),
  maxTradesPerHour: z.number().int().min(1).max(100).default(10),
  dailyLossLimitUsdc: z.number().positive().nullable().default(50),
  maxDrawdownPct: z.number().min(1).max(100).nullable().default(10),
  maxConsecutiveFailures: z.number().int().min(1).default(3),
  minBaseReserve: z.number().min(0).default(0.01),
  minQuoteReserve: z.number().min(0).default(5),
  takeProfitUsdc: z.number().positive().nullable().optional(),
  stopLossUsdc: z.number().positive().nullable().optional(),
  startingMode: z.enum(['START_BY_BUYING', 'START_BY_SELLING', 'START_NEUTRAL']).default('START_BY_BUYING'),
  pnlMethod: z.enum(['AVERAGE_COST', 'FIFO']).default('AVERAGE_COST'),
  allowedSources: z.array(z.string()).default([]),
  excludedSources: z.array(z.string()).default([]),
  maxPriceDeviationBps: z.number().int().min(1).max(1000).default(200),
  dryRunMode: z.boolean().default(false),
  webhookUrl: z.string().url().nullable().optional(),
  discordWebhookUrl: z.string().url().nullable().optional(),
});

const UpdateConfigSchema = CreateConfigSchema.partial();

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  // List all configs
  fastify.get('/configs', async () => {
    const configs = await prisma.botConfig.findMany({
      include: {
        instances: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return configs;
  });

  // Get single config
  fastify.get<{ Params: { id: string } }>('/configs/:id', async (request, reply) => {
    const config = await prisma.botConfig.findUnique({
      where: { id: request.params.id },
      include: {
        instances: true,
      },
    });

    if (!config) {
      return reply.notFound('Config not found');
    }

    return config;
  });

  // Create config
  fastify.post<{ Body: z.infer<typeof CreateConfigSchema> }>('/configs', async (request, reply) => {
    const data = CreateConfigSchema.parse(request.body);

    // Set default mints based on chain
    const baseMint =
      data.baseMint ??
      (data.chain === 'SOLANA'
        ? 'So11111111111111111111111111111111111111112'
        : '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');

    const quoteMint =
      data.quoteMint ??
      (data.chain === 'SOLANA'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        : '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E');

    const config = await prisma.botConfig.create({
      data: {
        ...data,
        baseMint,
        quoteMint,
      },
    });

    return reply.code(201).send(config);
  });

  // Update config
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateConfigSchema> }>(
    '/configs/:id',
    async (request, reply) => {
      const data = UpdateConfigSchema.parse(request.body);

      const existing = await prisma.botConfig.findUnique({
        where: { id: request.params.id },
        include: {
          instances: {
            where: { status: 'RUNNING' },
          },
        },
      });

      if (!existing) {
        return reply.notFound('Config not found');
      }

      // Don't allow editing while running
      if (existing.instances.length > 0) {
        return reply.badRequest('Cannot edit config while bot is running');
      }

      const config = await prisma.botConfig.update({
        where: { id: request.params.id },
        data,
      });

      return config;
    }
  );

  // Delete config
  fastify.delete<{ Params: { id: string } }>('/configs/:id', async (request, reply) => {
    const existing = await prisma.botConfig.findUnique({
      where: { id: request.params.id },
      include: {
        instances: {
          where: { status: 'RUNNING' },
        },
      },
    });

    if (!existing) {
      return reply.notFound('Config not found');
    }

    if (existing.instances.length > 0) {
      return reply.badRequest('Cannot delete config while bot is running');
    }

    await prisma.botConfig.delete({
      where: { id: request.params.id },
    });

    return reply.code(204).send();
  });
};
