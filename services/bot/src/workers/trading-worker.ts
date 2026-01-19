import {
  prisma,
  BotInstance,
  BotConfig,
  BotStatus,
  TradeSide,
  TradeStatus,
  MarketRegime,
  TradeRejectionReason,
  ExitMode,
  ExtensionState,
  RunnerState,
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
  // Execution modules
  ExecutionCostCalculator,
  RegimeClassifier,
  CapitalTierEvaluator,
  SplitExecutor,
  formatExecutionCostLog,
  formatRegimeLog,
  type ExecutionCostConfig,
  type RegimeConfig,
  type HourlyAnalytics,
  type RegimeClassification,
  type SplitExecutionResult,
  type ChunkResult,
  // Scale-out modules
  ScaleOutManager,
  formatScaleOutLog,
  type ScaleOutConfig,
  type ExtensionStateData,
  type ScaleOutDecision,
  // Runner (two-leg position model)
  RunnerManager,
  formatRunnerLog,
  type RunnerConfig,
  type RunnerStateData,
  type RunnerDecision,
  // Compounding modules
  CompoundingCalculator,
  formatCompoundingLog,
  type CompoundingConfig,
  type CompoundingMode,
  type TradeSizeResult,
  // Capital allocation
  formatCapitalCheckLog,
  formatWalletGuardrailLog,
  type TradePlan,
} from '@autobot/core';
import { getAdapter } from '../services/adapter-factory.js';
import { AlertService } from '../services/alert-service.js';
import {
  initializeBotCapital,
  checkTradeAllowed,
  reserveCapitalForTrade,
  settleTransaction,
  updateUnrealizedPnL,
  checkWalletGuardrail,
  isCapitalIsolationEnabled,
  removeAllocation,
} from '../services/capital-service.js';
import { config } from '../config.js';

const logger = new Logger('TradingWorker');

// Price history storage - keeps last hour of ticks per instance
interface PriceTick {
  timestamp: number;
  price: number;
}

const priceHistory = new Map<string, PriceTick[]>();
const MAX_PRICE_HISTORY = 360; // ~1 hour at 10s intervals

export function getPriceHistory(instanceId: string): PriceTick[] {
  return priceHistory.get(instanceId) ?? [];
}

function recordPriceTick(instanceId: string, price: number): void {
  let history = priceHistory.get(instanceId);
  if (!history) {
    history = [];
    priceHistory.set(instanceId, history);
  }

  history.push({ timestamp: Date.now(), price });

  // Trim to max size
  if (history.length > MAX_PRICE_HISTORY) {
    history.shift();
  }
}

interface WorkerState {
  isRunning: boolean;
  instanceId: string;
  loopHandle?: NodeJS.Timeout;
  currentRegime: MarketRegime;
  lastRegimeCheck: Date | null;
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
    currentRegime: 'UNKNOWN',
    lastRegimeCheck: null,
  };
  workers.set(instanceId, workerState);

  // Initialize capital allocation if enabled
  const capitalState = await initializeBotCapital(instanceId);
  if (capitalState) {
    logger.info('Capital isolation enabled', {
      instanceId,
      allocatedUSDC: capitalState.allocatedUSDC,
      allocatedSOL: capitalState.allocatedSOL,
    });
  }

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

  // Remove capital allocation from in-memory state (persisted data remains in DB)
  removeAllocation(instanceId);

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

// Manual trade execution (bypasses strategy checks, for testing)
export async function executeManualTrade(
  instanceId: string,
  side: 'BUY' | 'SELL'
): Promise<{ success: boolean; message: string; tradeId?: string }> {
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
    include: { config: true },
  });

  if (!instance) {
    return { success: false, message: 'Bot instance not found' };
  }

  const botConfig = instance.config;
  const adapter = getAdapter(botConfig.chain, instanceId);
  const pnlCalculator = new PnLCalculator(botConfig.pnlMethod);

  // Get quote for trade size
  const tradeAmount = botConfig.tradeSize;
  const quote = await adapter.getQuote({
    side,
    amount: tradeAmount,
    amountIsBase: botConfig.tradeSizeMode === 'FIXED_BASE',
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  const clientOrderId = generateClientOrderId(instanceId, side, Date.now());

  // Create trade attempt
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      isDryRun: botConfig.dryRunMode,
      quotePrice: quote.price,
      quotedBaseQty: side === 'BUY' ? quote.outputAmount : quote.inputAmount,
      quotedQuoteQty: side === 'BUY' ? quote.inputAmount : quote.outputAmount,
      quotedPriceImpactBps: quote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  logger.info('Manual trade initiated', {
    instanceId,
    clientOrderId,
    side,
    isDryRun: botConfig.dryRunMode,
  });

  if (botConfig.dryRunMode) {
    // Synthetic trade for dry run
    await processSyntheticFill(instanceId, tradeAttempt.id, side, quote, botConfig, pnlCalculator);
    return { success: true, message: `Dry run ${side} executed at $${quote.price.toFixed(4)}`, tradeId: tradeAttempt.id };
  }

  // Real trade execution
  try {
    const result = await adapter.executeSwap({ quote, clientOrderId });

    if (result.success) {
      // Calculate base/quote amounts based on side
      const baseQty = side === 'BUY' ? result.outputAmount : result.inputAmount;
      const quoteQty = side === 'BUY' ? result.inputAmount : result.outputAmount;

      // Record fill
      const fill: FillForPnL = {
        side,
        baseQty,
        quoteQty,
        executedPrice: result.executedPrice,
        feeQuote: 0,
        feeNativeUsdc: result.feeNativeUsdc,
      };

      const costBasisPerUnit = instance.totalBaseQty > 0 ? instance.totalBaseCost / instance.totalBaseQty : 0;
      const pnlResult = side === 'SELL' && costBasisPerUnit > 0
        ? pnlCalculator.calculateRealizedPnL(fill, costBasisPerUnit)
        : null;
      const realizedPnl = pnlResult?.realizedPnl ?? null;

      await prisma.tradeAttempt.update({
        where: { id: tradeAttempt.id },
        data: {
          status: 'CONFIRMED',
          txSignature: result.txSignature,
        },
      });

      await prisma.tradeFill.create({
        data: {
          attemptId: tradeAttempt.id,
          side,
          baseQty,
          quoteQty,
          executedPrice: result.executedPrice,
          feeNativeUsdc: result.feeNativeUsdc,
          realizedPnl,
          txSignature: result.txSignature,
          executedAt: new Date(),
        },
      });

      // Update instance state
      const updates: Record<string, unknown> = {
        lastTradeAt: new Date(),
        consecutiveFailures: 0,
      };

      if (side === 'BUY') {
        updates.lastBuyPrice = result.executedPrice;
        updates.totalBuys = { increment: 1 };
        updates.totalBuyVolume = { increment: quoteQty };
        updates.totalBaseCost = { increment: quoteQty };
        updates.totalBaseQty = { increment: baseQty };
      } else {
        updates.lastSellPrice = result.executedPrice;
        updates.totalSells = { increment: 1 };
        updates.totalSellVolume = { increment: quoteQty };
        updates.totalBaseCost = { decrement: costBasisPerUnit * baseQty };
        updates.totalBaseQty = { decrement: baseQty };
        if (realizedPnl) {
          updates.dailyRealizedPnl = { increment: realizedPnl };
        }
      }

      await prisma.botInstance.update({
        where: { id: instanceId },
        data: updates,
      });

      return {
        success: true,
        message: `${side} executed: ${baseQty.toFixed(4)} @ $${result.executedPrice.toFixed(4)}`,
        tradeId: tradeAttempt.id,
      };
    } else {
      await prisma.tradeAttempt.update({
        where: { id: tradeAttempt.id },
        data: {
          status: 'FAILED',
          errorMessage: result.error?.message || 'Unknown error',
        },
      });
      return { success: false, message: result.error?.message || 'Trade failed', tradeId: tradeAttempt.id };
    }
  } catch (err) {
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'FAILED',
        errorMessage: (err as Error).message,
      },
    });
    return { success: false, message: (err as Error).message, tradeId: tradeAttempt.id };
  }
}

export function isWorkerRunning(instanceId: string): boolean {
  return workers.has(instanceId);
}

