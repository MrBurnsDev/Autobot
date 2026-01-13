import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@autobot/db';
import { getAdapter, clearAdapterCache } from '../services/adapter-factory.js';
import { config } from '../config.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Basic health check
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    };
  });

  // Detailed health check
  fastify.get('/health/detailed', async () => {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    // Database check
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (err) {
      checks.database = { status: 'error', error: (err as Error).message };
    }

    // Solana RPC check (if configured)
    if (config.solana.privateKeyBase58) {
      try {
        const adapter = getAdapter('SOLANA');
        const connectivity = await adapter.checkConnectivity();
        checks.solanaRpc = {
          status: connectivity.rpcConnected ? 'ok' : 'error',
          latencyMs: connectivity.latencyMs,
          error: connectivity.errors.length > 0 ? connectivity.errors.join(', ') : undefined,
        };
        checks.jupiterApi = {
          status: connectivity.apiConnected ? 'ok' : 'error',
        };
      } catch (err) {
        checks.solanaRpc = { status: 'error', error: (err as Error).message };
      }
    }

    // Avalanche RPC check (if configured)
    if (config.avalanche.privateKey) {
      try {
        const adapter = getAdapter('AVALANCHE');
        const connectivity = await adapter.checkConnectivity();
        checks.avalancheRpc = {
          status: connectivity.rpcConnected ? 'ok' : 'error',
          latencyMs: connectivity.latencyMs,
          error: connectivity.errors.length > 0 ? connectivity.errors.join(', ') : undefined,
        };
        checks.paraswapApi = {
          status: connectivity.apiConnected ? 'ok' : 'error',
        };
      } catch (err) {
        checks.avalancheRpc = { status: 'error', error: (err as Error).message };
      }
    }

    const allHealthy = Object.values(checks).every((c) => c.status === 'ok');

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  });

  // Check connectivity for a specific chain
  fastify.post<{ Body: { chain: 'SOLANA' | 'AVALANCHE' } }>(
    '/health/check-connectivity',
    async (request, reply) => {
      const { chain } = request.body;

      try {
        // Clear cache to force fresh connection
        clearAdapterCache();

        const adapter = getAdapter(chain);
        const connectivity = await adapter.checkConnectivity();

        return {
          chain,
          ...connectivity,
        };
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    }
  );
};
