const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface BotConfig {
  id: string;
  name: string;
  chain: 'SOLANA' | 'AVALANCHE';
  baseMint: string;
  quoteMint: string;
  buyDipPct: number;
  sellRisePct: number;
  tradeSizeMode: 'FIXED_QUOTE' | 'FIXED_BASE' | 'PERCENT_BALANCE';
  tradeSize: number;
  minTradeNotional: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  cooldownSeconds: number;
  maxTradesPerHour: number;
  dailyLossLimitUsdc: number | null;
  maxDrawdownPct: number | null;
  maxConsecutiveFailures: number;
  minBaseReserve: number;
  minQuoteReserve: number;
  takeProfitUsdc: number | null;
  stopLossUsdc: number | null;
  startingMode: 'START_BY_BUYING' | 'START_BY_SELLING' | 'START_NEUTRAL';
  pnlMethod: 'AVERAGE_COST' | 'FIFO';
  allowedSources: string[];
  excludedSources: string[];
  maxPriceDeviationBps: number;
  dryRunMode: boolean;
  webhookUrl: string | null;
  discordWebhookUrl: string | null;
  // Compounding configuration
  compoundingMode: 'FIXED' | 'FULL_BALANCE' | 'CALCULATED';
  initialTradeSizeUsdc: number | null;
  compoundingReservePct: number;
  // Multi-step scale-out configuration
  scaleOutSteps: number;
  scaleOutRangePct: number;
  scaleOutSpacingPct: number | null;
  // Exit mode configuration
  exitMode: 'FULL_EXIT' | 'SCALE_OUT';
  scaleOutPrimaryPct: number;
  scaleOutSecondaryPct: number;
  // Rolling rebuy configuration
  cycleMode: 'STANDARD' | 'ROLLING_REBUY';
  primarySellPct: number;
  allowRebuy: boolean;
  maxRebuyCount: number;
  exposureCapPct: number;
  rebuyRegimeGate: boolean;
  rebuyDipPct: number | null;
  // Capital allocation
  initialCapitalUSDC: number | null;
  // Reserve reset configuration (3-bucket adaptive strategy)
  enableReserveReset: boolean;
  resetReservePct: number;
  maxReserveDeploymentsPerCycle: number;
  // Rescue buy (downside reset)
  rescueTriggerPct: number;
  rescueDeployPctOfReserve: number;
  maxRescueBuysPerCycle: number;
  rescueRegimeGate: 'NONE' | 'TREND_ONLY' | 'CHAOS_ONLY' | 'TREND_OR_CHAOS';
  // Chase buy (upside reset)
  chaseTriggerPct: number;
  chaseDeployPctOfReserve: number;
  chaseExitTargetPct: number;
  chaseRegimeGate: 'NONE' | 'TREND_UP_ONLY' | 'TREND_ONLY';
  createdAt: string;
  updatedAt: string;
}

export interface BotInstance {
  id: string;
  configId: string;
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'ERROR';
  lastBuyPrice: number | null;
  lastSellPrice: number | null;
  lastTradeAt: string | null;
  totalBuys: number;
  totalSells: number;
  totalBuyVolume: number;
  totalSellVolume: number;
  totalBaseCost: number;
  totalBaseQty: number;
  consecutiveFailures: number;
  tradesThisHour: number;
  dailyRealizedPnl: number;
  lastError: string | null;
  pauseReason: string | null;
  config?: BotConfig;
  // Extension state for scale-out mode
  extensionState?: 'NONE' | 'ACTIVE' | 'TRAILING';
  extensionBaseQty?: number;
  extensionBaseCost?: number;
  extensionEntryPrice?: number | null;
  extensionPeakPrice?: number | null;
  extensionStartedAt?: string | null;
  extensionPrimaryPnl?: number;
  // Capital allocation state
  allocatedUSDC?: number;
  allocatedSOL?: number;
  reservedUSDCForFees?: number;
  pendingBuyUSDC?: number;
  pendingSellSOL?: number;
  cumulativeRealizedPnL?: number;
}

export interface BotStatus {
  instance: BotInstance;
  isWorkerRunning: boolean;
  balances: { base: number; quote: number } | null;
  currentPrice: number | null;
  connectivity: {
    rpcConnected: boolean;
    apiConnected: boolean;
    latencyMs: number;
    errors: string[];
  } | null;
  pnl: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    costBasis: number;
    portfolioValue: number;
  } | null;
  thresholds: {
    nextBuyThreshold: number | null;
    nextSellThreshold: number | null;
  };
}