async function runTradingLoop(instanceId: string, workerState: WorkerState): Promise<void> {
  while (workerState.isRunning) {
    try {
      await executeTradingCycle(instanceId, workerState);
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

async function executeTradingCycle(instanceId: string, workerState: WorkerState): Promise<void> {
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
  const pnlCalculator = new PnLCalculator(botConfig.pnlMethod);

  // Build execution modules
  const costCalculator = buildCostCalculator(botConfig);
  const compoundingCalculator = buildCompoundingCalculator(botConfig);
  const regimeClassifier = buildRegimeClassifier(botConfig);

  // Get current balances
  const balances = await adapter.getBalances();

  // Calculate portfolio value
  const discoveryQuote = await adapter.getQuote({
    side: 'BUY',
    amount: botConfig.minTradeNotional,
    amountIsBase: false,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  const currentPrice = discoveryQuote.price;
  const portfolioValueUsdc = balances.base * currentPrice + balances.quote;

  // === WALLET-LEVEL GUARDRAIL ===
  // Check that sum of all bot allocations doesn't exceed actual wallet balance
  const capitalEnabled = await isCapitalIsolationEnabled(instanceId);
  if (capitalEnabled) {
    const guardrailResult = checkWalletGuardrail(balances.quote, balances.base);

    if (!guardrailResult.safe) {
      logger.error('Wallet guardrail FAILED', {
        instanceId,
        log: formatWalletGuardrailLog(guardrailResult),
      });

      // Log rejection and pause bot
      await logTradeRejection(instanceId, 'BUY', 'WALLET_GUARDRAIL_FAILED', {
        intendedSizeUsdc: 0,
        currentPrice,
        portfolioValueUsdc,
        currentRegime: workerState.currentRegime,
      });

      await pauseBot(instanceId, `Wallet guardrail failed: ${guardrailResult.reason}`, botConfig);
      return;
    }

    // Update unrealized PnL for this bot
    updateUnrealizedPnL(instanceId, currentPrice);

    logger.debug('Wallet guardrail passed', {
      instanceId,
      log: formatWalletGuardrailLog(guardrailResult),
    });
  }

  // === REGIME CLASSIFICATION ===
  // Check regime periodically (every hour)
  const now = new Date();
  const shouldCheckRegime = !workerState.lastRegimeCheck ||
    now.getTime() - workerState.lastRegimeCheck.getTime() >= 3600000; // 1 hour

  if (shouldCheckRegime && botConfig.enableRegimeAdaptation) {
    const regimeResult = await classifyCurrentRegime(instanceId, regimeClassifier);
    workerState.currentRegime = regimeResult.regime;
    workerState.lastRegimeCheck = now;

    logger.info('Regime classified', {
      instanceId,
      log: formatRegimeLog(regimeResult),
    });

    // Record regime in current hour's analytics
    await updateHourlyAnalyticsRegime(instanceId, regimeResult.regime);

    // Check if we should pause for CHAOS
    if (regimeResult.regime === 'CHAOS' && botConfig.pauseInChaosRegime) {
      // If in extension, force exit before pausing
      if (instance.extensionState !== 'NONE') {
        logger.warn('CHAOS regime with active extension - forcing extension exit');
        await forceExtensionExit(instanceId, instance, adapter, botConfig, pnlCalculator, currentPrice, 'CHAOS regime');
      }
      await pauseBot(instanceId, 'CHAOS regime detected - trading paused for safety', botConfig);
      return;
    }
  }

  // === SCALE-OUT EXTENSION CHECK ===
  // If in extension state, check for extension exit BEFORE normal strategy
  if (instance.extensionState !== 'NONE') {
    const extensionHandled = await checkExtensionExit(
      instanceId,
      instance,
      adapter,
      botConfig,
      pnlCalculator,
      costCalculator,
      currentPrice,
      portfolioValueUsdc,
      workerState.currentRegime,
      discoveryQuote
    );

    if (extensionHandled) {
      // Update peak price for trailing (even if not exiting)
      await updateExtensionPeakPrice(instanceId, instance, currentPrice);
      await maybeSnapshotPosition(instanceId, balances, currentPrice);
      return; // Don't proceed to normal strategy evaluation
    }
  }

  // === RUNNER LEG CHECK ===
  // If runner leg is active, check for runner exit (independent of CORE strategy)
  if (instance.runnerState === 'ACTIVE' && botConfig.runnerEnabled) {
    const runnerHandled = await checkRunnerExit(
      instanceId,
      instance,
      adapter,
      botConfig,
      pnlCalculator,
      costCalculator,
      currentPrice,
      portfolioValueUsdc,
      discoveryQuote
    );

    // Update runner peak price even if not exiting
    if (instance.runnerState === 'ACTIVE') {
      await updateRunnerPeakPrice(instanceId, instance, currentPrice);
    }

    // Runner exit does NOT block CORE strategy - CORE can continue trading
    // This is the key difference from extension: runner is independent
  }

  // Build strategy state
  const state = await buildStrategyState(instance);

  // === COMPOUNDING: Calculate dynamic trade size for BUY actions ===
  // Query total realized PnL for compounding calculation
  const totalRealizedPnl = await getTotalRealizedPnl(instanceId);
  const compoundingResult = compoundingCalculator.calculateBuySize(
    balances.quote,
    instance.dailyRealizedPnl,
    totalRealizedPnl
  );

  // Log compounding calculation if not using FIXED mode
  if (botConfig.compoundingMode !== 'FIXED') {
    logger.info('Compounding calculated', {
      instanceId,
      log: formatCompoundingLog(compoundingResult),
    });
  }

  // Build strategy config with potentially compounded trade size
  const effectiveTradeSize = compoundingResult.tradeSizeUsdc > 0
    ? compoundingResult.tradeSizeUsdc
    : botConfig.tradeSize;

  const strategyConfig = buildStrategyConfig(botConfig, effectiveTradeSize);
  const strategy = new TradingStrategy(strategyConfig);

  // Evaluate strategy
  const action = strategy.evaluate({
    config: strategyConfig,
    state,
    balances,
    currentPrice,
    quote: discoveryQuote,
  });

  // Record price for chart
  recordPriceTick(instanceId, currentPrice);

  logger.info('Tick', {
    instanceId,
    price: currentPrice.toFixed(4),
    action: action.type,
    reason: action.reason,
  });

  // Handle action
  switch (action.type) {
    case 'BUY':
      // BUY logic unchanged - only execute if not in extension
      if (instance.extensionState !== 'NONE') {
        logger.debug('Skipping BUY signal - extension active', { instanceId });
        break;
      }
      await executeTradeWithCostGating(
        instanceId,
        action,
        adapter,
        botConfig,
        pnlCalculator,
        costCalculator,
        currentPrice,
        portfolioValueUsdc,
        workerState.currentRegime
      );
      break;

    case 'SELL':
      // SELL uses scale-out logic if enabled
      await executeSellWithScaleOut(
        instanceId,
        action,
        instance,
        adapter,
        botConfig,
        pnlCalculator,
        costCalculator,
        currentPrice,
        portfolioValueUsdc,
        workerState.currentRegime,
        discoveryQuote
      );
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

/**
 * Execute trade with execution cost gating and optional split execution
 */
async function executeTradeWithCostGating(
  instanceId: string,
  action: StrategyAction & { type: 'BUY' | 'SELL' },
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number,
  currentRegime: MarketRegime
): Promise<void> {
  const side: TradeSide = action.type;

  // Calculate trade amount
  const tradeSize = action.size;
  const amount = tradeSize.quoteAmount ?? (tradeSize.baseAmount ? tradeSize.baseAmount * currentPrice : 0);
  const amountIsBase = tradeSize.baseAmount !== undefined && tradeSize.quoteAmount === undefined;

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
    amount: amountIsBase ? (tradeSize.baseAmount ?? 0) : amount,
    amountIsBase,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // === EXECUTION COST GATING ===
  const costResult = costCalculator.calculateExecutionCost(quote);
  logger.info('Execution cost calculated', {
    instanceId,
    log: formatExecutionCostLog(costResult),
  });

  if (!costResult.shouldExecute) {
    // Log rejection
    await logTradeRejection(
      instanceId,
      side,
      costResult.rejectionCode as TradeRejectionReason || 'NET_EDGE_TOO_LOW',
      {
        intendedSizeUsdc: amount,
        currentPrice,
        quotedSlippagePct: costResult.quotedSlippagePct,
        estimatedFeePct: costResult.estimatedDexFeePct + costResult.priorityFeeImpactPct,
        executionCostPct: costResult.totalExecutionCostPct,
        netEdgePct: costResult.netEdgePct,
        sellTargetPct: costResult.effectiveSellTargetPct,
        portfolioValueUsdc,
        currentRegime,
      }
    );

    logger.warn('Trade rejected by cost gating', {
      instanceId,
      clientOrderId,
      reason: costResult.rejectionReason,
      netEdge: costResult.netEdgePct,
    });
    return;
  }

  // === CAPITAL ALLOCATION CHECK (if enabled) ===
  const capitalEnabled = await isCapitalIsolationEnabled(instanceId);
  if (capitalEnabled) {
    // Estimate fee in USDC
    const estimatedFeeUSDC =
      (costResult.estimatedDexFeePct + costResult.priorityFeeImpactPct) * amount / 100;

    const tradePlan: TradePlan = {
      side,
      quoteAmount: side === 'BUY' ? quote.inputAmount : quote.outputAmount,
      baseAmount: side === 'BUY' ? quote.outputAmount : quote.inputAmount,
      estimatedFeeUSDC,
      currentPrice,
    };

    const capitalCheck = checkTradeAllowed(instanceId, tradePlan);
    logger.info('Capital allocation check', {
      instanceId,
      log: formatCapitalCheckLog(capitalCheck),
    });

    if (!capitalCheck.allowed) {
      // Determine rejection reason
      const rejectionReason: TradeRejectionReason =
        side === 'BUY' ? 'INSUFFICIENT_CAPITAL' : 'SELL_NOT_PROFITABLE';

      await logTradeRejection(instanceId, side, rejectionReason, {
        intendedSizeUsdc: amount,
        currentPrice,
        portfolioValueUsdc,
        currentRegime,
      });

      logger.warn('Trade rejected by capital allocation', {
        instanceId,
        clientOrderId,
        reason: capitalCheck.reason,
        side,
      });
      return;
    }

    // Reserve capital before execution
    if (!await reserveCapitalForTrade(instanceId, tradePlan)) {
      logger.error('Failed to reserve capital', { instanceId, clientOrderId });
      return;
    }
  }

  // === APPLY REGIME-BASED ADJUSTMENTS ===
  // Adjust parameters based on current regime
  const adjustedConfig = applyRegimeAdjustments(botConfig, currentRegime);

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

  // Check dry-run mode - create synthetic trade
  if (botConfig.dryRunMode) {
    logger.info('DRY RUN: Synthetic trade executed', {
      clientOrderId,
      side,
      quote: {
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount,
        price: quote.price,
      },
      costResult: {
        netEdgePct: costResult.netEdgePct,
        effectiveSellTarget: costResult.effectiveSellTargetPct,
      },
    });

    // Create synthetic fill record for tracking
    await processSyntheticFill(
      instanceId,
      tradeAttempt.id,
      side,
      quote,
      botConfig,
      pnlCalculator
    );
    return;
  }

  // === DETERMINE EXECUTION MODE ===
  const tierEvaluator = new CapitalTierEvaluator(
    {
      tier1Usdc: botConfig.capitalTier1Usdc,
      tier2Usdc: botConfig.capitalTier2Usdc,
      tier3Usdc: botConfig.capitalTier3Usdc,
    },
    {
      maxSingleTradeSlippagePct: botConfig.maxSingleTradeSlippagePct,
      targetChunkSlippagePct: botConfig.targetChunkSlippagePct,
      minChunkSizeUsdc: botConfig.minChunkSizeUsdc,
      maxChunksPerSplit: botConfig.maxChunksPerSplit,
    }
  );

  const tierResult = tierEvaluator.evaluate(portfolioValueUsdc, amount);

  logger.debug('Capital tier evaluated', {
    instanceId,
    tier: tierResult.tier,
    executionMode: tierResult.executionMode,
    shouldSplit: tierResult.shouldSplit,
  });

  // Execute swap
  logger.info('Executing trade', {
    clientOrderId,
    side,
    inputAmount: quote.inputAmount,
    expectedOutput: quote.outputAmount,
    executionMode: tierResult.executionMode,
  });

  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  // Execute based on whether we should split
  if (tierResult.shouldSplit) {
    // Split execution
    await executeSplitTrade(
      instanceId,
      tradeAttempt.id,
      side,
      amount,
      adapter,
      botConfig,
      pnlCalculator,
      portfolioValueUsdc,
      clientOrderId
    );
  } else {
    // Single-shot execution
    await executeSingleTrade(
      instanceId,
      tradeAttempt.id,
      side,
      quote,
      adapter,
      botConfig,
      pnlCalculator,
      clientOrderId
    );
  }
}

/**
 * Execute a single-shot trade
 */
async function executeSingleTrade(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  quote: QuoteResult,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  clientOrderId: string
): Promise<void> {
  const result = await adapter.executeSwap({
    quote,
    clientOrderId,
  });

  if (!result.success) {
    await handleTradeFailure(instanceId, tradeAttemptId, botConfig, result);
    return;
  }

  // Process successful fill
  await processSuccessfulFill(
    instanceId,
    tradeAttemptId,
    side,
    result,
    botConfig,
    pnlCalculator
  );
}

/**
 * Execute a split trade in sequential chunks
 */
async function executeSplitTrade(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  totalAmountUsdc: number,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  portfolioValueUsdc: number,
  clientOrderId: string
): Promise<void> {
  const splitExecutor = buildSplitExecutor(botConfig);

  const splitResult = await splitExecutor.execute(
    adapter,
    side,
    totalAmountUsdc,
    portfolioValueUsdc,
    botConfig.maxSlippageBps,
    clientOrderId,
    botConfig.allowedSources,
    botConfig.excludedSources
  );

  // Record split execution
  const splitExecution = await prisma.splitExecution.create({
    data: {
      instanceId,
      parentOrderId: clientOrderId,
      side,
      totalIntendedSize: totalAmountUsdc,
      totalChunks: splitResult.totalChunks,
      completedChunks: splitResult.completedChunks,
      abortedChunks: splitResult.abortedChunks,
      totalBaseExecuted: splitResult.totalBaseExecuted,
      totalQuoteExecuted: splitResult.totalQuoteExecuted,
      weightedAvgPrice: splitResult.weightedAvgPrice,
      totalFees: splitResult.totalFees,
      totalSlippageCost: splitResult.totalSlippageCost,
      status: splitResult.success ? 'CONFIRMED' : 'FAILED',
      abortReason: splitResult.abortReason,
      startedAt: splitResult.startedAt,
      completedAt: splitResult.completedAt,
    },
  });

  // Record individual chunks
  for (const chunk of splitResult.chunks) {
    await prisma.splitChunk.create({
      data: {
        splitExecutionId: splitExecution.id,
        chunkIndex: chunk.chunkIndex,
        intendedSize: totalAmountUsdc / splitResult.totalChunks,
        quotedPrice: chunk.quote?.price,
        quotedSlippageBps: chunk.quote?.priceImpactBps,
        status: chunk.success ? 'CONFIRMED' : 'FAILED',
        executedBaseQty: chunk.executedBaseQty || null,
        executedQuoteQty: chunk.executedQuoteQty || null,
        executedPrice: chunk.executedPrice || null,
        actualSlippageBps: chunk.actualSlippageBps,
        feeNativeUsdc: chunk.feeNativeUsdc || null,
        txSignature: chunk.swap?.txSignature,
        errorMessage: chunk.error,
        attemptedAt: chunk.attemptedAt,
        completedAt: chunk.completedAt,
      },
    });
  }

  if (!splitResult.success && splitResult.completedChunks === 0) {
    // Complete failure
    await prisma.tradeAttempt.update({
      where: { id: tradeAttemptId },
      data: {
        status: 'FAILED',
        errorCode: 'SPLIT_EXECUTION_FAILED',
        errorMessage: splitResult.abortReason,
      },
    });

    await prisma.botInstance.update({
      where: { id: instanceId },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: splitResult.abortReason,
        lastErrorAt: new Date(),
      },
    });

    const alertService = new AlertService(
      botConfig.webhookUrl ?? config.alerts.webhookUrl,
      botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
    );
    await alertService.sendAlert({
      instanceId,
      type: 'TRADE_FAILED',
      title: 'Split Trade Failed',
      message: `${side} split trade failed: ${splitResult.abortReason}`,
      metadata: { clientOrderId, side, chunks: splitResult.totalChunks },
    });

    return;
  }

  // Process successful (or partial) split execution
  await processSuccessfulSplitFill(
    instanceId,
    tradeAttemptId,
    side,
    splitResult,
    botConfig,
    pnlCalculator
  );
}

/**
 * Handle trade failure
 */
async function handleTradeFailure(
  instanceId: string,
  tradeAttemptId: string,
  botConfig: BotConfig,
  result: { txSignature: string; error?: { code: string; message: string } }
): Promise<void> {
  await prisma.tradeAttempt.update({
    where: { id: tradeAttemptId },
    data: {
      status: 'FAILED',
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      txSignature: result.txSignature || undefined,
    },
  });

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      consecutiveFailures: { increment: 1 },
      lastError: result.error?.message,
      lastErrorAt: new Date(),
    },
  });

  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_FAILED',
    title: 'Trade Failed',
    message: `Trade failed: ${result.error?.message}`,
  });
}

/**
 * Process a successful single fill
 */
async function processSuccessfulFill(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  result: {
    txSignature: string;
    blockNumber?: bigint;
    slot?: bigint;
    inputAmount: number;
    outputAmount: number;
    executedPrice: number;
    feeNative: number;
    feeNativeUsdc: number;
    actualSlippageBps: number | null;
  },
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator
): Promise<void> {
  const fill: FillForPnL = {
    side,
    baseQty: side === 'BUY' ? result.outputAmount : result.inputAmount,
    quoteQty: side === 'BUY' ? result.inputAmount : result.outputAmount,
    executedPrice: result.executedPrice,
    feeQuote: 0,
    feeNativeUsdc: result.feeNativeUsdc,
  };

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
      attemptId: tradeAttemptId,
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

  await prisma.tradeAttempt.update({
    where: { id: tradeAttemptId },
    data: {
      status: 'CONFIRMED',
      txSignature: result.txSignature,
      confirmedAt: new Date(),
    },
  });

  // Update instance state
  await updateInstanceAfterFill(instanceId, side, fill, realizedPnl, pnlCalculator, instance);

  // Settle capital allocation (if enabled)
  const capitalEnabled = await isCapitalIsolationEnabled(instanceId);
  if (capitalEnabled) {
    const tradePlan: TradePlan = {
      side,
      quoteAmount: fill.quoteQty,
      baseAmount: fill.baseQty,
      estimatedFeeUSDC: result.feeNativeUsdc,
      currentPrice: result.executedPrice,
    };

    await settleTransaction(instanceId, tradePlan, {
      success: true,
      actualQuoteAmount: fill.quoteQty,
      actualBaseAmount: fill.baseQty,
      actualFeeUSDC: result.feeNativeUsdc,
      realizedPnL: realizedPnl,
    });

    logger.debug('Capital settlement completed', {
      instanceId,
      side,
      quoteAmount: fill.quoteQty,
      baseAmount: fill.baseQty,
    });
  }

  // Send alert
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
    side,
    baseQty: fill.baseQty,
    quoteQty: fill.quoteQty,
    price: result.executedPrice,
    txSignature: result.txSignature,
  });
}

