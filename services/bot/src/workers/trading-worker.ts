import {
  prisma,
  BotInstance,
  BotConfig,
  BotStatus,
  TradeSide,
  TradeStatus,
} from '@autobot/db';
import {
  TradingStrategy,
  PnLCalculator,
  Logger,
  generateClientOrderId,
  sleep,
  isSameHour,
  isSameDay,
  type ChainAdapter,
  type StrategyConfig,
  type StrategyState,
  type StrategyAction,
  type QuoteResult,
  type FillForPnL,
} from '@autobot/core';
import { getAdapter } from '../services/adapter-factory.js';
import { AlertService } from '../services/alert-service.js';
import { config } from '../config.js';

const logger = new Logger('TradingWorker');

interface WorkerState {
  isRunning: boolean;
  instanceId: string;
  loopHandle?: NodeJS.Timeout;
}

const workers = new Map<string, WorkerState>();

export async function startWorker(instanceId: string): Promise<void> {
  if (workers.has(instanceId)) {
    logger.warn('Worker already running', { instanceId });
    return;
  }

  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
    include: { config: true },
  });

  if (!instance) {
    throw new Error(`Bot instance not found: ${instanceId}`);
  }

  const workerState: WorkerState = {
    isRunning: true,
    instanceId,
  };
  workers.set(instanceId, workerState);

  // Update instance status
  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      pauseReason: null,
      lastError: null,
    },
  });

  // Send alert
  const alertService = new AlertService(
    instance.config.webhookUrl ?? config.alerts.webhookUrl,
    instance.config.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'BOT_STARTED',
    title: 'Bot Started',
    message: `Trading bot started for ${instance.config.chain} ${instance.config.name}`,
  });

  // Start the trading loop
  runTradingLoop(instanceId, workerState);

  logger.info('Worker started', { instanceId });
}

export async function stopWorker(instanceId: string, reason?: string): Promise<void> {
  const workerState = workers.get(instanceId);
  if (!workerState) {
    logger.warn('Worker not running', { instanceId });
    return;
  }

  workerState.isRunning = false;
  if (workerState.loopHandle) {
    clearTimeout(workerState.loopHandle);
  }
  workers.delete(instanceId);

  // Update instance status
  const instance = await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      status: 'STOPPED',
      stoppedAt: new Date(),
      pauseReason: reason,
    },
    include: { config: true },
  });

  // Send alert
  const alertService = new AlertService(
    instance.config.webhookUrl ?? config.alerts.webhookUrl,
    instance.config.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'BOT_STOPPED',
    title: 'Bot Stopped',
    message: reason ?? 'Trading bot stopped',
  });

  logger.info('Worker stopped', { instanceId, reason });
}

export function isWorkerRunning(instanceId: string): boolean {
  return workers.has(instanceId);
}

async function runTradingLoop(instanceId: string, workerState: WorkerState): Promise<void> {
  while (workerState.isRunning) {
    try {
      await executeTradingCycle(instanceId);
    } catch (err) {
      logger.error('Trading cycle error', {
        instanceId,
        error: (err as Error).message,
      });

      // Record error
      await prisma.botInstance.update({
        where: { id: instanceId },
        data: {
          lastError: (err as Error).message,
          lastErrorAt: new Date(),
        },
      });
    }

    // Wait for next cycle
    await sleep(config.bot.loopIntervalMs);
  }
}

