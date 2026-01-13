'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { botApi, configApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import { Play, Square, Trash2, Plus, RefreshCw } from 'lucide-react';
import { formatRelativeTime, getStatusColor, formatCurrency } from '@/lib/utils';
import Link from 'next/link';
import { useState } from 'react';

export default function BotsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState('');

  const { data: bots, isLoading } = useQuery({
    queryKey: ['bots'],
    queryFn: botApi.list,
  });

  const { data: configs } = useQuery({
    queryKey: ['configs'],
    queryFn: configApi.list,
  });

  const startMutation = useMutation({
    mutationFn: botApi.start,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: botApi.stop,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: botApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Bots</h1>
          <p className="text-muted-foreground">Manage your trading bot instances</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Bot
        </Button>
      </div>

      {/* Create Bot Dialog */}
      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>Create New Bot Instance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Select Configuration
                </label>
                <select
                  value={selectedConfigId}
                  onChange={(e) => setSelectedConfigId(e.target.value)}
                  className="w-full rounded-md border border-border bg-secondary p-2"
                >
                  <option value="">Select a config...</option>
                  {availableConfigs?.map((config) => (
                    <option key={config.id} value={config.id}>
                      {config.name} ({config.chain})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
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
              {!availableConfigs?.length && (
                <p className="text-sm text-muted-foreground">
                  No available configurations.{' '}
                  <Link href="/configure" className="text-primary hover:underline">
                    Create one first
                  </Link>
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bot List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : bots?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No bot instances yet</p>
            <p className="text-sm text-muted-foreground mt-2">
              Create a configuration first, then create a bot instance
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {bots?.map((bot) => (
            <Card key={bot.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold">
                        {bot.config?.name || 'Bot Instance'}
                      </h3>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusColor(
                          bot.status
                        )}`}
                      >
                        {bot.status}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs bg-secondary">
                        {bot.config?.chain}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground space-x-4">
                      <span>
                        Buys: {bot.totalBuys} ({formatCurrency(bot.totalBuyVolume)})
                      </span>
                      <span>
                        Sells: {bot.totalSells} ({formatCurrency(bot.totalSellVolume)})
                      </span>
                      {bot.lastTradeAt && (
                        <span>Last trade: {formatRelativeTime(bot.lastTradeAt)}</span>
                      )}
                    </div>
                    {bot.lastError && (
                      <p className="text-sm text-red-400">{bot.lastError}</p>
                    )}
                    {bot.pauseReason && (
                      <p className="text-sm text-yellow-400">{bot.pauseReason}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {bot.status === 'RUNNING' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => stopMutation.mutate(bot.id)}
                        disabled={stopMutation.isPending}
                      >
                        <Square className="mr-1 h-4 w-4" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => startMutation.mutate(bot.id)}
                        disabled={startMutation.isPending}
                      >
                        <Play className="mr-1 h-4 w-4" />
                        Start
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (confirm('Are you sure you want to delete this bot?')) {
                          deleteMutation.mutate(bot.id);
                        }
                      }}
                      disabled={bot.status === 'RUNNING' || deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