/**
 * Process a synthetic (dry run) fill - creates records for tracking without executing on-chain
 */
async function processSyntheticFill(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  quote: QuoteResult,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator
): Promise<void> {
  // Use quote data as synthetic execution data
  const syntheticFill: FillForPnL = {
    side,
    baseQty: side === 'BUY' ? quote.outputAmount : quote.inputAmount,
    quoteQty: side === 'BUY' ? quote.inputAmount : quote.outputAmount,
    executedPrice: quote.price,
    feeQuote: 0,
    feeNativeUsdc: 0.001, // Simulate small gas fee
  };

  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
  });

  let realizedPnl = 0;
  let costBasisPerUnit = 0;

  if (side === 'SELL' && instance && instance.totalBaseQty > 0) {
    costBasisPerUnit = instance.totalBaseCost / instance.totalBaseQty;
    const pnlResult = pnlCalculator.calculateRealizedPnL(syntheticFill, costBasisPerUnit);
    realizedPnl = pnlResult.realizedPnl;
  }

  // Mark trade attempt as dry run and confirmed
  await prisma.tradeAttempt.update({
    where: { id: tradeAttemptId },
    data: {
      status: 'CONFIRMED',
      isDryRun: true,
      confirmedAt: new Date(),
    },
  });

  // Create synthetic fill record
  await prisma.tradeFill.create({
    data: {
      attemptId: tradeAttemptId,
      side,
      baseQty: syntheticFill.baseQty,
      quoteQty: syntheticFill.quoteQty,
      executedPrice: quote.price,
      feeQuote: 0,
      feeNative: 0,
      feeNativeUsdc: 0.001,
      actualSlippageBps: quote.priceImpactBps,
      costBasisPerUnit: side === 'SELL' ? costBasisPerUnit : null,
      realizedPnl: side === 'SELL' ? realizedPnl : null,
      txSignature: `DRY_RUN_${Date.now()}`,
      executedAt: new Date(),
    },
  });

  // Update instance state (simulated position changes)
  await updateInstanceAfterFill(instanceId, side, syntheticFill, realizedPnl, pnlCalculator, instance);

  // Send alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_EXECUTED',
    title: `[DRY RUN] ${side} Executed`,
    message: `[SIMULATED] ${side} ${syntheticFill.baseQty.toFixed(4)} ${botConfig.chain === 'SOLANA' ? 'SOL' : 'AVAX'} @ ${quote.price.toFixed(4)} USDC`,
    metadata: {
      side,
      baseQty: syntheticFill.baseQty,
      quoteQty: syntheticFill.quoteQty,
      price: quote.price,
      isDryRun: true,
      realizedPnl: side === 'SELL' ? realizedPnl : undefined,
    },
  });

  logger.info('Synthetic trade recorded', {
    instanceId,
    side,
    baseQty: syntheticFill.baseQty,
    quoteQty: syntheticFill.quoteQty,
    price: quote.price,
    isDryRun: true,
  });
}

/**
 * Process a successful split fill
 */
async function processSuccessfulSplitFill(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  splitResult: SplitExecutionResult,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator
): Promise<void> {
  const fill: FillForPnL = {
    side,
    baseQty: splitResult.totalBaseExecuted,
    quoteQty: splitResult.totalQuoteExecuted,
    executedPrice: splitResult.weightedAvgPrice || 0,
    feeQuote: 0,
    feeNativeUsdc: splitResult.totalFees,
  };

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

  // Record aggregate fill from successful chunks
  const successfulChunks = splitResult.chunks.filter((c: ChunkResult) => c.success);
  if (successfulChunks.length > 0) {
    const lastChunk = successfulChunks[successfulChunks.length - 1];
    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttemptId,
        side,
        baseQty: fill.baseQty,
        quoteQty: fill.quoteQty,
        executedPrice: splitResult.weightedAvgPrice || 0,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: splitResult.totalFees,
        actualSlippageBps: null, // Aggregate slippage not meaningful
        costBasisPerUnit: side === 'SELL' ? costBasisPerUnit : null,
        realizedPnl: side === 'SELL' ? realizedPnl : null,
        txSignature: lastChunk?.swap?.txSignature || 'SPLIT_EXECUTION',
        executedAt: new Date(),
      },
    });
  }

  await prisma.tradeAttempt.update({
    where: { id: tradeAttemptId },
    data: {
      status: splitResult.fullyExecuted ? 'CONFIRMED' : 'CONFIRMED', // Partial is still confirmed
      confirmedAt: new Date(),
      errorMessage: splitResult.abortReason ? `Partial: ${splitResult.abortReason}` : null,
    },
  });

  // Update instance state
  await updateInstanceAfterFill(instanceId, side, fill, realizedPnl, pnlCalculator, instance);

  // Send alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_EXECUTED',
    title: `${side} Split Executed`,
    message: `${side} ${fill.baseQty.toFixed(4)} ${botConfig.chain === 'SOLANA' ? 'SOL' : 'AVAX'} @ ${(splitResult.weightedAvgPrice || 0).toFixed(4)} USDC (${splitResult.completedChunks}/${splitResult.totalChunks} chunks)`,
    metadata: {
      side,
      baseQty: fill.baseQty,
      quoteQty: fill.quoteQty,
      price: splitResult.weightedAvgPrice,
      chunks: splitResult.completedChunks,
      totalChunks: splitResult.totalChunks,
      realizedPnl: side === 'SELL' ? realizedPnl : undefined,
    },
  });

  logger.info('Split trade executed', {
    instanceId,
    side,
    baseQty: fill.baseQty,
    quoteQty: fill.quoteQty,
    avgPrice: splitResult.weightedAvgPrice,
    completedChunks: splitResult.completedChunks,
    totalChunks: splitResult.totalChunks,
  });
}

/**
 * Update instance state after a fill
 */
