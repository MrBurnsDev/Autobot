'use client';

import { useQuery } from '@tanstack/react-query';
import { botApi, healthApi, tradesApi } from '@/lib/api';
import { StatCard } from '@/components/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import {
  Activity,
  DollarSign,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  Play,
  Square,
} from 'lucide-react';
import {
  formatCurrency,
  formatNumber,
  formatRelativeTime,
  getStatusColor,
  getPnLColor,
} from '@/lib/utils';
import Link from 'next/link';

export default function OverviewPage() {
  const { data: bots, isLoading: botsLoading } = useQuery({
    queryKey: ['bots'],
    queryFn: botApi.list,
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.detailed,
    refetchInterval: 30000,
  });

  // Get status for first running bot
  const runningBot = bots?.find((b) => b.status === 'RUNNING');
  const { data: botStatus } = useQuery({
    queryKey: ['botStatus', runningBot?.id],
    queryFn: () => (runningBot ? botApi.getStatus(runningBot.id) : null),
    enabled: !!runningBot,
    refetchInterval: 5000,
  });

  const totalPortfolioValue = botStatus?.pnl?.portfolioValue ?? 0;
  const totalPnL = botStatus?.pnl?.totalPnl ?? 0;
  const runningBots = bots?.filter((b) => b.status === 'RUNNING').length ?? 0;
  const totalBots = bots?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your trading bot performance
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Portfolio Value"
          value={formatCurrency(totalPortfolioValue)}
          icon={DollarSign}
        />
        <StatCard
          title="Total PnL"
          value={formatCurrency(totalPnL)}
          trend={totalPnL > 0 ? 'up' : totalPnL < 0 ? 'down' : 'neutral'}
          icon={TrendingUp}
        />
        <StatCard
          title="Active Bots"
          value={`${runningBots} / ${totalBots}`}
          icon={Activity}
        />
        <StatCard
          title="System Status"
          value={health?.status === 'ok' ? 'Healthy' : 'Degraded'}
          icon={health?.status === 'ok' ? CheckCircle : XCircle}
        />
      </div>

      {/* Bot Status and Quick Actions */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Active Bot Status */}
        <Card>
          <CardHeader>
            <CardTitle>Active Bot Status</CardTitle>
          </CardHeader>
          <CardContent>
            {botStatus ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className={getStatusColor(botStatus.instance.status)}>
                    {botStatus.instance.status}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Chain</span>
                  <span>{botStatus.instance.config?.chain}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current Price</span>
                  <span>
                    {botStatus.currentPrice
                      ? formatCurrency(botStatus.currentPrice, 4)
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {botStatus.instance.config?.chain === 'SOLANA' ? 'SOL' : 'AVAX'} Balance
                  </span>
                  <span>
                    {botStatus.balances
                      ? formatNumber(botStatus.balances.base, 4)
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">USDC Balance</span>
                  <span>
                    {botStatus.balances
                      ? formatCurrency(botStatus.balances.quote)
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Next Buy Threshold</span>
                  <span>
                    {botStatus.thresholds.nextBuyThreshold
                      ? formatCurrency(botStatus.thresholds.nextBuyThreshold, 4)
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Next Sell Threshold</span>
                  <span>
                    {botStatus.thresholds.nextSellThreshold
                      ? formatCurrency(botStatus.thresholds.nextSellThreshold, 4)
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last Trade</span>
                  <span>
                    {botStatus.instance.lastTradeAt
                      ? formatRelativeTime(botStatus.instance.lastTradeAt)
                      : 'Never'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No active bot running</p>
                <Link href="/bots">
                  <Button className="mt-4">
                    <Play className="mr-2 h-4 w-4" />
                    Start a Bot
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* PnL Summary */}
        <Card>
          <CardHeader>
            <CardTitle>PnL Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {botStatus?.pnl ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Realized PnL</span>
                  <span className={getPnLColor(botStatus.pnl.realizedPnl)}>
                    {formatCurrency(botStatus.pnl.realizedPnl)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Unrealized PnL</span>
                  <span className={getPnLColor(botStatus.pnl.unrealizedPnl)}>
                    {formatCurrency(botStatus.pnl.unrealizedPnl)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-4">
                  <span className="font-medium">Total PnL</span>
                  <span
                    className={`font-semibold ${getPnLColor(botStatus.pnl.totalPnl)}`}
                  >
                    {formatCurrency(botStatus.pnl.totalPnl)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cost Basis</span>
                  <span>{formatCurrency(botStatus.pnl.costBasis)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Portfolio Value</span>
                  <span className="font-medium">
                    {formatCurrency(botStatus.pnl.portfolioValue)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No PnL data available</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* System Health */}
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {health?.checks &&
              Object.entries(health.checks).map(([name, check]) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-3 rounded-lg bg-secondary"
                >
                  <div>
                    <p className="text-sm font-medium capitalize">
                      {name.replace(/([A-Z])/g, ' $1').trim()}
                    </p>
                    {check.latencyMs !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {check.latencyMs}ms
                      </p>
                    )}
                  </div>
                  {check.status === 'ok' ? (
                    <CheckCircle className="h-5 w-5 text-green-400" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-400" />
                  )}
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
