'use client';

import { useQuery } from '@tanstack/react-query';
import { pnlApi, botApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import { Download, RefreshCw } from 'lucide-react';
import {
  formatCurrency,
  formatNumber,
  getPnLColor,
} from '@/lib/utils';
import { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

export default function PnLPage() {
  const [selectedInstance, setSelectedInstance] = useState<string>('');

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: botApi.list,
  });

  const { data: pnlSummary, isLoading: summaryLoading } = useQuery({
    queryKey: ['pnlSummary', selectedInstance],
    queryFn: () => (selectedInstance ? pnlApi.getSummary(selectedInstance) : null),
    enabled: !!selectedInstance,
    refetchInterval: 10000,
  });

  const { data: positions } = useQuery({
    queryKey: ['positions', selectedInstance],
    queryFn: () => (selectedInstance ? pnlApi.getPositions(selectedInstance) : null),
    enabled: !!selectedInstance,
  });

  const selectedBot = bots?.find((b) => b.id === selectedInstance);

  // Format position data for chart
  const chartData = positions
    ?.slice()
    .reverse()
    .map((p) => ({
      time: new Date(p.snapshotAt).toLocaleTimeString(),
      portfolioValue: p.totalValueUsdc,
      baseBalance: p.baseBalance,
      quoteBalance: p.quoteBalance,
      price: p.markPrice,
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">PnL Report</h1>
        <p className="text-muted-foreground">
          View profit and loss across your trading bots
        </p>
      </div>

      {/* Bot Selector */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Bot Instance</label>
              <select
                value={selectedInstance}
                onChange={(e) => setSelectedInstance(e.target.value)}
                className="w-full max-w-xs rounded-md border border-border bg-secondary p-2"
              >
                <option value="">Select a bot...</option>
                {bots?.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.config?.name || 'Unnamed'} ({bot.config?.chain})
                  </option>
                ))}
              </select>
            </div>
            {selectedInstance && (
              <a
                href={pnlApi.exportCsv(selectedInstance)}
                download
                className="self-end"
              >
                <Button variant="secondary">
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      {!selectedInstance ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Select a bot to view PnL data</p>
          </CardContent>
        </Card>
      ) : summaryLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* PnL Summary Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="py-4">
                <p className="text-sm text-muted-foreground">Realized PnL</p>
                <p
                  className={`text-3xl font-semibold ${getPnLColor(
                    pnlSummary?.realizedPnl ?? 0
                  )}`}
                >
                  {formatCurrency(pnlSummary?.realizedPnl ?? 0)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-sm text-muted-foreground">Unrealized PnL</p>
                <p
                  className={`text-3xl font-semibold ${getPnLColor(
                    pnlSummary?.unrealizedPnl ?? 0
                  )}`}
                >
                  {formatCurrency(pnlSummary?.unrealizedPnl ?? 0)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-sm text-muted-foreground">Total PnL</p>
                <p
                  className={`text-3xl font-semibold ${getPnLColor(
                    pnlSummary?.totalPnl ?? 0
                  )}`}
                >
                  {formatCurrency(pnlSummary?.totalPnl ?? 0)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Detailed Summary */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Portfolio Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Portfolio Value</span>
                    <span className="font-medium">
                      {formatCurrency(pnlSummary?.portfolioValue ?? 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Cost Basis</span>
                    <span>{formatCurrency(pnlSummary?.costBasis ?? 0)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Total Fees Paid</span>
                    <span className="text-red-400">
                      -{formatCurrency(pnlSummary?.totalFees ?? 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-4">
                    <span className="font-medium">Net PnL (after fees)</span>
                    <span
                      className={`font-semibold ${getPnLColor(pnlSummary?.netPnl ?? 0)}`}
                    >
                      {formatCurrency(pnlSummary?.netPnl ?? 0)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Current Position</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {selectedBot?.config?.chain === 'SOLANA' ? 'SOL' : 'AVAX'} Balance
                    </span>
                    <span className="font-medium">
                      {formatNumber(pnlSummary?.balances?.base ?? 0, 4)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">USDC Balance</span>
                    <span className="font-medium">
                      {formatCurrency(pnlSummary?.balances?.quote ?? 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Current Price</span>
                    <span>{formatCurrency(pnlSummary?.currentPrice ?? 0, 4)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Daily Realized PnL</span>
                    <span
                      className={getPnLColor(pnlSummary?.dailyRealizedPnl ?? 0)}
                    >
                      {formatCurrency(pnlSummary?.dailyRealizedPnl ?? 0)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Portfolio Value Chart */}
          {chartData && chartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Portfolio Value Over Time</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis
                        dataKey="time"
                        stroke="#9CA3AF"
                        fontSize={12}
                        tickLine={false}
                      />
                      <YAxis
                        stroke="#9CA3AF"
                        fontSize={12}
                        tickLine={false}
                        tickFormatter={(v) => `$${v}`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1F2937',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                        }}
                        labelStyle={{ color: '#9CA3AF' }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="portfolioValue"
                        name="Portfolio Value"
                        stroke="#3B82F6"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Inventory Chart */}
          {chartData && chartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Inventory Balances</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis
                        dataKey="time"
                        stroke="#9CA3AF"
                        fontSize={12}
                        tickLine={false}
                      />
                      <YAxis
                        yAxisId="left"
                        stroke="#9CA3AF"
                        fontSize={12}
                        tickLine={false}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        stroke="#9CA3AF"
                        fontSize={12}
                        tickLine={false}
                        tickFormatter={(v) => `$${v}`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1F2937',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                        }}
                        labelStyle={{ color: '#9CA3AF' }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="baseBalance"
                        name={
                          selectedBot?.config?.chain === 'SOLANA' ? 'SOL' : 'AVAX'
                        }
                        stroke="#10B981"
                        strokeWidth={2}
                        dot={false}
                        yAxisId="left"
                      />
                      <Line
                        type="monotone"
                        dataKey="quoteBalance"
                        name="USDC"
                        stroke="#F59E0B"
                        strokeWidth={2}
                        dot={false}
                        yAxisId="right"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