async function updateInstanceAfterFill(
  instanceId: string,
  side: TradeSide,
  fill: FillForPnL,
  realizedPnl: number,
  pnlCalculator: PnLCalculator,
  instance: BotInstance | null
): Promise<void> {
  const now = new Date();
  const updateData: Record<string, unknown> = {
    lastTradeAt: now,
    consecutiveFailures: 0,
    tradesThisHour: { increment: 1 },
  };

  if (side === 'BUY') {
    updateData.lastBuyPrice = fill.executedPrice;
    updateData.totalBuys = { increment: 1 };
    updateData.totalBuyVolume = { increment: fill.quoteQty };

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
    updateData.lastSellPrice = fill.executedPrice;
    updateData.totalSells = { increment: 1 };
    updateData.totalSellVolume = { increment: fill.quoteQty };
    updateData.dailyRealizedPnl = { increment: realizedPnl };

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
}

/**
 * Classify current market regime from recent analytics
 */
async function classifyCurrentRegime(
  instanceId: string,
  classifier: RegimeClassifier
): Promise<RegimeClassification> {
  // Get last 6 hours of analytics
  const sixHoursAgo = new Date(Date.now() - 6 * 3600000);

  const analytics = await prisma.marketAnalytics.findMany({
    where: {
      instanceId,
      hourStart: { gte: sixHoursAgo },
    },
    orderBy: { hourStart: 'desc' },
    take: 6,
  });

  if (analytics.length === 0) {
    return {
      regime: 'UNKNOWN',
      confidence: 0,
      signals: [],
      recommendation: {
        shouldTrade: true,
        buyDipMultiplier: 1.0,
        sellTargetMultiplier: 1.0,
        cooldownMultiplier: 1.0,
        reason: 'Insufficient analytics data for regime classification',
      },
    };
  }

  const hourlyData: HourlyAnalytics[] = analytics.map(a => ({
    priceRangePct: a.priceRangePct,
    volatility1h: a.volatility1h,
    avgSlippageBps: a.avgSlippageBps,
    cyclesCompleted: a.cyclesCompleted,
    avgCycleTimeMinutes: a.avgCycleTimeMinutes,
    buyCount: a.buyCount,
    sellCount: a.sellCount,
    rejectedCount: a.rejectedCount,
    failedCount: a.failedCount,
  }));

  return classifier.classify(hourlyData);
}

/**
 * Update hourly analytics with detected regime
 */
async function updateHourlyAnalyticsRegime(
  instanceId: string,
  regime: MarketRegime
): Promise<void> {
  const hourStart = new Date();
  hourStart.setMinutes(0, 0, 0);

  await prisma.marketAnalytics.upsert({
    where: {
      instanceId_hourStart: { instanceId, hourStart },
    },
    create: {
      instanceId,
      hourStart,
      priceHigh: 0,
      priceLow: 0,
      priceOpen: 0,
      priceClose: 0,
      priceRangePct: 0,
      volatility1h: 0,
      avgSlippageBps: 0,
      maxSlippageBps: 0,
      detectedRegime: regime,
    },
    update: {
      detectedRegime: regime,
    },
  });
}

/**
 * Log a trade rejection for analysis
 */
async function logTradeRejection(
  instanceId: string,
  side: TradeSide,
  reason: TradeRejectionReason,
  details: {
    intendedSizeUsdc: number;
    currentPrice: number;
    quotedSlippagePct?: number;
    estimatedFeePct?: number;
    executionCostPct?: number;
    netEdgePct?: number;
    sellTargetPct?: number;
    portfolioValueUsdc?: number;
    currentRegime?: MarketRegime;
  }
): Promise<void> {
  await prisma.tradeRejection.create({
    data: {
      instanceId,
      side,
      reason,
      intendedSizeUsdc: details.intendedSizeUsdc,
      currentPrice: details.currentPrice,
      quotedSlippagePct: details.quotedSlippagePct,
      estimatedFeePct: details.estimatedFeePct,
      executionCostPct: details.executionCostPct,
      netEdgePct: details.netEdgePct,
      sellTargetPct: details.sellTargetPct,
      portfolioValueUsdc: details.portfolioValueUsdc,
      currentRegime: details.currentRegime,
    },
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

// === BUILDER FUNCTIONS ===

function buildCostCalculator(botConfig: BotConfig): ExecutionCostCalculator {
  const costConfig: ExecutionCostConfig = {
    estimatedDexFeePct: botConfig.estimatedDexFeePct,
    priorityFeeImpactPct: botConfig.priorityFeeImpactPct,
    minimumNetEdgePct: botConfig.minimumNetEdgePct,
    maxExecutionCostPct: botConfig.maxExecutionCostPct,
    baseSellTargetPct: botConfig.sellRisePct,
    sellTargetTier1Pct: botConfig.sellTargetTier1Pct,
    sellTargetTier2Pct: botConfig.sellTargetTier2Pct,
  };
  return new ExecutionCostCalculator(costConfig);
}

function buildRegimeClassifier(botConfig: BotConfig): RegimeClassifier {
  const regimeConfig: RegimeConfig = {
    chaosVolatilityThreshold: botConfig.chaosVolatilityThreshold,
    chopRangeThreshold: botConfig.chopRangeThreshold,
    minSamplesForClassification: 3,
    fastCycleThresholdMinutes: 30,
    slowCycleThresholdMinutes: 180,
  };
  return new RegimeClassifier(regimeConfig);
}

function buildSplitExecutor(botConfig: BotConfig): SplitExecutor {
  return new SplitExecutor({
    costConfig: {
      estimatedDexFeePct: botConfig.estimatedDexFeePct,
      priorityFeeImpactPct: botConfig.priorityFeeImpactPct,
      minimumNetEdgePct: botConfig.minimumNetEdgePct,
      maxExecutionCostPct: botConfig.maxExecutionCostPct,
      baseSellTargetPct: botConfig.sellRisePct,
      sellTargetTier1Pct: botConfig.sellTargetTier1Pct,
      sellTargetTier2Pct: botConfig.sellTargetTier2Pct,
    },
    tierConfig: {
      tier1Usdc: botConfig.capitalTier1Usdc,
      tier2Usdc: botConfig.capitalTier2Usdc,
      tier3Usdc: botConfig.capitalTier3Usdc,
    },
    splitConfig: {
      maxSingleTradeSlippagePct: botConfig.maxSingleTradeSlippagePct,
      targetChunkSlippagePct: botConfig.targetChunkSlippagePct,
      minChunkSizeUsdc: botConfig.minChunkSizeUsdc,
      maxChunksPerSplit: botConfig.maxChunksPerSplit,
    },
    delayBetweenChunksMs: 2000,
    maxChunkRetries: 2,
    quoteRefreshBeforeEachChunk: true,
    abortOnSlippageSpike: true,
    slippageSpikeThresholdBps: 200,
    abortOnPriceMove: true,
    priceMoveAbortThresholdPct: 2.0,
  });
}

function buildStrategyConfig(botConfig: BotConfig, tradeSizeOverride?: number): StrategyConfig {
  return {
    buyDipPct: botConfig.buyDipPct,
    sellRisePct: botConfig.sellRisePct,
    tradeSizeMode: botConfig.tradeSizeMode,
    tradeSize: tradeSizeOverride ?? botConfig.tradeSize,
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

/**
 * Get total realized PnL from all confirmed trade fills
 */
async function getTotalRealizedPnl(instanceId: string): Promise<number> {
  const result = await prisma.tradeFill.aggregate({
    where: {
      attempt: {
        instanceId,
        status: 'CONFIRMED',
      },
      realizedPnl: { not: null },
    },
    _sum: {
      realizedPnl: true,
    },
  });

  return result._sum.realizedPnl ?? 0;
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

/**
 * Apply regime-based adjustments to bot config
 */
function applyRegimeAdjustments(
  botConfig: BotConfig,
  regime: MarketRegime
): BotConfig {
  // For now, return config as-is - regime adjustments are handled by the classifier's recommendation
  // In a more sophisticated implementation, we could clone and modify the config here
  return botConfig;
}

// === SCALE-OUT EXIT FUNCTIONS ===

/**
 * Build CompoundingCalculator from bot config
 */
function buildCompoundingCalculator(botConfig: BotConfig): CompoundingCalculator {
  // Map DB CompoundingMode to core CompoundingMode type
  const mode: CompoundingMode = (botConfig.compoundingMode as CompoundingMode) || 'FIXED';

  const compoundingConfig: CompoundingConfig = {
    mode,
    fixedTradeSize: botConfig.tradeSize,
    initialTradeSizeUsdc: botConfig.initialTradeSizeUsdc,
    reservePct: botConfig.compoundingReservePct,
    minTradeNotional: botConfig.minTradeNotional,
    minQuoteReserve: botConfig.minQuoteReserve,
  };

  return new CompoundingCalculator(compoundingConfig);
}

/**
 * Build ScaleOutManager from bot config
 */
function buildScaleOutManager(
  botConfig: BotConfig,
  costCalculator: ExecutionCostCalculator
): ScaleOutManager {
  const scaleOutConfig: ScaleOutConfig = {
    exitMode: botConfig.exitMode as 'FULL_EXIT' | 'SCALE_OUT',
    primaryPct: botConfig.scaleOutPrimaryPct,
    secondaryPct: botConfig.scaleOutSecondaryPct,
    secondaryTargetPct: botConfig.scaleOutSecondaryTargetPct,
    trailingEnabled: botConfig.scaleOutTrailingEnabled,
    minExtensionPct: botConfig.scaleOutMinExtensionPct,
    minDollarProfit: botConfig.scaleOutMinDollarProfit,
    trailingStopPct: botConfig.scaleOutTrailingStopPct,
    allowWhale: botConfig.scaleOutAllowWhale,
    // Multi-step scale-out fields
    scaleOutSteps: botConfig.scaleOutSteps,
    scaleOutRangePct: botConfig.scaleOutRangePct,
    scaleOutSpacingPct: botConfig.scaleOutSpacingPct,
  };

  return new ScaleOutManager(scaleOutConfig, {
    estimatedDexFeePct: botConfig.estimatedDexFeePct,
    priorityFeeImpactPct: botConfig.priorityFeeImpactPct,
    minimumNetEdgePct: botConfig.minimumNetEdgePct,
    maxExecutionCostPct: botConfig.maxExecutionCostPct,
    baseSellTargetPct: botConfig.sellRisePct,
    sellTargetTier1Pct: botConfig.sellTargetTier1Pct,
    sellTargetTier2Pct: botConfig.sellTargetTier2Pct,
  });
}

/**
 * Build extension state data from instance
 */
function buildExtensionStateData(instance: BotInstance): ExtensionStateData {
  return {
    state: instance.extensionState as 'NONE' | 'ACTIVE' | 'TRAILING',
    baseQty: instance.extensionBaseQty,
    baseCost: instance.extensionBaseCost,
    entryPrice: instance.extensionEntryPrice,
    peakPrice: instance.extensionPeakPrice,
    startedAt: instance.extensionStartedAt,
    primaryPnl: instance.extensionPrimaryPnl,
    // Multi-step fields (initialized empty for backward compatibility)
    currentStep: 0,
    completedSteps: [],
    levels: [],
  };
}

/**
 * Execute sell with scale-out logic
 */
async function executeSellWithScaleOut(
  instanceId: string,
  action: StrategyAction & { type: 'SELL' },
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number,
  currentRegime: MarketRegime,
  quote: QuoteResult
): Promise<void> {
  const scaleOutManager = buildScaleOutManager(botConfig, costCalculator);

  // Evaluate capital tier
  const tierEvaluator = new CapitalTierEvaluator(
    {
      tier1Usdc: botConfig.capitalTier1Usdc,
      tier2Usdc: botConfig.capitalTier2Usdc,
      tier3Usdc: botConfig.capitalTier3Usdc,
    },
    {
      maxSingleTradeSlippagePct: botConfig.maxSingleTradeSlippagePct,
      targetChunkSlippagePct: botConfig.targetChunkSlippagePct,
      minChunkSizeUsdc: botConfig.minChunkSizeUsdc,
      maxChunksPerSplit: botConfig.maxChunksPerSplit,
    }
  );
  const tierResult = tierEvaluator.evaluate(portfolioValueUsdc, instance.totalBaseCost);

  // Check scale-out eligibility
  const scaleOutCheck = scaleOutManager.isScaleOutAllowed(
    currentRegime as 'UNKNOWN' | 'TREND' | 'CHOP' | 'CHAOS',
    tierResult.tier
  );

  // Calculate execution cost for net edge
  const costResult = costCalculator.calculateExecutionCost(quote);

  // Evaluate scale-out decision
  const extensionState = buildExtensionStateData(instance);
  const scaleOutDecision = scaleOutManager.evaluateSellDecision(
    instance.totalBaseQty,
    instance.totalBaseCost,
    currentPrice,
    instance.lastBuyPrice ?? currentPrice,
    quote,
    currentRegime as 'UNKNOWN' | 'TREND' | 'CHOP' | 'CHAOS',
    tierResult.tier,
    extensionState
  );

  logger.info('Scale-out decision', {
    instanceId,
    exitMode: botConfig.exitMode,
    regime: currentRegime,
    capitalTier: tierResult.tier,
    netEdgePct: costResult.netEdgePct,
    primaryAllowed: scaleOutCheck.allowed,
    extensionAllowed: scaleOutCheck.allowed && scaleOutDecision.shouldStartExtension,
    reason: scaleOutDecision.reason,
  });

  switch (scaleOutDecision.action) {
    case 'FULL_EXIT':
      // Check if runner should be created instead of full exit
      if (botConfig.runnerEnabled && instance.runnerState === 'NONE' && instance.totalBaseQty > 0) {
        // Execute partial CORE sell and create runner
        await executeCoreExitWithRunner(
          instanceId,
          action,
          instance,
          adapter,
          botConfig,
          pnlCalculator,
          costCalculator,
          currentPrice,
          portfolioValueUsdc
        );
      } else {
        // Standard full exit (no runner)
        await executeTradeWithCostGating(
          instanceId,
          action,
          adapter,
          botConfig,
          pnlCalculator,
          costCalculator,
          currentPrice,
          portfolioValueUsdc,
          currentRegime
        );
      }
      break;

    case 'PRIMARY_EXIT':
      // Execute primary exit and start extension
      await executePrimaryExit(
        instanceId,
        scaleOutDecision,
        instance,
        adapter,
        botConfig,
        pnlCalculator,
        costCalculator,
        currentPrice,
        portfolioValueUsdc
      );
      break;

    case 'HOLD_EXTENSION':
      // No action - continue holding extension
      logger.debug('Holding extension', { instanceId, reason: scaleOutDecision.reason });
      break;

    case 'EXTENSION_EXIT':
    case 'ABORT_SCALE_OUT':
      // Exit extension position
      await executeExtensionExit(
        instanceId,
        scaleOutDecision,
        instance,
        adapter,
        botConfig,
        pnlCalculator,
        costCalculator,
        currentPrice,
        portfolioValueUsdc
      );
      break;
  }
}

/**
 * Execute primary exit (65% sell) and start extension for remainder
 */
async function executePrimaryExit(
  instanceId: string,
  decision: ScaleOutDecision,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number
): Promise<void> {
  const side: TradeSide = 'SELL';
  const clientOrderId = generateClientOrderId(instanceId, side, Date.now());

  // Check for duplicate
  const existing = await prisma.tradeAttempt.findUnique({
    where: { clientOrderId },
  });
  if (existing) {
    logger.warn('Duplicate order detected', { clientOrderId });
    return;
  }

  // Get quote for primary portion
  const primaryQuote = await adapter.getQuote({
    side,
    amount: decision.sellQty,
    amountIsBase: true,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // Verify execution cost
  const costResult = costCalculator.calculateExecutionCost(primaryQuote);
  if (!costResult.shouldExecute) {
    logger.warn('Primary exit rejected by cost gating', {
      instanceId,
      clientOrderId,
      reason: costResult.rejectionReason,
    });
    return;
  }

  // Create trade attempt
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      quotePrice: primaryQuote.price,
      quotedBaseQty: primaryQuote.inputAmount,
      quotedQuoteQty: primaryQuote.outputAmount,
      quotedPriceImpactBps: primaryQuote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  // Check dry-run mode - create synthetic primary exit
  if (botConfig.dryRunMode) {
    logger.info('DRY RUN: Synthetic primary exit executed', {
      clientOrderId,
      sellQty: decision.sellQty,
      extensionQty: decision.extensionQty,
    });

    // Create synthetic fill for primary exit
    const syntheticFill: FillForPnL = {
      side,
      baseQty: decision.sellQty,
      quoteQty: decision.sellQty * currentPrice,
      executedPrice: currentPrice,
      feeQuote: 0,
      feeNativeUsdc: 0.001,
    };

    const costBasisPerUnit = instance.totalBaseCost / instance.totalBaseQty;
    const primaryPnlResult = pnlCalculator.calculateRealizedPnL(syntheticFill, costBasisPerUnit);

    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        isDryRun: true,
        confirmedAt: new Date(),
      },
    });

    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: syntheticFill.baseQty,
        quoteQty: syntheticFill.quoteQty,
        executedPrice: currentPrice,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: 0.001,
        actualSlippageBps: null,
        costBasisPerUnit,
        realizedPnl: primaryPnlResult.realizedPnl,
        txSignature: `DRY_RUN_PRIMARY_${Date.now()}`,
        executedAt: new Date(),
      },
    });

    // Update instance after primary exit
    await updateInstanceAfterPrimaryExit(instanceId, syntheticFill, primaryPnlResult.realizedPnl, instance);

    // Start extension with remaining portion
    await startExtension(instanceId, decision, currentPrice, primaryPnlResult.realizedPnl);

    logger.info('Synthetic primary exit recorded, extension started', {
      instanceId,
      primaryQty: decision.sellQty,
      primaryPnl: primaryPnlResult.realizedPnl,
      extensionQty: decision.extensionQty,
      isDryRun: true,
    });
    return;
  }

  // Determine if we should split based on capital tier
  const tierEvaluator = new CapitalTierEvaluator(
    {
      tier1Usdc: botConfig.capitalTier1Usdc,
      tier2Usdc: botConfig.capitalTier2Usdc,
      tier3Usdc: botConfig.capitalTier3Usdc,
    },
    {
      maxSingleTradeSlippagePct: botConfig.maxSingleTradeSlippagePct,
      targetChunkSlippagePct: botConfig.targetChunkSlippagePct,
      minChunkSizeUsdc: botConfig.minChunkSizeUsdc,
      maxChunksPerSplit: botConfig.maxChunksPerSplit,
    }
  );

  const primaryValueUsdc = decision.sellQty * currentPrice;
  const tierResult = tierEvaluator.evaluate(portfolioValueUsdc, primaryValueUsdc);

  // Execute primary sell
  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  let primaryFill: FillForPnL;

  if (tierResult.shouldSplit) {
    // Use split execution for large primary exits
    logger.info('Using split execution for primary exit', {
      instanceId,
      primaryValueUsdc,
      tier: tierResult.tier,
    });

    const splitResult = await executeSplitForScaleOut(
      instanceId,
      tradeAttempt.id,
      side,
      primaryValueUsdc,
      adapter,
      botConfig,
      portfolioValueUsdc,
      clientOrderId
    );

    if (!splitResult) {
      // Split execution failed
      return;
    }

    primaryFill = {
      side,
      baseQty: splitResult.totalBaseExecuted,
      quoteQty: splitResult.totalQuoteExecuted,
      executedPrice: splitResult.weightedAvgPrice || currentPrice,
      feeQuote: 0,
      feeNativeUsdc: splitResult.totalFees,
    };
  } else {
    // Single-shot execution
    const result = await adapter.executeSwap({
      quote: primaryQuote,
      clientOrderId,
    });

    if (!result.success) {
      await handleTradeFailure(instanceId, tradeAttempt.id, botConfig, result);
      return;
    }

    primaryFill = {
      side,
      baseQty: result.inputAmount,
      quoteQty: result.outputAmount,
      executedPrice: result.executedPrice,
      feeQuote: 0,
      feeNativeUsdc: result.feeNativeUsdc,
    };

    // Update trade attempt status
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        txSignature: result.txSignature,
        confirmedAt: new Date(),
      },
    });
  }

  // Calculate PnL for primary portion only
  const costBasisPerUnit = instance.totalBaseCost / instance.totalBaseQty;
  const primaryPnlResult = pnlCalculator.calculateRealizedPnL(primaryFill, costBasisPerUnit);

  // Record fill (if not already recorded by split execution)
  if (!tierResult.shouldSplit) {
    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: primaryFill.baseQty,
        quoteQty: primaryFill.quoteQty,
        executedPrice: primaryFill.executedPrice,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: primaryFill.feeNativeUsdc,
        actualSlippageBps: null,
        costBasisPerUnit,
        realizedPnl: primaryPnlResult.realizedPnl,
        txSignature: 'SCALE_OUT_PRIMARY',
        executedAt: new Date(),
      },
    });
  }

  // Update instance - primary portion sold, extension started
  await updateInstanceAfterPrimaryExit(
    instanceId,
    primaryFill,
    primaryPnlResult.realizedPnl,
    instance
  );

  // Start extension with remaining portion
  await startExtension(instanceId, decision, currentPrice, primaryPnlResult.realizedPnl);

  // Send alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );
  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_EXECUTED',
    title: 'Primary Exit (Scale-Out)',
    message: `Sold ${primaryFill.baseQty.toFixed(4)} @ ${primaryFill.executedPrice.toFixed(4)} USDC. Extension started with ${decision.extensionQty.toFixed(4)} remaining.`,
    metadata: {
      side,
      primaryQty: primaryFill.baseQty,
      extensionQty: decision.extensionQty,
      price: primaryFill.executedPrice,
      realizedPnl: primaryPnlResult.realizedPnl,
      splitExecution: tierResult.shouldSplit,
    },
  });

  logger.info('Primary exit executed, extension started', {
    instanceId,
    primaryQty: primaryFill.baseQty,
    primaryPnl: primaryPnlResult.realizedPnl,
    extensionQty: decision.extensionQty,
    extensionCost: decision.extensionCost,
    splitExecution: tierResult.shouldSplit,
  });
}