export interface Trade {
  id: string;
  instanceId: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';
  isDryRun: boolean;
  quotePrice: number;
  quotedBaseQty: number;
  quotedQuoteQty: number;
  quotedPriceImpactBps: number | null;
  txSignature: string | null;
  errorMessage: string | null;
  createdAt: string;
  fill?: {
    baseQty: number;
    quoteQty: number;
    executedPrice: number;
    feeNativeUsdc: number;
    realizedPnl: number | null;
    txSignature: string;
    executedAt: string;
  };
}

export interface PnLSummary {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  costBasis: number;
  portfolioValue: number;
  totalFees: number;
  netPnl: number;
  balances: { base: number; quote: number };
  currentPrice: number;
  dailyRealizedPnl: number;
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || 'API request failed');
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

// Config API
export const configApi = {
  list: () => fetchApi<(BotConfig & { instances: { id: string; status: string }[] })[]>('/api/configs'),
  get: (id: string) => fetchApi<BotConfig>(`/api/configs/${id}`),
  create: (data: Partial<BotConfig>) =>
    fetchApi<BotConfig>('/api/configs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<BotConfig>) =>
    fetchApi<BotConfig>(`/api/configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/configs/${id}`, {
      method: 'DELETE',
    }),
};

export interface PriceHistory {
  chain: 'SOLANA' | 'AVALANCHE';
  pair: string;
  prices: { timestamp: number; price: number }[];
}

// Bot API
export const botApi = {
  list: () => fetchApi<BotInstance[]>('/api/bots'),
  get: (id: string) => fetchApi<BotInstance>(`/api/bots/${id}`),
  getStatus: (id: string) => fetchApi<BotStatus>(`/api/bots/${id}/status`),
  getPrices: (id: string) => fetchApi<PriceHistory>(`/api/bots/${id}/prices`),
  create: (configId: string) =>
    fetchApi<BotInstance>('/api/bots', {
      method: 'POST',
      body: JSON.stringify({ configId }),
    }),
  start: (id: string) =>
    fetchApi<BotInstance>(`/api/bots/${id}/start`, {
      method: 'POST',
    }),
  stop: (id: string) =>
    fetchApi<BotInstance>(`/api/bots/${id}/stop`, {
      method: 'POST',
    }),
  trade: (id: string, side: 'BUY' | 'SELL') =>
    fetchApi<{ success: boolean; message: string; tradeId?: string }>(`/api/bots/${id}/trade`, {
      method: 'POST',
      body: JSON.stringify({ side }),
    }),
  delete: (id: string) =>
    fetchApi<void>(`/api/bots/${id}`, {
      method: 'DELETE',
    }),
};

// Trades API
export const tradesApi = {
  list: (params?: { instanceId?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.instanceId) searchParams.set('instanceId', params.instanceId);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    return fetchApi<{ trades: Trade[]; pagination: { total: number; hasMore: boolean } }>(
      `/api/trades?${searchParams}`
    );
  },
  get: (id: string) => fetchApi<Trade>(`/api/trades/${id}`),
  getStats: (instanceId: string) =>
    fetchApi<{
      totalTrades: number;
      successfulTrades: number;
      failedTrades: number;
      successRate: number;
      buyCount: number;
      sellCount: number;
      totalBuyVolume: number;
      totalSellVolume: number;
      totalVolume: number;
      totalFees: number;
      totalRealizedPnl: number;
    }>(`/api/bots/${instanceId}/trades/stats`),
};

// PnL API
export const pnlApi = {
  getSummary: (instanceId: string) => fetchApi<PnLSummary>(`/api/bots/${instanceId}/pnl`),
  getDaily: (instanceId: string) =>
    fetchApi<
      {
        date: string;
        realizedPnl: number;
        unrealizedPnl: number;
        totalPnl: number;
        portfolioValue: number;
      }[]
    >(`/api/bots/${instanceId}/pnl/daily`),
  getPositions: (instanceId: string) =>
    fetchApi<
      {
        baseBalance: number;
        quoteBalance: number;
        markPrice: number;
        totalValueUsdc: number;
        snapshotAt: string;
      }[]
    >(`/api/bots/${instanceId}/positions`),
  exportCsv: (instanceId: string) => `${API_BASE}/api/bots/${instanceId}/export/csv`,
};

// Health API
export const healthApi = {
  check: () => fetchApi<{ status: string; timestamp: string }>('/health'),
  detailed: () =>
    fetchApi<{
      status: string;
      checks: Record<string, { status: string; latencyMs?: number; error?: string }>;
    }>('/health/detailed'),
  checkConnectivity: (chain: 'SOLANA' | 'AVALANCHE') =>
    fetchApi<{
      chain: string;
      rpcConnected: boolean;
      apiConnected: boolean;
      latencyMs: number;
      errors: string[];
    }>('/health/check-connectivity', {
      method: 'POST',
      body: JSON.stringify({ chain }),
    }),
};