async function executeTradingCycle(instanceId: string): Promise<void> {
  // Fetch current instance and config
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
    include: { config: true },
  });

  if (!instance || instance.status !== 'RUNNING') {
    return;
  }

  const botConfig = instance.config;
  const adapter = getAdapter(botConfig.chain, instanceId);
  const strategy = new TradingStrategy(buildStrategyConfig(botConfig));
  const pnlCalculator = new PnLCalculator(botConfig.pnlMethod);

  // Get current balances
  const balances = await adapter.getBalances();

  // Get quote for price discovery
  const quote = await adapter.getQuote({
    side: 'BUY',
    amount: botConfig.minTradeNotional,
    amountIsBase: false,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  const currentPrice = quote.price;

  // Build strategy state
  const state = await buildStrategyState(instance);

  // Evaluate strategy
  const action = strategy.evaluate({
    config: buildStrategyConfig(botConfig),
    state,
    balances,
    currentPrice,
    quote,
  });

  logger.debug('Strategy evaluation', {
    instanceId,
    action: action.type,
    reason: action.reason,
    currentPrice,
  });

  // Handle action
  switch (action.type) {
    case 'BUY':
    case 'SELL':
      await executeTradeAction(instanceId, action, adapter, botConfig, pnlCalculator, currentPrice);
      break;

    case 'PAUSE':
      await pauseBot(instanceId, action.reason, botConfig);
      break;

    case 'HOLD':
      // No action needed
      break;
  }

  // Take position snapshot periodically
  await maybeSnapshotPosition(instanceId, balances, currentPrice);
}

async function executeTradeAction(
  instanceId: string,
  action: StrategyAction & { type: 'BUY' | 'SELL' },
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  currentPrice: number
): Promise<void> {
  const side: TradeSide = action.type;

  // Calculate trade amount
  const tradeSize = action.size;
  const amount = tradeSize.quoteAmount ?? tradeSize.baseAmount ?? 0;
  const amountIsBase = tradeSize.baseAmount !== undefined;

  // Generate idempotent order ID
  const clientOrderId = generateClientOrderId(instanceId, side, Date.now());

  // Check for duplicate
  const existing = await prisma.tradeAttempt.findUnique({
    where: { clientOrderId },
  });
  if (existing) {
    logger.warn('Duplicate order detected', { clientOrderId });
    return;
  }

  // Get fresh quote for execution
  const quote = await adapter.getQuote({
    side,
    amount,
    amountIsBase,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // Create trade attempt record
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      quotePrice: quote.price,
      quotedBaseQty: side === 'BUY' ? quote.outputAmount : quote.inputAmount,
      quotedQuoteQty: side === 'BUY' ? quote.inputAmount : quote.outputAmount,
      quotedPriceImpactBps: quote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  // Check dry-run mode
  if (botConfig.dryRunMode) {
    logger.info('DRY RUN: Would execute trade', {
      clientOrderId,
      side,
      quote: {
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount,
        price: quote.price,
      },
    });

    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        errorMessage: 'DRY_RUN_MODE',
      },
    });
    return;
  }

  // Execute swap
  logger.info('Executing trade', {
    clientOrderId,
    side,
    inputAmount: quote.inputAmount,
    expectedOutput: quote.outputAmount,
  });

  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  const result = await adapter.executeSwap({
    quote,
    clientOrderId,
  });

  if (!result.success) {
    // Record failure
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'FAILED',
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        txSignature: result.txSignature || undefined,
      },
    });

    // Increment failure counter
    await prisma.botInstance.update({
      where: { id: instanceId },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: result.error?.message,
        lastErrorAt: new Date(),
      },
    });

    // Send alert
    const alertService = new AlertService(
      botConfig.webhookUrl ?? config.alerts.webhookUrl,
      botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
    );
    await alertService.sendAlert({
      instanceId,
      type: 'TRADE_FAILED',
      title: 'Trade Failed',
      message: `${side} trade failed: ${result.error?.message}`,
      metadata: { clientOrderId, side },
    });

    return;
  }

  // Calculate PnL for this fill
  const fill: FillForPnL = {
    side,
    baseQty: side === 'BUY' ? result.outputAmount : result.inputAmount,
    quoteQty: side === 'BUY' ? result.inputAmount : result.outputAmount,
    executedPrice: result.executedPrice,
    feeQuote: 0, // Fees are in native token
    feeNativeUsdc: result.feeNativeUsdc,
  };

  // Get current cost basis for sells
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
  });

  let realizedPnl = 0;
  let costBasisPerUnit = 0;

  if (side === 'SELL' && instance && instance.totalBaseQty > 0) {
    costBasisPerUnit = instance.totalBaseCost / instance.totalBaseQty;
    const pnlResult = pnlCalculator.calculateRealizedPnL(fill, costBasisPerUnit);
    realizedPnl = pnlResult.realizedPnl;
  }

  // Record fill
  await prisma.tradeFill.create({
    data: {
      attemptId: tradeAttempt.id,
      side,
      baseQty: fill.baseQty,
      quoteQty: fill.quoteQty,
      executedPrice: result.executedPrice,
      feeQuote: 0,
      feeNative: result.feeNative,
      feeNativeUsdc: result.feeNativeUsdc,
      actualSlippageBps: result.actualSlippageBps,
      costBasisPerUnit: side === 'SELL' ? costBasisPerUnit : null,
      realizedPnl: side === 'SELL' ? realizedPnl : null,
      txSignature: result.txSignature,
      blockNumber: result.blockNumber,
      slot: result.slot,
      executedAt: new Date(),
    },
  });

  // Update trade attempt
  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: {
      status: 'CONFIRMED',
      txSignature: result.txSignature,
      confirmedAt: new Date(),
    },
  });

  // Update instance state
  const now = new Date();
  const updateData: Record<string, unknown> = {
    lastTradeAt: now,
    consecutiveFailures: 0,
    tradesThisHour: { increment: 1 },
  };

  if (side === 'BUY') {
    updateData.lastBuyPrice = result.executedPrice;
    updateData.totalBuys = { increment: 1 };
    updateData.totalBuyVolume = { increment: fill.quoteQty };

    // Update cost basis
    if (instance) {
      const costUpdate = pnlCalculator.updateCostBasis(
        instance.totalBaseCost,
        instance.totalBaseQty,
        fill
      );
      updateData.totalBaseCost = costUpdate.newTotalCost;
      updateData.totalBaseQty = costUpdate.newTotalQty;
    }
  } else {
    updateData.lastSellPrice = result.executedPrice;
    updateData.totalSells = { increment: 1 };
    updateData.totalSellVolume = { increment: fill.quoteQty };
    updateData.dailyRealizedPnl = { increment: realizedPnl };

    // Update cost basis after sell
    if (instance) {
      const positionUpdate = pnlCalculator.updatePositionAfterSell(
        instance.totalBaseCost,
        instance.totalBaseQty,
        fill
      );
      updateData.totalBaseCost = positionUpdate.newTotalCost;
      updateData.totalBaseQty = positionUpdate.newTotalQty;
    }
  }

  // Reset hourly counter if needed
  if (instance && !isSameHour(instance.hourlyResetAt, now)) {
    updateData.tradesThisHour = 1;
    updateData.hourlyResetAt = now;
  }

  // Reset daily PnL if needed
  if (instance && !isSameDay(instance.dailyResetAt, now)) {
    updateData.dailyRealizedPnl = side === 'SELL' ? realizedPnl : 0;
    updateData.dailyResetAt = now;
  }

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: updateData,
  });

  // Send success alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_EXECUTED',
    title: `${side} Executed`,
    message: `${side} ${fill.baseQty.toFixed(4)} ${botConfig.chain === 'SOLANA' ? 'SOL' : 'AVAX'} @ ${result.executedPrice.toFixed(4)} USDC`,
    metadata: {
      side,
      baseQty: fill.baseQty,
      quoteQty: fill.quoteQty,
      price: result.executedPrice,
      txSignature: result.txSignature,
      realizedPnl: side === 'SELL' ? realizedPnl : undefined,
    },
  });

  logger.info('Trade executed successfully', {
    instanceId,
    clientOrderId,
    side,
    baseQty: fill.baseQty,
    quoteQty: fill.quoteQty,
    price: result.executedPrice,
    txSignature: result.txSignature,
  });
}