/**
 * Execute CORE exit with runner creation (two-leg position model)
 * Sells primarySellPct (80%) of position and creates runner with runnerPct (20%)
 */
async function executeCoreExitWithRunner(
  instanceId: string,
  action: StrategyAction & { type: 'SELL' },
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number
): Promise<void> {
  const side: TradeSide = 'SELL';
  const clientOrderId = generateClientOrderId(instanceId, `CORE_${side}`, Date.now());

  // Check for duplicate
  const existing = await prisma.tradeAttempt.findUnique({
    where: { clientOrderId },
  });
  if (existing) {
    logger.warn('Duplicate CORE order detected', { clientOrderId });
    return;
  }

  // Calculate CORE (primary) and RUNNER portions
  const totalBaseQty = instance.totalBaseQty;
  const totalBaseCost = instance.totalBaseCost;
  const primaryPct = botConfig.primarySellPct / 100; // e.g., 80 -> 0.80
  const runnerPct = botConfig.runnerPct / 100; // e.g., 20 -> 0.20

  const coreQty = totalBaseQty * primaryPct;
  const runnerQty = totalBaseQty * runnerPct;
  const coreCost = totalBaseCost * primaryPct;
  const runnerCost = totalBaseCost * runnerPct;

  logger.info('CORE exit with runner', {
    instanceId,
    totalBaseQty,
    primaryPct,
    runnerPct,
    coreQty,
    runnerQty,
    coreCost,
    runnerCost,
  });

  // Get quote for CORE portion
  const coreQuote = await adapter.getQuote({
    side,
    amount: coreQty,
    amountIsBase: true,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // Verify execution cost
  const costResult = costCalculator.calculateExecutionCost(coreQuote);
  if (!costResult.shouldExecute) {
    logger.warn('CORE exit rejected by cost gating', {
      instanceId,
      clientOrderId,
      reason: costResult.rejectionReason,
    });
    return;
  }

  // Create trade attempt
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      isDryRun: botConfig.dryRunMode,
      quotePrice: coreQuote.price,
      quotedBaseQty: coreQuote.inputAmount,
      quotedQuoteQty: coreQuote.outputAmount,
      quotedPriceImpactBps: coreQuote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  // Handle dry-run mode
  if (botConfig.dryRunMode) {
    logger.info('DRY RUN: Synthetic CORE exit with runner', {
      clientOrderId,
      coreQty,
      runnerQty,
    });

    // Create synthetic fill for CORE
    const costBasisPerUnit = totalBaseCost / totalBaseQty;
    const realizedPnl = (currentPrice - costBasisPerUnit) * coreQty;

    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });

    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: coreQty,
        quoteQty: coreQty * currentPrice,
        executedPrice: currentPrice,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: 0.001,
        costBasisPerUnit,
        realizedPnl,
        txSignature: `DRY_RUN_CORE_${Date.now()}`,
        executedAt: new Date(),
      },
    });

    // Update instance after CORE exit - reduce position to runner qty only
    await updateInstanceAfterCoreExit(instanceId, coreQty, coreCost, realizedPnl, instance);

    // Create runner leg with remaining portion
    await createRunnerLeg(instanceId, runnerQty, runnerCost, currentPrice);

    logger.info('Synthetic CORE exit recorded, runner created', {
      instanceId,
      coreQty,
      corePnl: realizedPnl,
      runnerQty,
      runnerCost,
      isDryRun: true,
    });
    return;
  }

  // Real trade execution
  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  try {
    const result = await adapter.executeSwap({
      quote: coreQuote,
      clientOrderId,
    });

    if (!result.success) {
      await handleTradeFailure(instanceId, tradeAttempt.id, botConfig, result);
      return;
    }

    // Calculate PnL for CORE portion
    const costBasisPerUnit = totalBaseCost / totalBaseQty;
    const coreFill: FillForPnL = {
      side,
      baseQty: result.inputAmount,
      quoteQty: result.outputAmount,
      executedPrice: result.executedPrice,
      feeQuote: 0,
      feeNativeUsdc: result.feeNativeUsdc,
    };
    const pnlResult = pnlCalculator.calculateRealizedPnL(coreFill, costBasisPerUnit);

    // Update trade attempt status
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        txSignature: result.txSignature,
        confirmedAt: new Date(),
      },
    });

    // Record fill
    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: coreFill.baseQty,
        quoteQty: coreFill.quoteQty,
        executedPrice: coreFill.executedPrice,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: coreFill.feeNativeUsdc,
        actualSlippageBps: null,
        costBasisPerUnit,
        realizedPnl: pnlResult.realizedPnl,
        txSignature: result.txSignature,
        executedAt: new Date(),
      },
    });

    // Update instance - CORE portion sold, runner remains
    await updateInstanceAfterCoreExit(instanceId, coreFill.baseQty, coreCost, pnlResult.realizedPnl, instance);

    // Create runner leg with remaining portion
    await createRunnerLeg(instanceId, runnerQty, runnerCost, result.executedPrice);

    // Send alert
    const alertService = new AlertService(
      botConfig.webhookUrl ?? config.alerts.webhookUrl,
      botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
    );
    await alertService.sendAlert({
      instanceId,
      type: 'TRADE_EXECUTED',
      title: 'CORE Exit (Runner Created)',
      message: `Sold ${coreFill.baseQty.toFixed(4)} @ ${coreFill.executedPrice.toFixed(4)} USDC. Runner started with ${runnerQty.toFixed(4)} remaining.`,
      metadata: {
        side,
        coreQty: coreFill.baseQty,
        runnerQty,
        price: coreFill.executedPrice,
        realizedPnl: pnlResult.realizedPnl,
      },
    });

    logger.info('CORE exit executed, runner created', {
      instanceId,
      coreQty: coreFill.baseQty,
      corePnl: pnlResult.realizedPnl,
      runnerQty,
      runnerCost,
      runnerEntryPrice: result.executedPrice,
    });
  } catch (error) {
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'FAILED',
        errorMessage: (error as Error).message,
      },
    });

    logger.error('CORE exit error', {
      instanceId,
      clientOrderId,
      error: (error as Error).message,
    });
  }
}

