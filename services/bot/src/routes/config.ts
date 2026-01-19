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
  // Compounding settings
  compoundingMode: z.enum(['FIXED', 'FULL_BALANCE', 'CALCULATED']).default('FIXED'),
  initialTradeSizeUsdc: z.number().positive().nullable().optional(),
  compoundingReservePct: z.number().min(0).max(50).default(5),
  // Multi-step scale-out settings
  scaleOutSteps: z.number().int().min(1).max(10).default(1),
  scaleOutRangePct: z.number().min(0.1).max(10).default(2),
  scaleOutSpacingPct: z.number().min(0.1).max(5).nullable().optional(),
  // Exit mode settings
  exitMode: z.enum(['FULL_EXIT', 'SCALE_OUT']).default('FULL_EXIT'),
  scaleOutPrimaryPct: z.number().min(0.1).max(1).default(0.65),
  scaleOutSecondaryPct: z.number().min(0.1).max(1).default(0.35),
  // Rolling rebuy settings
  cycleMode: z.enum(['STANDARD', 'ROLLING_REBUY']).default('STANDARD'),
  primarySellPct: z.number().min(50).max(100).default(80),
  allowRebuy: z.boolean().default(false),
  maxRebuyCount: z.number().int().min(1).max(5).default(1),
  exposureCapPct: z.number().min(20).max(100).default(50),
  rebuyRegimeGate: z.boolean().default(true),
  rebuyDipPct: z.number().min(0.1).max(50).nullable().optional(),
  // Capital allocation
  initialCapitalUSDC: z.number().positive().nullable().optional(),
  // Reserve reset settings (3-bucket adaptive strategy)
  enableReserveReset: z.boolean().default(false),
  resetReservePct: z.number().min(10).max(90).default(66),
  maxReserveDeploymentsPerCycle: z.number().int().min(1).max(5).default(2),
  // Rescue buy (downside reset)
  rescueTriggerPct: z.number().min(0.5).max(20).default(2.5),
  rescueDeployPctOfReserve: z.number().min(10).max(100).default(50),
  maxRescueBuysPerCycle: z.number().int().min(1).max(3).default(1),
  rescueRegimeGate: z.enum(['NONE', 'TREND_ONLY', 'CHAOS_ONLY', 'TREND_OR_CHAOS']).default('TREND_OR_CHAOS'),
  // Chase buy (upside reset)
  chaseTriggerPct: z.number().min(0.5).max(20).default(3.0),
  chaseDeployPctOfReserve: z.number().min(10).max(100).default(33),
  chaseExitTargetPct: z.number().min(0.5).max(10).default(1.2),
  chaseRegimeGate: z.enum(['NONE', 'TREND_UP_ONLY', 'TREND_ONLY']).default('TREND_UP_ONLY'),
  // Runner (two-leg position model)
  runnerEnabled: z.boolean().default(false),
  runnerPct: z.number().min(1).max(50).default(20),
  runnerMode: z.enum(['LADDER', 'TRAILING']).default('TRAILING'),
  runnerLadderTargets: z.array(z.number().min(0.1).max(50)).default([]),
  runnerLadderPercents: z.array(z.number().min(1).max(100)).default([]),
  runnerTrailActivatePct: z.number().min(0.1).max(20).default(1.8),
  runnerTrailStopPct: z.number().min(0.1).max(10).default(0.7),
  runnerMinDollarProfit: z.number().min(0).default(0),
});

// Helper to validate runner configuration
function validateRunnerConfig(data: Record<string, unknown>): boolean {
  // Skip validation if runner is not enabled or fields missing
  if (!data.runnerEnabled) return true;

  // Validate runnerPct + primarySellPct = 100 when runner is enabled
  const primarySellPct = typeof data.primarySellPct === 'number' ? data.primarySellPct : 80;
  const runnerPct = typeof data.runnerPct === 'number' ? data.runnerPct : 20;
  const sum = primarySellPct + runnerPct;
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error('primarySellPct + runnerPct must equal 100 when runner is enabled');
  }

  // Validate ladder arrays when in LADDER mode
  if (data.runnerMode === 'LADDER') {
    const targets = Array.isArray(data.runnerLadderTargets) ? data.runnerLadderTargets : [];
    const percents = Array.isArray(data.runnerLadderPercents) ? data.runnerLadderPercents : [];
    if (targets.length !== percents.length) {
      throw new Error('Ladder targets and percents arrays must have same length');
    }
    if (targets.length > 0) {
      const percentSum = percents.reduce((a: number, b: number) => a + b, 0);
      if (Math.abs(percentSum - 100) > 0.01) {
        throw new Error('Ladder percents must sum to 100');
      }
      for (let i = 1; i < targets.length; i++) {
        if (targets[i] <= targets[i - 1]) {
          throw new Error('Ladder targets must be strictly increasing');
        }
      }
    }
  }

  return true;
}

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

    // Validate runner configuration
    validateRunnerConfig(data);

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
      });

      // Validate runner configuration (merge with existing for complete validation)
      if (existing) {
        const merged = { ...existing, ...data };
        validateRunnerConfig(merged as Record<string, unknown>);
      }

      if (!existing) {
        return reply.notFound('Config not found');
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