async function pauseBot(
  instanceId: string,
  reason: string,
  botConfig: BotConfig
): Promise<void> {
  // Stop the worker
  await stopWorker(instanceId, reason);

  // Update status
  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      status: 'PAUSED',
      pauseReason: reason,
    },
  });

  // Send circuit breaker alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'CIRCUIT_BREAKER',
    title: 'Circuit Breaker Triggered',
    message: reason,
  });

  logger.warn('Bot paused by circuit breaker', { instanceId, reason });
}

async function maybeSnapshotPosition(
  instanceId: string,
  balances: { base: number; quote: number },
  markPrice: number
): Promise<void> {
  // Check if we need to take a snapshot
  const lastSnapshot = await prisma.positionSnapshot.findFirst({
    where: { instanceId },
    orderBy: { snapshotAt: 'desc' },
  });

  const now = new Date();
  const shouldSnapshot =
    !lastSnapshot ||
    now.getTime() - lastSnapshot.snapshotAt.getTime() >= config.bot.positionSnapshotIntervalMs;

  if (!shouldSnapshot) return;

  const totalValueUsdc = balances.base * markPrice + balances.quote;

  await prisma.positionSnapshot.create({
    data: {
      instanceId,
      baseBalance: balances.base,
      quoteBalance: balances.quote,
      markPrice,
      totalValueUsdc,
    },
  });

  logger.debug('Position snapshot taken', {
    instanceId,
    baseBalance: balances.base,
    quoteBalance: balances.quote,
    totalValueUsdc,
  });
}

function buildStrategyConfig(botConfig: BotConfig): StrategyConfig {
  return {
    buyDipPct: botConfig.buyDipPct,
    sellRisePct: botConfig.sellRisePct,
    tradeSizeMode: botConfig.tradeSizeMode,
    tradeSize: botConfig.tradeSize,
    minTradeNotional: botConfig.minTradeNotional,
    maxSlippageBps: botConfig.maxSlippageBps,
    maxPriceImpactBps: botConfig.maxPriceImpactBps,
    cooldownSeconds: botConfig.cooldownSeconds,
    maxTradesPerHour: botConfig.maxTradesPerHour,
    dailyLossLimitUsdc: botConfig.dailyLossLimitUsdc,
    maxDrawdownPct: botConfig.maxDrawdownPct,
    maxConsecutiveFailures: botConfig.maxConsecutiveFailures,
    minBaseReserve: botConfig.minBaseReserve,
    minQuoteReserve: botConfig.minQuoteReserve,
    takeProfitUsdc: botConfig.takeProfitUsdc,
    stopLossUsdc: botConfig.stopLossUsdc,
    startingMode: botConfig.startingMode,
    pnlMethod: botConfig.pnlMethod,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
    maxPriceDeviationBps: botConfig.maxPriceDeviationBps,
    dryRunMode: botConfig.dryRunMode,
  };
}

async function buildStrategyState(instance: BotInstance): Promise<StrategyState> {
  return {
    lastBuyPrice: instance.lastBuyPrice,
    lastSellPrice: instance.lastSellPrice,
    lastTradeAt: instance.lastTradeAt,
    consecutiveFailures: instance.consecutiveFailures,
    tradesThisHour: instance.tradesThisHour,
    hourlyResetAt: instance.hourlyResetAt,
    dailyRealizedPnl: instance.dailyRealizedPnl,
    dailyResetAt: instance.dailyResetAt,
    totalBaseCost: instance.totalBaseCost,
    totalBaseQty: instance.totalBaseQty,
  };
}
