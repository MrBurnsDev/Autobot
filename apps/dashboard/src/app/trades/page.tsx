'use client';

import { useQuery } from '@tanstack/react-query';
import { tradesApi, botApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  formatCurrency,
  formatNumber,
  formatDate,
  getStatusColor,
  getPnLColor,
  getExplorerUrl,
} from '@/lib/utils';
import { useState } from 'react';

export default function TradesPage() {
  const [selectedInstance, setSelectedInstance] = useState<string>('');
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: botApi.list,
  });

  const { data: tradesData, isLoading } = useQuery({
    queryKey: ['trades', selectedInstance, page],
    queryFn: () =>
      tradesApi.list({
        instanceId: selectedInstance || undefined,
        limit,
        offset: page * limit,
      }),
  });

  const { data: stats } = useQuery({
    queryKey: ['tradeStats', selectedInstance],
    queryFn: () =>
      selectedInstance ? tradesApi.getStats(selectedInstance) : null,
    enabled: !!selectedInstance,
  });

  const selectedBot = bots?.find((b) => b.id === selectedInstance);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Trades</h1>
        <p className="text-muted-foreground">View executed trades and history</p>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Bot Instance</label>
              <select
                value={selectedInstance}
                onChange={(e) => {
                  setSelectedInstance(e.target.value);
                  setPage(0);
                }}
                className="w-full max-w-xs rounded-md border border-border bg-secondary p-2"
              >
                <option value="">All Bots</option>
                {bots?.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.config?.name || 'Unnamed'} ({bot.config?.chain})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">Success Rate</p>
              <p className="text-2xl font-semibold">{stats.successRate.toFixed(1)}%</p>
              <p className="text-sm text-muted-foreground">
                {stats.successfulTrades}/{stats.totalTrades} trades
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">Total Volume</p>
              <p className="text-2xl font-semibold">
                {formatCurrency(stats.totalVolume)}
              </p>
              <p className="text-sm text-muted-foreground">
                {stats.buyCount} buys, {stats.sellCount} sells
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">Realized PnL</p>
              <p
                className={`text-2xl font-semibold ${getPnLColor(stats.totalRealizedPnl)}`}
              >
                {formatCurrency(stats.totalRealizedPnl)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">Total Fees</p>
              <p className="text-2xl font-semibold">
                {formatCurrency(stats.totalFees)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Trades Table */}
      <Card>
        <CardHeader>
          <CardTitle>Trade History</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : tradesData?.trades.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground">
              No trades found
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-2 text-sm font-medium text-muted-foreground">
                      Time
                    </th>
                    <th className="text-left py-3 px-2 text-sm font-medium text-muted-foreground">
                      Side
                    </th>
                    <th className="text-left py-3 px-2 text-sm font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="text-right py-3 px-2 text-sm font-medium text-muted-foreground">
                      Base Qty
                    </th>
                    <th className="text-right py-3 px-2 text-sm font-medium text-muted-foreground">
                      Quote Qty
                    </th>
                    <th className="text-right py-3 px-2 text-sm font-medium text-muted-foreground">
                      Price
                    </th>
                    <th className="text-right py-3 px-2 text-sm font-medium text-muted-foreground">
                      PnL
                    </th>
                    <th className="text-center py-3 px-2 text-sm font-medium text-muted-foreground">
                      Tx
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tradesData?.trades.map((trade) => {
                    const chain =
                      trade.instance?.config?.chain || selectedBot?.config?.chain || 'SOLANA';
                    return (
                      <tr key={trade.id} className="border-b border-border">
                        <td className="py-3 px-2 text-sm">
                          {formatDate(trade.createdAt)}
                        </td>
                        <td className="py-3 px-2">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              trade.side === 'BUY'
                                ? 'bg-green-400/20 text-green-400'
                                : 'bg-red-400/20 text-red-400'
                            }`}
                          >
                            {trade.side}
                          </span>
                        </td>
                        <td className="py-3 px-2">
                          <span className={`text-sm ${getStatusColor(trade.status)}`}>
                            {trade.status}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-right text-sm">
                          {trade.fill
                            ? formatNumber(trade.fill.baseQty, 4)
                            : formatNumber(trade.quotedBaseQty, 4)}
                        </td>
                        <td className="py-3 px-2 text-right text-sm">
                          {trade.fill
                            ? formatCurrency(trade.fill.quoteQty)
                            : formatCurrency(trade.quotedQuoteQty)}
                        </td>
                        <td className="py-3 px-2 text-right text-sm">
                          {trade.fill
                            ? formatCurrency(trade.fill.executedPrice, 4)
                            : formatCurrency(trade.quotePrice, 4)}
                        </td>
                        <td className="py-3 px-2 text-right text-sm">
                          {trade.fill?.realizedPnl !== null &&
                          trade.fill?.realizedPnl !== undefined ? (
                            <span className={getPnLColor(trade.fill.realizedPnl)}>
                              {formatCurrency(trade.fill.realizedPnl)}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-3 px-2 text-center">
                          {trade.fill?.txSignature && (
                            <a
                              href={getExplorerUrl(chain, trade.fill.txSignature)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:text-primary/80"
                            >
                              <ExternalLink className="h-4 w-4 inline" />
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {tradesData && tradesData.pagination.total > limit && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                Showing {page * limit + 1} -{' '}
                {Math.min((page + 1) * limit, tradesData.pagination.total)} of{' '}
                {tradesData.pagination.total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!tradesData.pagination.hasMore}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