/**
 * Update instance after CORE exit (reduces position, leaves runner qty separate)
 */
async function updateInstanceAfterCoreExit(
  instanceId: string,
  coreSoldQty: number,
  coreSoldCost: number,
  realizedPnl: number,
  instance: BotInstance
): Promise<void> {
  // The runner qty is NOT included in totalBaseQty/totalBaseCost after this
  // The instance tracking shows CORE position only
  const newTotalBaseQty = instance.totalBaseQty - coreSoldQty;
  const newTotalBaseCost = instance.totalBaseCost - coreSoldCost;

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      lastSellPrice: instance.lastBuyPrice, // Track the CORE exit
      lastTradeAt: new Date(),
      totalSells: { increment: 1 },
      totalSellVolume: { increment: coreSoldQty },
      dailyRealizedPnl: { increment: realizedPnl },
      cumulativeRealizedPnL: { increment: realizedPnl },
      // Reduce CORE tracking (runner tracked separately)
      totalBaseQty: newTotalBaseQty,
      totalBaseCost: newTotalBaseCost,
      consecutiveFailures: 0,
    },
  });

  logger.info('Instance updated after CORE exit', {
    instanceId,
    coreSoldQty,
    realizedPnl,
    newTotalBaseQty,
    newTotalBaseCost,
  });
}

/**
 * Execute extension exit (remaining 35% or forced exit)
 */
async function executeExtensionExit(
  instanceId: string,
  decision: ScaleOutDecision,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number
): Promise<void> {
  const side: TradeSide = 'SELL';
  const clientOrderId = generateClientOrderId(instanceId, side, Date.now());

  // Check for duplicate
  const existing = await prisma.tradeAttempt.findUnique({
    where: { clientOrderId },
  });
  if (existing) {
    logger.warn('Duplicate order detected', { clientOrderId });
    return;
  }

  // Get quote for extension portion
  const extensionQuote = await adapter.getQuote({
    side,
    amount: instance.extensionBaseQty,
    amountIsBase: true,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // Create trade attempt
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      quotePrice: extensionQuote.price,
      quotedBaseQty: extensionQuote.inputAmount,
      quotedQuoteQty: extensionQuote.outputAmount,
      quotedPriceImpactBps: extensionQuote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  // Check dry-run mode - create synthetic extension exit
  if (botConfig.dryRunMode) {
    logger.info('DRY RUN: Synthetic extension exit executed', {
      clientOrderId,
      extensionQty: instance.extensionBaseQty,
      reason: decision.reason,
    });

    // Create synthetic fill for extension exit
    const syntheticFill: FillForPnL = {
      side,
      baseQty: instance.extensionBaseQty,
      quoteQty: instance.extensionBaseQty * currentPrice,
      executedPrice: currentPrice,
      feeQuote: 0,
      feeNativeUsdc: 0.001,
    };

    const costBasisPerUnit = instance.extensionBaseCost / instance.extensionBaseQty;
    const extensionPnlResult = pnlCalculator.calculateRealizedPnL(syntheticFill, costBasisPerUnit);

    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'CONFIRMED',
        isDryRun: true,
        confirmedAt: new Date(),
      },
    });

    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: syntheticFill.baseQty,
        quoteQty: syntheticFill.quoteQty,
        executedPrice: currentPrice,
        feeQuote: 0,
        feeNative: 0,
        feeNativeUsdc: 0.001,
        actualSlippageBps: null,
        costBasisPerUnit,
        realizedPnl: extensionPnlResult.realizedPnl,
        txSignature: `DRY_RUN_EXTENSION_${Date.now()}`,
        executedAt: new Date(),
      },
    });

    const totalCyclePnl = instance.extensionPrimaryPnl + extensionPnlResult.realizedPnl;

    // Clear extension state
    await clearExtension(instanceId, extensionPnlResult.realizedPnl);

    logger.info('Synthetic extension exit recorded, scale-out complete', {
      instanceId,
      extensionQty: syntheticFill.baseQty,
      extensionPnl: extensionPnlResult.realizedPnl,
      primaryPnl: instance.extensionPrimaryPnl,
      totalCyclePnl,
      isDryRun: true,
    });
    return;
  }

  // Execute extension sell
  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });

  const result = await adapter.executeSwap({
    quote: extensionQuote,
    clientOrderId,
  });

  if (!result.success) {
    await handleTradeFailure(instanceId, tradeAttempt.id, botConfig, result);
    // Keep extension state on failure - will retry next cycle
    return;
  }

  // Process extension fill
  const extensionFill: FillForPnL = {
    side,
    baseQty: result.inputAmount,
    quoteQty: result.outputAmount,
    executedPrice: result.executedPrice,
    feeQuote: 0,
    feeNativeUsdc: result.feeNativeUsdc,
  };

  // Calculate PnL for extension portion
  const costBasisPerUnit = instance.extensionBaseCost / instance.extensionBaseQty;
  const extensionPnlResult = pnlCalculator.calculateRealizedPnL(extensionFill, costBasisPerUnit);

  // Record fill
  await prisma.tradeFill.create({
    data: {
      attemptId: tradeAttempt.id,
      side,
      baseQty: extensionFill.baseQty,
      quoteQty: extensionFill.quoteQty,
      executedPrice: result.executedPrice,
      feeQuote: 0,
      feeNative: result.feeNative,
      feeNativeUsdc: result.feeNativeUsdc,
      actualSlippageBps: result.actualSlippageBps,
      costBasisPerUnit,
      realizedPnl: extensionPnlResult.realizedPnl,
      txSignature: result.txSignature,
      blockNumber: result.blockNumber,
      slot: result.slot,
      executedAt: new Date(),
    },
  });

  await prisma.tradeAttempt.update({
    where: { id: tradeAttempt.id },
    data: {
      status: 'CONFIRMED',
      txSignature: result.txSignature,
      confirmedAt: new Date(),
    },
  });

  // Clear extension state and finalize
  await clearExtension(instanceId, extensionPnlResult.realizedPnl);

  // Send alert
  const alertService = new AlertService(
    botConfig.webhookUrl ?? config.alerts.webhookUrl,
    botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
  );

  const totalCyclePnl = instance.extensionPrimaryPnl + extensionPnlResult.realizedPnl;

  await alertService.sendAlert({
    instanceId,
    type: 'TRADE_EXECUTED',
    title: 'Extension Exit (Scale-Out Complete)',
    message: `Extension sold ${extensionFill.baseQty.toFixed(4)} @ ${result.executedPrice.toFixed(4)} USDC. Total cycle PnL: $${totalCyclePnl.toFixed(2)}`,
    metadata: {
      side,
      extensionQty: extensionFill.baseQty,
      price: result.executedPrice,
      txSignature: result.txSignature,
      extensionPnl: extensionPnlResult.realizedPnl,
      primaryPnl: instance.extensionPrimaryPnl,
      totalCyclePnl,
      exitReason: decision.reason,
    },
  });

  logger.info('Extension exit executed, scale-out complete', {
    instanceId,
    extensionQty: extensionFill.baseQty,
    extensionPnl: extensionPnlResult.realizedPnl,
    primaryPnl: instance.extensionPrimaryPnl,
    totalCyclePnl,
    exitReason: decision.reason,
  });
}

