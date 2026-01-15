'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { botApi, configApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import {
  Play,
  Square,
  Plus,
  RefreshCw,
  Settings,
  AlertCircle,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  Activity,
} from 'lucide-react';
import { formatRelativeTime, getStatusColor, formatCurrency } from '@/lib/utils';
import Link from 'next/link';
import { useState } from 'react';
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Scatter,
  ComposedChart,
} from 'recharts';
import type { BotInstance } from '@/lib/api';
import { tradesApi } from '@/lib/api';

function BotWithChart({ bot }: { bot: BotInstance }) {
  const queryClient = useQueryClient();
  const [tradeResult, setTradeResult] = useState<{ success: boolean; message: string } | null>(null);

  const { data: priceData } = useQuery({
    queryKey: ['prices', bot.id],
    queryFn: () => botApi.getPrices(bot.id),
    refetchInterval: 10000,
    enabled: bot.status === 'RUNNING',
  });

  const { data: statusData } = useQuery({
    queryKey: ['botStatus', bot.id],
    queryFn: () => botApi.getStatus(bot.id),
    refetchInterval: 10000,
    enabled: bot.status === 'RUNNING',
  });

  const { data: tradesData } = useQuery({
    queryKey: ['recentTrades', bot.id],
    queryFn: () => tradesApi.list({ instanceId: bot.id, limit: 50 }),
    refetchInterval: 10000,
  });

  const tradeMutation = useMutation({
    mutationFn: ({ side }: { side: 'BUY' | 'SELL' }) => botApi.trade(bot.id, side),
    onSuccess: (data) => {
      setTradeResult({ success: true, message: data.message });
      queryClient.invalidateQueries({ queryKey: ['recentTrades', bot.id] });
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      setTimeout(() => setTradeResult(null), 5000);
    },
    onError: (err: Error) => {
      setTradeResult({ success: false, message: err.message });
      setTimeout(() => setTradeResult(null), 5000);
    },
  });

  // Get threshold prices from status
  const buyThreshold = statusData?.thresholds.nextBuyThreshold;
  const sellThreshold = statusData?.thresholds.nextSellThreshold;

  // Build chart data with trade markers
  const priceHistory = priceData?.prices || [];
  const chartData = priceHistory.map((p) => {
    const time = new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Check if there's a trade near this timestamp (within 15 seconds)
    const trade = tradesData?.trades.find(t => {
      const tradeTime = new Date(t.createdAt).getTime();
      return Math.abs(tradeTime - p.timestamp) < 15000 && t.status === 'CONFIRMED';
    });
    return {
      time,
      timestamp: p.timestamp,
      price: p.price,
      buy: trade?.side === 'BUY' ? p.price : undefined,
      sell: trade?.side === 'SELL' ? p.price : undefined,
    };
  });

  const latestPrice = chartData.length > 0 ? chartData[chartData.length - 1].price : null;

  // Calculate Y domain including thresholds
  const allPrices = chartData.map(d => d.price);
  if (buyThreshold) allPrices.push(buyThreshold);
  if (sellThreshold) allPrices.push(sellThreshold);

  const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : 0;
  const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : 0;
  const priceRange = maxPrice - minPrice;
  const yDomain = priceRange > 0
    ? [minPrice - priceRange * 0.1, maxPrice + priceRange * 0.1]
    : [minPrice * 0.99, maxPrice * 1.01];

  return (
    <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="font-medium">{bot.config?.name}</span>
          <span className="text-lg font-mono">
            {priceData?.pair || (bot.config?.chain === 'SOLANA' ? 'SOL/USDC' : 'AVAX/USDC')}
          </span>
          {latestPrice && (
            <span className="text-xl font-bold text-green-400">
              ${latestPrice.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => tradeMutation.mutate({ side: 'BUY' })}
            disabled={tradeMutation.isPending}
            className="bg-green-600 hover:bg-green-700"
          >
            {tradeMutation.isPending ? 'Executing...' : 'Execute BUY'}
          </Button>
          <Button
            size="sm"
            onClick={() => tradeMutation.mutate({ side: 'SELL' })}
            disabled={tradeMutation.isPending}
            className="bg-red-600 hover:bg-red-700"
          >
            {tradeMutation.isPending ? 'Executing...' : 'Execute SELL'}
          </Button>
        </div>
      </div>

      {/* Trade result feedback */}
      {tradeResult && (
        <div className={`mb-3 p-2 rounded text-sm ${tradeResult.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {tradeResult.message}
        </div>
      )}

      {/* Price Chart */}
      {chartData.length > 1 ? (
        <div className="h-64 mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="time"
                stroke="#9CA3AF"
                fontSize={10}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#9CA3AF"
                fontSize={10}
                tickLine={false}
                domain={yDomain}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
                width={70}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1F2937',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#9CA3AF' }}
                formatter={(value: number, name: string) => {
                  if (name === 'buy') return [`$${value.toFixed(4)}`, 'BUY'];
                  if (name === 'sell') return [`$${value.toFixed(4)}`, 'SELL'];
                  return [`$${value.toFixed(4)}`, 'Price'];
                }}
              />
              {/* Buy threshold line */}
              {buyThreshold && (
                <ReferenceLine
                  y={buyThreshold}
                  stroke="#22C55E"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{
                    value: `Buy $${buyThreshold.toFixed(2)}`,
                    position: 'right',
                    fill: '#22C55E',
                    fontSize: 10,
                  }}
                />
              )}
              {/* Sell threshold line */}
              {sellThreshold && (
                <ReferenceLine
                  y={sellThreshold}
                  stroke="#EF4444"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{
                    value: `Sell $${sellThreshold.toFixed(2)}`,
                    position: 'right',
                    fill: '#EF4444',
                    fontSize: 10,
                  }}
                />
              )}
              {/* Price line */}
              <Line
                type="monotone"
                dataKey="price"
                stroke="#10B981"
                strokeWidth={2}
                dot={false}
              />
              {/* Buy markers */}
              <Scatter
                dataKey="buy"
                fill="#22C55E"
                shape="circle"
              />
              {/* Sell markers */}
              <Scatter
                dataKey="sell"
                fill="#EF4444"
                shape="circle"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-64 mt-4 flex items-center justify-center text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" />
          Collecting price data...
        </div>
      )}

      {/* Threshold Legend */}
      <div className="flex items-center gap-4 mt-2 text-xs">
        {buyThreshold && (
          <div className="flex items-center gap-1">
            <div className="w-4 h-0.5 bg-green-500" style={{ borderStyle: 'dashed' }} />
            <span className="text-green-500">Buy @ ${buyThreshold.toFixed(2)}</span>
          </div>
        )}
        {sellThreshold && (
          <div className="flex items-center gap-1">
            <div className="w-4 h-0.5 bg-red-500" style={{ borderStyle: 'dashed' }} />
            <span className="text-red-500">Sell @ ${sellThreshold.toFixed(2)}</span>
          </div>
        )}
        {!buyThreshold && !sellThreshold && (
          <span className="text-muted-foreground">No thresholds set (waiting for first trade)</span>
        )}
      </div>

      {/* Bot Settings */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-4 pt-4 border-t border-green-500/20">
        <div>
          <p className="text-muted-foreground">Buy Threshold</p>
          <p className="font-medium">{bot.config?.buyDipPct}%</p>
        </div>
        <div>
          <p className="text-muted-foreground">Sell Threshold</p>
          <p className="font-medium">{bot.config?.sellRisePct}%</p>
        </div>
        <div>
          <p className="text-muted-foreground">Trade Size</p>
          <p className="font-medium">{formatCurrency(bot.config?.tradeSize || 0)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Mode</p>
          <p className="font-medium">{bot.config?.dryRunMode ? 'Dry Run' : 'Live'}</p>
        </div>
      </div>

      {/* Extension state */}
      {bot.extensionState && bot.extensionState !== 'NONE' && (
        <div className="mt-3 pt-3 border-t border-green-500/20">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">
              Scale-Out Extension: {bot.extensionState}
            </span>
            <span className="text-xs text-muted-foreground">
              Holding {bot.extensionBaseQty?.toFixed(4) || '0'} @ {bot.extensionEntryPrice?.toFixed(4) || '-'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState('');

  const { data: bots, isLoading: botsLoading } = useQuery({
    queryKey: ['bots'],
    queryFn: botApi.list,
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  const { data: configs, isLoading: configsLoading } = useQuery({
    queryKey: ['configs'],
    queryFn: configApi.list,
  });

  const [pendingBotId, setPendingBotId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: (id: string) => {
      setPendingBotId(id);
      setActionError(null);
      return botApi.start(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      setPendingBotId(null);
    },
    onError: (err: Error) => {
      setPendingBotId(null);
      setActionError(err.message);
      setTimeout(() => setActionError(null), 5000);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => {
      setPendingBotId(id);
      setActionError(null);
      return botApi.stop(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      setPendingBotId(null);
    },
    onError: (err: Error) => {
      setPendingBotId(null);
      setActionError(err.message);
      setTimeout(() => setActionError(null), 5000);
    },
  });

  const createMutation = useMutation({
    mutationFn: botApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      setCreating(false);
      setSelectedConfigId('');
    },
  });

  const availableConfigs = configs?.filter(
    (c) => !bots?.some((b) => b.configId === c.id && ['RUNNING', 'PAUSED'].includes(b.status))
  );

  const runningBots = bots?.filter((b) => b.status === 'RUNNING') || [];
  const _stoppedBots = bots?.filter((b) => b.status !== 'RUNNING') || [];
  void _stoppedBots; // suppress unused variable warning
  const totalVolume = bots?.reduce((sum, b) => sum + (b.totalBuyVolume || 0) + (b.totalSellVolume || 0), 0) || 0;

  const isLoading = botsLoading || configsLoading;

  return (
    <div className="space-y-6">
      {/* Status Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Running Bots</p>
                <p className="text-2xl font-bold">{runningBots.length}</p>
              </div>
              <Activity className={`h-8 w-8 ${runningBots.length > 0 ? 'text-green-500' : 'text-muted-foreground'}`} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Configurations</p>
                <p className="text-2xl font-bold">{configs?.length || 0}</p>
              </div>
              <Settings className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Trades</p>
                <p className="text-2xl font-bold">
                  {bots?.reduce((sum, b) => sum + (b.totalBuys || 0) + (b.totalSells || 0), 0) || 0}
                </p>
              </div>
              <TrendingUp className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Volume</p>
                <p className="text-2xl font-bold">{formatCurrency(totalVolume)}</p>
              </div>
              <TrendingDown className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error Banner */}
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-300">
            &times;
          </button>
        </div>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Bot Control</CardTitle>
            <div className="flex gap-2">
              {!creating && (
                <Button onClick={() => setCreating(true)} disabled={!configs?.length}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Bot
                </Button>
              )}
              <Link href="/configure">
                <Button variant="secondary">
                  <Settings className="mr-2 h-4 w-4" />
                  Configure
                </Button>
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Create Bot Form */}
          {creating && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-secondary/50">
              <h3 className="font-medium mb-3">Create New Bot</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-sm text-muted-foreground mb-1">Configuration</label>
                  <select
                    value={selectedConfigId}
                    onChange={(e) => setSelectedConfigId(e.target.value)}
                    className="w-full rounded-md border border-border bg-background p-2"
                  >
                    <option value="">Select a config...</option>
                    {availableConfigs?.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name} ({config.chain}) {config.dryRunMode ? '[DRY RUN]' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={() => createMutation.mutate(selectedConfigId)}
                  disabled={!selectedConfigId || createMutation.isPending}
                >
                  {createMutation.isPending ? 'Creating...' : 'Create'}
                </Button>
                <Button variant="secondary" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
              {!availableConfigs?.length && configs?.length && (
                <p className="text-sm text-yellow-400 mt-2">
                  All configurations have active bots. Stop a bot or create a new config.
                </p>
              )}
              {!configs?.length && (
                <p className="text-sm text-muted-foreground mt-2">
                  No configurations yet.{' '}
                  <Link href="/configure" className="text-primary hover:underline">
                    Create one first
                  </Link>
                </p>
              )}
            </div>
          )}

          {/* Bot List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !bots?.length ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No bots created yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                {configs?.length
                  ? 'Click "New Bot" to create one'
                  : 'Create a configuration first, then create a bot'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {bots.map((bot) => (
                <div
                  key={bot.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-border bg-background"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        bot.status === 'RUNNING' ? 'bg-green-500 animate-pulse' : 'bg-gray-500'
                      }`}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{bot.config?.name || 'Bot'}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-secondary">
                          {bot.config?.chain}
                        </span>
                        {bot.config?.dryRunMode && (
                          <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                            DRY RUN
                          </span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded ${getStatusColor(bot.status)}`}>
                          {bot.status}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {bot.totalBuys || 0} buys / {bot.totalSells || 0} sells
                        {bot.lastTradeAt && (
                          <span className="ml-2">• Last: {formatRelativeTime(bot.lastTradeAt)}</span>
                        )}
                      </div>
                      {bot.lastError && (
                        <p className="text-xs text-red-400 mt-1">{bot.lastError}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {bot.status === 'RUNNING' ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => stopMutation.mutate(bot.id)}
                        disabled={pendingBotId === bot.id}
                      >
                        <Square className="mr-1 h-4 w-4" />
                        {pendingBotId === bot.id ? 'Stopping...' : 'Stop'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => startMutation.mutate(bot.id)}
                        disabled={pendingBotId === bot.id}
                      >
                        <Play className="mr-1 h-4 w-4" />
                        {pendingBotId === bot.id ? 'Starting...' : 'Start'}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Running Bot Details with Price Chart */}
      {runningBots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              Active Trading
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {runningBots.map((bot) => (
                <BotWithChart key={bot.id} bot={bot} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
