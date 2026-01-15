import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { configRoutes } from './routes/config.js';
import { botRoutes } from './routes/bot.js';
import { tradesRoutes } from './routes/trades.js';
import { pnlRoutes } from './routes/pnl.js';
import { healthRoutes } from './routes/health.js';
import { Logger } from '@autobot/core';
import { prisma } from '@autobot/db';
import { startWorker } from './workers/trading-worker.js';

const logger = new Logger('Server');

async function main() {
  const fastify = Fastify({
    logger: config.server.nodeEnv === 'development',
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  await fastify.register(sensible);

  // Register routes
  await fastify.register(healthRoutes);
  await fastify.register(configRoutes, { prefix: '/api' });
  await fastify.register(botRoutes, { prefix: '/api' });
  await fastify.register(tradesRoutes, { prefix: '/api' });
  await fastify.register(pnlRoutes, { prefix: '/api' });

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    logger.error('Request error', {
      error: error.message,
      path: request.url,
      method: request.method,
    });

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: error.message,
      });
    }

    return reply.status(error.statusCode ?? 500).send({
      statusCode: error.statusCode ?? 500,
      error: error.name,
      message: error.message,
    });
  });

  // Start server
  try {
    await fastify.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info(`Server started on ${config.server.host}:${config.server.port}`);

    // Auto-restart workers for instances that were RUNNING before server restart
    const runningInstances = await prisma.botInstance.findMany({
      where: { status: 'RUNNING' },
      include: { config: true },
    });

    for (const instance of runningInstances) {
      logger.info('Auto-restarting worker for running instance', {
        instanceId: instance.id,
        configName: instance.config.name,
      });
      try {
        await startWorker(instance.id);
      } catch (err) {
        logger.error('Failed to auto-restart worker', {
          instanceId: instance.id,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