/**
 * Execute split trade for scale-out (returns result or null on failure)
 */
async function executeSplitForScaleOut(
  instanceId: string,
  tradeAttemptId: string,
  side: TradeSide,
  totalAmountUsdc: number,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  portfolioValueUsdc: number,
  clientOrderId: string
): Promise<SplitExecutionResult | null> {
  const splitExecutor = buildSplitExecutor(botConfig);

  const splitResult = await splitExecutor.execute(
    adapter,
    side,
    totalAmountUsdc,
    portfolioValueUsdc,
    botConfig.maxSlippageBps,
    clientOrderId,
    botConfig.allowedSources,
    botConfig.excludedSources
  );

  // Record split execution
  const splitExecution = await prisma.splitExecution.create({
    data: {
      instanceId,
      parentOrderId: clientOrderId,
      side,
      totalIntendedSize: totalAmountUsdc,
      totalChunks: splitResult.totalChunks,
      completedChunks: splitResult.completedChunks,
      abortedChunks: splitResult.abortedChunks,
      totalBaseExecuted: splitResult.totalBaseExecuted,
      totalQuoteExecuted: splitResult.totalQuoteExecuted,
      weightedAvgPrice: splitResult.weightedAvgPrice,
      totalFees: splitResult.totalFees,
      totalSlippageCost: splitResult.totalSlippageCost,
      status: splitResult.success ? 'CONFIRMED' : 'FAILED',
      abortReason: splitResult.abortReason,
      startedAt: splitResult.startedAt,
      completedAt: splitResult.completedAt,
    },
  });

  // Record individual chunks
  for (const chunk of splitResult.chunks) {
    await prisma.splitChunk.create({
      data: {
        splitExecutionId: splitExecution.id,
        chunkIndex: chunk.chunkIndex,
        intendedSize: totalAmountUsdc / splitResult.totalChunks,
        quotedPrice: chunk.quote?.price,
        quotedSlippageBps: chunk.quote?.priceImpactBps,
        status: chunk.success ? 'CONFIRMED' : 'FAILED',
        executedBaseQty: chunk.executedBaseQty || null,
        executedQuoteQty: chunk.executedQuoteQty || null,
        executedPrice: chunk.executedPrice || null,
        actualSlippageBps: chunk.actualSlippageBps,
        feeNativeUsdc: chunk.feeNativeUsdc || null,
        txSignature: chunk.swap?.txSignature,
        errorMessage: chunk.error,
        attemptedAt: chunk.attemptedAt,
        completedAt: chunk.completedAt,
      },
    });
  }

  if (!splitResult.success && splitResult.completedChunks === 0) {
    // Complete failure
    await prisma.tradeAttempt.update({
      where: { id: tradeAttemptId },
      data: {
        status: 'FAILED',
        errorCode: 'SPLIT_EXECUTION_FAILED',
        errorMessage: splitResult.abortReason,
      },
    });

    await prisma.botInstance.update({
      where: { id: instanceId },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: splitResult.abortReason,
        lastErrorAt: new Date(),
      },
    });

    const alertService = new AlertService(
      botConfig.webhookUrl ?? config.alerts.webhookUrl,
      botConfig.discordWebhookUrl ?? config.alerts.discordWebhookUrl
    );
    await alertService.sendAlert({
      instanceId,
      type: 'TRADE_FAILED',
      title: 'Scale-Out Split Trade Failed',
      message: `${side} split trade failed: ${splitResult.abortReason}`,
      metadata: { clientOrderId, side, chunks: splitResult.totalChunks },
    });

    return null;
  }

  // Update trade attempt for partial or full success
  await prisma.tradeAttempt.update({
    where: { id: tradeAttemptId },
    data: {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      errorMessage: splitResult.abortReason ? `Partial: ${splitResult.abortReason}` : null,
    },
  });

  return splitResult;
}

/**
 * Check if extension should exit (called each cycle when in extension state)
 */
async function checkExtensionExit(
  instanceId: string,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number,
  currentRegime: MarketRegime,
  quote: QuoteResult
): Promise<boolean> {
  const scaleOutManager = buildScaleOutManager(botConfig, costCalculator);

  // Evaluate capital tier
  const tierEvaluator = new CapitalTierEvaluator(
    {
      tier1Usdc: botConfig.capitalTier1Usdc,
      tier2Usdc: botConfig.capitalTier2Usdc,
      tier3Usdc: botConfig.capitalTier3Usdc,
    },
    {
      maxSingleTradeSlippagePct: botConfig.maxSingleTradeSlippagePct,
      targetChunkSlippagePct: botConfig.targetChunkSlippagePct,
      minChunkSizeUsdc: botConfig.minChunkSizeUsdc,
      maxChunksPerSplit: botConfig.maxChunksPerSplit,
    }
  );
  const tierResult = tierEvaluator.evaluate(portfolioValueUsdc, instance.extensionBaseCost);

  // Build extension state
  const extensionState = buildExtensionStateData(instance);

  // Evaluate using scale-out manager
  const decision = scaleOutManager.evaluateSellDecision(
    instance.extensionBaseQty,
    instance.extensionBaseCost,
    currentPrice,
    instance.extensionEntryPrice ?? currentPrice,
    quote,
    currentRegime as 'UNKNOWN' | 'TREND' | 'CHOP' | 'CHAOS',
    tierResult.tier,
    extensionState
  );

  logger.debug('Extension check', {
    instanceId,
    action: decision.action,
    reason: decision.reason,
  });

  if (decision.action === 'EXTENSION_EXIT' || decision.action === 'ABORT_SCALE_OUT') {
    await executeExtensionExit(
      instanceId,
      decision,
      instance,
      adapter,
      botConfig,
      pnlCalculator,
      costCalculator,
      currentPrice,
      portfolioValueUsdc
    );
    return true;
  }

  return false; // Hold extension
}

/**
 * Force extension exit (e.g., for CHAOS regime)
 */
async function forceExtensionExit(
  instanceId: string,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  currentPrice: number,
  reason: string
): Promise<void> {
  logger.warn('Forcing extension exit', { instanceId, reason });

  const costCalculator = buildCostCalculator(botConfig);

  const forcedDecision: ScaleOutDecision = {
    action: 'ABORT_SCALE_OUT',
    sellQty: instance.extensionBaseQty,
    reason: `Forced: ${reason}`,
    expectedPnl: 0, // Will be calculated during execution
    isExtensionExit: true,
    shouldStartExtension: false,
    extensionQty: 0,
    extensionCost: 0,
  };

  await executeExtensionExit(
    instanceId,
    forcedDecision,
    instance,
    adapter,
    botConfig,
    pnlCalculator,
    costCalculator,
    currentPrice,
    0 // portfolio value not critical for forced exit
  );
}

/**
 * Update peak price for trailing stop
 */
async function updateExtensionPeakPrice(
  instanceId: string,
  instance: BotInstance,
  currentPrice: number
): Promise<void> {
  if (instance.extensionState === 'NONE') return;

  const newPeak = Math.max(instance.extensionPeakPrice ?? 0, currentPrice);

  if (newPeak > (instance.extensionPeakPrice ?? 0)) {
    await prisma.botInstance.update({
      where: { id: instanceId },
      data: { extensionPeakPrice: newPeak },
    });

    logger.debug('Extension peak updated', {
      instanceId,
      oldPeak: instance.extensionPeakPrice,
      newPeak,
    });
  }
}

/**
 * Start extension after primary exit
 */
async function startExtension(
  instanceId: string,
  decision: ScaleOutDecision,
  entryPrice: number,
  primaryPnl: number
): Promise<void> {
  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      extensionState: 'ACTIVE',
      extensionBaseQty: decision.extensionQty,
      extensionBaseCost: decision.extensionCost,
      extensionEntryPrice: entryPrice,
      extensionPeakPrice: entryPrice,
      extensionStartedAt: new Date(),
      extensionPrimaryPnl: primaryPnl,
    },
  });

  logger.info('Extension started', {
    instanceId,
    qty: decision.extensionQty,
    cost: decision.extensionCost,
    entryPrice,
    primaryPnl,
  });
}

/**
 * Clear extension state after exit
 */
async function clearExtension(
  instanceId: string,
  extensionPnl: number
): Promise<void> {
  // Get current instance to calculate total PnL
  const instance = await prisma.botInstance.findUnique({
    where: { id: instanceId },
  });

  const totalPnl = (instance?.extensionPrimaryPnl ?? 0) + extensionPnl;

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      extensionState: 'NONE',
      extensionBaseQty: 0,
      extensionBaseCost: 0,
      extensionEntryPrice: null,
      extensionPeakPrice: null,
      extensionStartedAt: null,
      extensionPrimaryPnl: 0,
      // Update total position to zero after scale-out complete
      totalBaseQty: 0,
      totalBaseCost: 0,
      // Add extension PnL to daily realized
      dailyRealizedPnl: { increment: extensionPnl },
    },
  });

  logger.info('Extension cleared', {
    instanceId,
    extensionPnl,
    totalCyclePnl: totalPnl,
  });
}

/**
 * Update instance after primary exit (partial sell)
 */
async function updateInstanceAfterPrimaryExit(
  instanceId: string,
  fill: FillForPnL,
  realizedPnl: number,
  instance: BotInstance
): Promise<void> {
  const now = new Date();

  // Calculate remaining position after primary sell
  const remainingQty = instance.totalBaseQty - fill.baseQty;
  const remainingCost = instance.totalBaseCost * (remainingQty / instance.totalBaseQty);

  const updateData: Record<string, unknown> = {
    lastTradeAt: now,
    lastSellPrice: fill.executedPrice,
    consecutiveFailures: 0,
    tradesThisHour: { increment: 1 },
    totalSells: { increment: 1 },
    totalSellVolume: { increment: fill.quoteQty },
    dailyRealizedPnl: { increment: realizedPnl },
    // Update to remaining position (extension portion)
    totalBaseQty: remainingQty,
    totalBaseCost: remainingCost,
  };

  // Reset hourly counter if needed
  if (!isSameHour(instance.hourlyResetAt, now)) {
    updateData.tradesThisHour = 1;
    updateData.hourlyResetAt = now;
  }

  // Reset daily PnL if needed
  if (!isSameDay(instance.dailyResetAt, now)) {
    updateData.dailyRealizedPnl = realizedPnl;
    updateData.dailyResetAt = now;
  }

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: updateData,
  });
}

// ============================================================
// RUNNER (TWO-LEG POSITION MODEL) FUNCTIONS
// ============================================================

/**
 * Build RunnerManager from bot config
 */
function buildRunnerManager(
  botConfig: BotConfig,
  costCalculator: ExecutionCostCalculator
): RunnerManager {
  const runnerConfig: RunnerConfig = {
    enabled: botConfig.runnerEnabled,
    runnerPct: botConfig.runnerPct,
    mode: botConfig.runnerMode as 'LADDER' | 'TRAILING',
    ladderTargets: botConfig.runnerLadderTargets,
    ladderPercents: botConfig.runnerLadderPercents,
    trailActivatePct: botConfig.runnerTrailActivatePct,
    trailStopPct: botConfig.runnerTrailStopPct,
    minDollarProfit: botConfig.runnerMinDollarProfit,
  };

  const costConfig: ExecutionCostConfig = {
    baseSellTargetPct: botConfig.sellRisePct,
    minimumNetEdgePct: botConfig.minimumNetEdgePct,
    estimatedDexFeePct: botConfig.estimatedDexFeePct,
    priorityFeeImpactPct: botConfig.priorityFeeImpactPct,
    sellTargetTier1Pct: botConfig.sellTargetTier1Pct,
    sellTargetTier2Pct: botConfig.sellTargetTier2Pct,
    maxExecutionCostPct: botConfig.maxExecutionCostPct,
  };

  return new RunnerManager(runnerConfig, costConfig);
}

/**
 * Build runner state data from instance
 */
function buildRunnerStateData(instance: BotInstance): RunnerStateData {
  return {
    state: (instance.runnerState as 'NONE' | 'ACTIVE') ?? 'NONE',
    qty: instance.runnerQty ?? 0,
    costBasis: instance.runnerCostBasis ?? 0,
    entryPrice: instance.runnerEntryPrice ?? null,
    peakPrice: instance.runnerPeakPrice ?? null,
    startedAt: instance.runnerStartedAt ?? null,
    ladderStep: instance.runnerLadderStep ?? 0,
  };
}

/**
 * Check if runner leg should exit
 */
async function checkRunnerExit(
  instanceId: string,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  costCalculator: ExecutionCostCalculator,
  currentPrice: number,
  portfolioValueUsdc: number,
  quote: QuoteResult
): Promise<boolean> {
  const runnerManager = buildRunnerManager(botConfig, costCalculator);
  const runnerState = buildRunnerStateData(instance);

  if (runnerState.state !== 'ACTIVE' || runnerState.qty <= 0) {
    return false;
  }

  // Calculate execution cost for runner sell
  const costResult = costCalculator.calculateExecutionCost(quote);

  // Evaluate runner exit decision
  const decision = runnerManager.evaluateRunnerExit(runnerState, currentPrice, costResult);

  // Log the decision
  logger.info('Runner decision', {
    instanceId,
    runnerState: runnerState.state,
    runnerMode: botConfig.runnerMode,
    runnerQty: runnerState.qty,
    runnerEntryPrice: runnerState.entryPrice,
    runnerPeakPrice: runnerState.peakPrice,
    executablePrice: currentPrice,
    action: decision.action,
    reason: decision.reason,
    netEdgePct: decision.netEdgePct,
    executionCostPct: decision.executionCostPct,
  });

  // Execute runner exit if needed
  if (decision.action === 'SELL_LADDER_STEP' || decision.action === 'SELL_TRAILING_EXIT') {
    await executeRunnerExit(
      instanceId,
      decision,
      runnerState,
      instance,
      adapter,
      botConfig,
      pnlCalculator,
      currentPrice
    );
    return true;
  }

  return false;
}

/**
 * Execute runner leg exit
 */
async function executeRunnerExit(
  instanceId: string,
  decision: RunnerDecision,
  runnerState: RunnerStateData,
  instance: BotInstance,
  adapter: ChainAdapter,
  botConfig: BotConfig,
  pnlCalculator: PnLCalculator,
  currentPrice: number
): Promise<void> {
  const side: TradeSide = 'SELL';
  const clientOrderId = generateClientOrderId(instanceId, `RUNNER_${side}`, Date.now());

  // Check for duplicate
  const existing = await prisma.tradeAttempt.findUnique({
    where: { clientOrderId },
  });
  if (existing) {
    logger.warn('Duplicate runner order detected', { clientOrderId });
    return;
  }

  // Get quote for runner sell
  const runnerQuote = await adapter.getQuote({
    side,
    amount: decision.sellQty,
    amountIsBase: true,
    slippageBps: botConfig.maxSlippageBps,
    allowedSources: botConfig.allowedSources,
    excludedSources: botConfig.excludedSources,
  });

  // Create trade attempt
  const tradeAttempt = await prisma.tradeAttempt.create({
    data: {
      instanceId,
      clientOrderId,
      side,
      status: 'PENDING',
      isDryRun: botConfig.dryRunMode,
      quotePrice: runnerQuote.price,
      quotedBaseQty: runnerQuote.inputAmount,
      quotedQuoteQty: runnerQuote.outputAmount,
      quotedPriceImpactBps: runnerQuote.priceImpactBps,
      quotedSlippageBps: botConfig.maxSlippageBps,
    },
  });

  logger.info('Executing runner exit', {
    instanceId,
    clientOrderId,
    sellQty: decision.sellQty,
    action: decision.action,
    isDryRun: botConfig.dryRunMode,
  });

  if (botConfig.dryRunMode) {
    // Synthetic runner exit
    const costBasisPerUnit = runnerState.costBasis / runnerState.qty;
    const realizedPnl = (currentPrice - costBasisPerUnit) * decision.sellQty;

    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: { status: 'CONFIRMED' },
    });

    await prisma.tradeFill.create({
      data: {
        attemptId: tradeAttempt.id,
        side,
        baseQty: decision.sellQty,
        quoteQty: decision.sellQty * currentPrice,
        executedPrice: currentPrice,
        costBasisPerUnit,
        realizedPnl,
        feeNativeUsdc: 0,
        txSignature: `dry_run_runner_${Date.now()}`,
        executedAt: new Date(),
      },
    });

    await updateInstanceAfterRunnerSell(instanceId, decision, runnerState, realizedPnl);
    return;
  }

  // Real trade execution
  try {
    const result = await adapter.executeSwap({ quote: runnerQuote, clientOrderId });

    if (result.success) {
      const baseQty = result.inputAmount;
      const quoteQty = result.outputAmount;
      const costBasisPerUnit = runnerState.costBasis / runnerState.qty;
      const realizedPnl = (result.executedPrice - costBasisPerUnit) * baseQty - result.feeNativeUsdc;

      await prisma.tradeAttempt.update({
        where: { id: tradeAttempt.id },
        data: {
          status: 'CONFIRMED',
          txSignature: result.txSignature,
        },
      });

      await prisma.tradeFill.create({
        data: {
          attemptId: tradeAttempt.id,
          side,
          baseQty,
          quoteQty,
          executedPrice: result.executedPrice,
          costBasisPerUnit,
          realizedPnl,
          feeNativeUsdc: result.feeNativeUsdc,
          txSignature: result.txSignature,
          executedAt: new Date(),
        },
      });

      await updateInstanceAfterRunnerSell(instanceId, decision, runnerState, realizedPnl);

      logger.info('Runner exit executed', {
        instanceId,
        clientOrderId,
        executedPrice: result.executedPrice,
        realizedPnl,
      });
    } else {
      const errorMsg = result.error ? String(result.error) : 'Unknown error';
      await prisma.tradeAttempt.update({
        where: { id: tradeAttempt.id },
        data: {
          status: 'FAILED',
          errorMessage: errorMsg,
        },
      });

      logger.error('Runner exit failed', {
        instanceId,
        clientOrderId,
        error: errorMsg,
      });
    }
  } catch (error) {
    await prisma.tradeAttempt.update({
      where: { id: tradeAttempt.id },
      data: {
        status: 'FAILED',
        errorMessage: (error as Error).message,
      },
    });

    logger.error('Runner exit error', {
      instanceId,
      clientOrderId,
      error: (error as Error).message,
    });
  }
}

/**
 * Update instance after runner sell
 */
async function updateInstanceAfterRunnerSell(
  instanceId: string,
  decision: RunnerDecision,
  runnerState: RunnerStateData,
  realizedPnl: number
): Promise<void> {
  const newRunnerQty = runnerState.qty - decision.sellQty;
  const soldCostBasis = runnerState.costBasis * (decision.sellQty / runnerState.qty);
  const newRunnerCostBasis = runnerState.costBasis - soldCostBasis;
  const isLadderStep = decision.action === 'SELL_LADDER_STEP';

  const updateData: Record<string, unknown> = {
    lastTradeAt: new Date(),
    totalSells: { increment: 1 },
    totalSellVolume: { increment: decision.sellQty * (runnerState.entryPrice ?? 0) },
    dailyRealizedPnl: { increment: realizedPnl },
    cumulativeRealizedPnL: { increment: realizedPnl },
    // Update runner state
    runnerQty: newRunnerQty,
    runnerCostBasis: newRunnerCostBasis,
  };

  // Advance ladder step if applicable
  if (isLadderStep) {
    updateData.runnerLadderStep = runnerState.ladderStep + 1;
  }

  // If runner is depleted, reset runner state
  if (newRunnerQty <= 0.0001) {
    updateData.runnerState = 'NONE';
    updateData.runnerQty = 0;
    updateData.runnerCostBasis = 0;
    updateData.runnerEntryPrice = null;
    updateData.runnerPeakPrice = null;
    updateData.runnerStartedAt = null;
    updateData.runnerLadderStep = 0;
  }

  await prisma.botInstance.update({
    where: { id: instanceId },
    data: updateData,
  });

  logger.info('Runner state updated after sell', {
    instanceId,
    newRunnerQty,
    newRunnerCostBasis,
    realizedPnl,
    runnerDepleted: newRunnerQty <= 0.0001,
  });
}

/**
 * Update runner peak price for trailing
 */
async function updateRunnerPeakPrice(
  instanceId: string,
  instance: BotInstance,
  currentPrice: number
): Promise<void> {
  const currentPeak = instance.runnerPeakPrice ?? 0;

  if (currentPrice > currentPeak) {
    await prisma.botInstance.update({
      where: { id: instanceId },
      data: { runnerPeakPrice: currentPrice },
    });
  }
}

/**
 * Create runner leg after CORE sell (called from executeSellWithScaleOut)
 */
async function createRunnerLeg(
  instanceId: string,
  runnerQty: number,
  runnerCostBasis: number,
  coreExitPrice: number
): Promise<void> {
  await prisma.botInstance.update({
    where: { id: instanceId },
    data: {
      runnerState: 'ACTIVE',
      runnerQty,
      runnerCostBasis,
      runnerEntryPrice: coreExitPrice,
      runnerPeakPrice: coreExitPrice,
      runnerStartedAt: new Date(),
      runnerLadderStep: 0,
    },
  });

  logger.info('Runner leg created', {
    instanceId,
    runnerQty,
    runnerCostBasis,
    runnerEntryPrice: coreExitPrice,
  });
}
