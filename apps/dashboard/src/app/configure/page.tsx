'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, healthApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import { Plus, Trash2, Edit, Check, RefreshCw, Zap } from 'lucide-react';
import { useState } from 'react';
import {
  STRATEGY_PRESETS,
  applyPreset,
  type PresetId,
} from '@/lib/presets';

const SOLANA_DEXES = [
  'Orca',
  'Raydium',
  'Meteora',
  'Phoenix',
  'Lifinity',
  'OpenBook',
];

const AVALANCHE_DEXES = [
  'TraderJoe',
  'TraderJoeV2',
  'Pangolin',
  'SushiSwap',
  'Curve',
  'KyberSwap',
];

const defaultConfig = {
  name: '',
  chain: 'SOLANA' as 'SOLANA' | 'AVALANCHE',
  buyDipPct: 2,
  sellRisePct: 5,
  tradeSizeMode: 'FIXED_QUOTE' as 'FIXED_QUOTE' | 'FIXED_BASE' | 'PERCENT_BALANCE',
  tradeSize: 25,
  minTradeNotional: 10,
  maxSlippageBps: 50,
  maxPriceImpactBps: 100 as number | null,
  cooldownSeconds: 60,
  maxTradesPerHour: 10,
  dailyLossLimitUsdc: 50 as number | null,
  maxDrawdownPct: 10 as number | null,
  maxConsecutiveFailures: 3,
  minBaseReserve: 0.01,
  minQuoteReserve: 5,
  startingMode: 'START_BY_BUYING' as 'START_BY_BUYING' | 'START_BY_SELLING' | 'START_NEUTRAL',
  pnlMethod: 'AVERAGE_COST' as 'AVERAGE_COST' | 'FIFO',
  allowedSources: [] as string[],
  excludedSources: [] as string[],
  maxPriceDeviationBps: 200,
  dryRunMode: false,
  // Compounding settings
  compoundingMode: 'FIXED' as 'FIXED' | 'FULL_BALANCE' | 'CALCULATED',
  initialTradeSizeUsdc: null as number | null,
  compoundingReservePct: 5,
  // Multi-step scale-out settings
  scaleOutSteps: 1,
  scaleOutRangePct: 2.0,
  scaleOutSpacingPct: null as number | null,
  // Exit mode settings
  exitMode: 'FULL_EXIT' as 'FULL_EXIT' | 'SCALE_OUT',
  scaleOutPrimaryPct: 0.65,
  scaleOutSecondaryPct: 0.35,
  // Rolling rebuy settings
  cycleMode: 'STANDARD' as 'STANDARD' | 'ROLLING_REBUY',
  primarySellPct: 80,
  allowRebuy: false,
  maxRebuyCount: 1,
  exposureCapPct: 50,
  rebuyRegimeGate: true,
  rebuyDipPct: null as number | null,
};

export default function ConfigurePage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(defaultConfig);
  const [creating, setCreating] = useState(false);
  const [testingChain, setTestingChain] = useState<'SOLANA' | 'AVALANCHE' | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const { data: configs, isLoading } = useQuery({
    queryKey: ['configs'],
    queryFn: configApi.list,
  });

  const createMutation = useMutation({
    mutationFn: configApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      setCreating(false);
      setFormData(defaultConfig);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: typeof formData }) =>
      configApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: configApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['configs'] });
    },
  });

  const handleTestConnectivity = async (chain: 'SOLANA' | 'AVALANCHE') => {
    setTestingChain(chain);
    setTestResult(null);
    try {
      const result = await healthApi.checkConnectivity(chain);
      setTestResult({
        success: result.rpcConnected && result.apiConnected,
        message: result.rpcConnected && result.apiConnected
          ? `Connected! Latency: ${result.latencyMs}ms`
          : `Errors: ${result.errors.join(', ')}`,
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: (err as Error).message,
      });
    } finally {
      setTestingChain(null);
    }
  };

  const dexOptions = formData.chain === 'SOLANA' ? SOLANA_DEXES : AVALANCHE_DEXES;

  const handleApplyPreset = (presetId: PresetId) => {
    const preset = STRATEGY_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setFormData(applyPreset(formData, preset));
    }
  };

  const renderPresetSelector = () => (
    <div className="mb-6 p-4 bg-secondary/50 rounded-lg border border-border">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="h-4 w-4 text-primary" />
        <h4 className="font-medium">Quick Start Presets</h4>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Apply a preset to quickly configure your strategy. You can customize settings after applying.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {STRATEGY_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handleApplyPreset(preset.id)}
            className="p-3 text-left rounded-lg border border-border bg-background hover:border-primary/50 hover:bg-primary/5 transition-colors"
          >
            <div className="mb-1">
              <span className="font-medium text-sm">{preset.shortName}</span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {preset.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  );

  const renderForm = () => (
    <div className="space-y-6">
      {renderPresetSelector()}
      <div className="grid gap-4 md:grid-cols-2">
      {/* Basic Settings */}
      <div className="space-y-4">
        <h4 className="font-medium">Basic Settings</h4>

        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="w-full rounded-md border border-border bg-secondary p-2"
            placeholder="My Trading Bot"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Chain</label>
          <select
            value={formData.chain}
            onChange={(e) =>
              setFormData({
                ...formData,
                chain: e.target.value as 'SOLANA' | 'AVALANCHE',
                allowedSources: [],
                excludedSources: [],
              })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          >
            <option value="SOLANA">Solana (SOL/USDC)</option>
            <option value="AVALANCHE">Avalanche (AVAX/USDC)</option>
          </select>
        </div>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleTestConnectivity(formData.chain)}
            disabled={!!testingChain}
          >
            {testingChain === formData.chain ? (
              <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            Test Connectivity
          </Button>
          {testResult && (
            <span
              className={`text-sm ${
                testResult.success ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {testResult.message}
            </span>
          )}
        </div>
      </div>

      {/* Strategy Settings */}
      <div className="space-y-4">
        <h4 className="font-medium">Strategy Settings</h4>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Buy Dip %</label>
            <input
              type="number"
              value={formData.buyDipPct}
              onChange={(e) =>
                setFormData({ ...formData, buyDipPct: parseFloat(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
              step="0.1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Sell Rise %</label>
            <input
              type="number"
              value={formData.sellRisePct}
              onChange={(e) =>
                setFormData({ ...formData, sellRisePct: parseFloat(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
              step="0.1"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Trade Size Mode</label>
          <select
            value={formData.tradeSizeMode}
            onChange={(e) =>
              setFormData({
                ...formData,
                tradeSizeMode: e.target.value as typeof formData.tradeSizeMode,
              })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          >
            <option value="FIXED_QUOTE">Fixed USDC Amount</option>
            <option value="FIXED_BASE">Fixed Base Amount</option>
            <option value="PERCENT_BALANCE">Percent of Balance</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Trade Size ({formData.tradeSizeMode === 'PERCENT_BALANCE' ? '%' : 'USDC'})
          </label>
          <input
            type="number"
            value={formData.tradeSize}
            onChange={(e) =>
              setFormData({ ...formData, tradeSize: parseFloat(e.target.value) })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Starting Mode</label>
          <select
            value={formData.startingMode}
            onChange={(e) =>
              setFormData({
                ...formData,
                startingMode: e.target.value as typeof formData.startingMode,
              })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          >
            <option value="START_BY_BUYING">Start by Buying</option>
            <option value="START_BY_SELLING">Start by Selling</option>
            <option value="START_NEUTRAL">Wait for Manual Trade</option>
          </select>
        </div>
      </div>

      {/* Safety Settings */}
      <div className="space-y-4">
        <h4 className="font-medium">Safety Controls</h4>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Max Slippage (bps)</label>
            <input
              type="number"
              value={formData.maxSlippageBps}
              onChange={(e) =>
                setFormData({ ...formData, maxSlippageBps: parseInt(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Cooldown (sec)</label>
            <input
              type="number"
              value={formData.cooldownSeconds}
              onChange={(e) =>
                setFormData({ ...formData, cooldownSeconds: parseInt(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Max Trades/Hour</label>
            <input
              type="number"
              value={formData.maxTradesPerHour}
              onChange={(e) =>
                setFormData({ ...formData, maxTradesPerHour: parseInt(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Daily Loss Limit (USDC)</label>
            <input
              type="number"
              value={formData.dailyLossLimitUsdc ?? ''}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  dailyLossLimitUsdc: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
              className="w-full rounded-md border border-border bg-secondary p-2"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="dryRunMode"
            checked={formData.dryRunMode}
            onChange={(e) =>
              setFormData({ ...formData, dryRunMode: e.target.checked })
            }
            className="rounded border-border"
          />
          <label htmlFor="dryRunMode" className="text-sm">
            Dry Run Mode (quotes only, no execution)
          </label>
        </div>
      </div>

      {/* Compounding Settings */}
      <div className="space-y-4">
        <h4 className="font-medium">Compounding Mode</h4>
        <p className="text-sm text-muted-foreground">
          Control how trade size grows with realized gains
        </p>

        <div>
          <label className="block text-sm font-medium mb-1">Mode</label>
          <select
            value={formData.compoundingMode}
            onChange={(e) =>
              setFormData({
                ...formData,
                compoundingMode: e.target.value as typeof formData.compoundingMode,
              })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          >
            <option value="FIXED">Fixed (original behavior)</option>
            <option value="FULL_BALANCE">Full Balance (use all available)</option>
            <option value="CALCULATED">Calculated (base + gains)</option>
          </select>
        </div>

        {formData.compoundingMode === 'CALCULATED' && (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">Initial Trade Size (USDC)</label>
              <input
                type="number"
                value={formData.initialTradeSizeUsdc ?? ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    initialTradeSizeUsdc: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                className="w-full rounded-md border border-border bg-secondary p-2"
                placeholder="Uses Trade Size if not set"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Base amount before compounding gains
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Reserve %: {formData.compoundingReservePct}%
              </label>
              <input
                type="range"
                min="0"
                max="50"
                step="1"
                value={formData.compoundingReservePct}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    compoundingReservePct: parseFloat(e.target.value),
                  })
                }
                className="w-full"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Percentage of gains to hold back as buffer
              </p>
            </div>
          </>
        )}

        {formData.compoundingMode === 'FULL_BALANCE' && (
          <div>
            <label className="block text-sm font-medium mb-1">
              Reserve %: {formData.compoundingReservePct}%
            </label>
            <input
              type="range"
              min="0"
              max="50"
              step="1"
              value={formData.compoundingReservePct}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  compoundingReservePct: parseFloat(e.target.value),
                })
              }
              className="w-full"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Percentage of balance to keep as reserve
            </p>
          </div>
        )}
      </div>

      {/* Multi-Step Scale-Out */}
      <div className="space-y-4">
        <h4 className="font-medium">Scale-Out Exits</h4>
        <p className="text-sm text-muted-foreground">
          Split exits across multiple price levels
        </p>

        <div>
          <label className="block text-sm font-medium mb-1">
            Exit Steps: {formData.scaleOutSteps}
          </label>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={formData.scaleOutSteps}
            onChange={(e) =>
              setFormData({
                ...formData,
                scaleOutSteps: parseInt(e.target.value),
              })
            }
            className="w-full"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {formData.scaleOutSteps === 1
              ? 'Single exit at target price (default)'
              : `${formData.scaleOutSteps} exits spread across price range`}
          </p>
        </div>

        {formData.scaleOutSteps > 1 && (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">
                Price Range %: {formData.scaleOutRangePct}%
              </label>
              <input
                type="range"
                min="0.5"
                max="5"
                step="0.1"
                value={formData.scaleOutRangePct}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    scaleOutRangePct: parseFloat(e.target.value),
                  })
                }
                className="w-full"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Total price range for multi-step exits
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Custom Spacing % (optional)</label>
              <input
                type="number"
                value={formData.scaleOutSpacingPct ?? ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    scaleOutSpacingPct: e.target.value ? parseFloat(e.target.value) : null,
                  })
                }
                className="w-full rounded-md border border-border bg-secondary p-2"
                placeholder="Auto-calculated from range"
                step="0.1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Override automatic spacing between exit levels
              </p>
            </div>
          </>
        )}
      </div>

      {/* DEX Selection */}
      <div className="space-y-4">
        <h4 className="font-medium">Liquidity Sources</h4>
        <p className="text-sm text-muted-foreground">
          Leave empty to use all available sources
        </p>

        <div className="space-y-2">
          <label className="block text-sm font-medium">Allowed DEXes</label>
          <div className="flex flex-wrap gap-2">
            {dexOptions.map((dex) => (
              <button
                key={dex}
                type="button"
                onClick={() => {
                  const current = formData.allowedSources;
                  if (current.includes(dex)) {
                    setFormData({
                      ...formData,
                      allowedSources: current.filter((d) => d !== dex),
                    });
                  } else {
                    setFormData({
                      ...formData,
                      allowedSources: [...current, dex],
                    });
                  }
                }}
                className={`px-2 py-1 text-sm rounded ${
                  formData.allowedSources.includes(dex)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary'
                }`}
              >
                {dex}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Rolling Rebuy Settings */}
      <div className="space-y-4">
        <h4 className="font-medium">Cycle Mode</h4>
        <p className="text-sm text-muted-foreground">
          Control buy/sell cycle behavior
        </p>

        <div>
          <label className="block text-sm font-medium mb-1">Mode</label>
          <select
            value={formData.cycleMode}
            onChange={(e) =>
              setFormData({
                ...formData,
                cycleMode: e.target.value as typeof formData.cycleMode,
              })
            }
            className="w-full rounded-md border border-border bg-secondary p-2"
          >
            <option value="STANDARD">Standard (full buy/sell cycles)</option>
            <option value="ROLLING_REBUY">Rolling Rebuy (partial sells + rebuy)</option>
          </select>
        </div>

        {formData.cycleMode === 'ROLLING_REBUY' && (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">
                Primary Sell %: {formData.primarySellPct}%
              </label>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={formData.primarySellPct}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    primarySellPct: parseFloat(e.target.value),
                  })
                }
                className="w-full"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Percentage of position to sell (remainder kept for potential rebuy)
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="allowRebuy"
                checked={formData.allowRebuy}
                onChange={(e) =>
                  setFormData({ ...formData, allowRebuy: e.target.checked })
                }
                className="rounded border-border"
              />
              <label htmlFor="allowRebuy" className="text-sm">
                Allow Rebuy on Dip
              </label>
            </div>

            {formData.allowRebuy && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Max Rebuys</label>
                    <input
                      type="number"
                      value={formData.maxRebuyCount}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          maxRebuyCount: parseInt(e.target.value),
                        })
                      }
                      className="w-full rounded-md border border-border bg-secondary p-2"
                      min="1"
                      max="5"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Exposure Cap %
                    </label>
                    <input
                      type="number"
                      value={formData.exposureCapPct}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          exposureCapPct: parseFloat(e.target.value),
                        })
                      }
                      className="w-full rounded-md border border-border bg-secondary p-2"
                      min="20"
                      max="100"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Rebuy Dip % (optional)
                  </label>
                  <input
                    type="number"
                    value={formData.rebuyDipPct ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rebuyDipPct: e.target.value ? parseFloat(e.target.value) : null,
                      })
                    }
                    className="w-full rounded-md border border-border bg-secondary p-2"
                    placeholder="Uses Buy Dip % if not set"
                    step="0.1"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="rebuyRegimeGate"
                    checked={formData.rebuyRegimeGate}
                    onChange={(e) =>
                      setFormData({ ...formData, rebuyRegimeGate: e.target.checked })
                    }
                    className="rounded border-border"
                  />
                  <label htmlFor="rebuyRegimeGate" className="text-sm">
                    Only rebuy in favorable regimes (not CHAOS)
                  </label>
                </div>
              </>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Configure</h1>
          <p className="text-muted-foreground">Create and manage bot configurations</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Config
        </Button>
      </div>

      {/* Create Form */}
      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>New Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            {renderForm()}
            <div className="flex gap-2 mt-6">
              <Button
                onClick={() => createMutation.mutate(formData)}
                disabled={!formData.name || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Configuration'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setCreating(false);
                  setFormData(defaultConfig);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Config List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : configs?.length === 0 && !creating ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No configurations yet</p>
            <Button className="mt-4" onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create Your First Config
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {configs?.map((config) => (
            <Card key={config.id}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{config.name}</h3>
                      <span className="px-2 py-0.5 rounded text-xs bg-secondary">
                        {config.chain}
                      </span>
                      {config.dryRunMode && (
                        <span className="px-2 py-0.5 rounded text-xs bg-yellow-400/20 text-yellow-400">
                          DRY RUN
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 space-x-4">
                      <span>Buy dip: {config.buyDipPct}%</span>
                      <span>Sell rise: {config.sellRisePct}%</span>
                      <span>Size: ${config.tradeSize}</span>
                      <span>Slippage: {config.maxSlippageBps}bps</span>
                    </div>
                    {config.instances?.length > 0 && (
                      <div className="text-sm text-muted-foreground mt-1">
                        Instances: {config.instances.map((i) => i.status).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditingId(config.id);
                        setFormData({
                          name: config.name,
                          chain: config.chain,
                          buyDipPct: config.buyDipPct,
                          sellRisePct: config.sellRisePct,
                          tradeSizeMode: config.tradeSizeMode,
                          tradeSize: config.tradeSize,
                          minTradeNotional: config.minTradeNotional,
                          maxSlippageBps: config.maxSlippageBps,
                          maxPriceImpactBps: config.maxPriceImpactBps,
                          cooldownSeconds: config.cooldownSeconds,
                          maxTradesPerHour: config.maxTradesPerHour,
                          dailyLossLimitUsdc: config.dailyLossLimitUsdc,
                          maxDrawdownPct: config.maxDrawdownPct,
                          maxConsecutiveFailures: config.maxConsecutiveFailures,
                          minBaseReserve: config.minBaseReserve,
                          minQuoteReserve: config.minQuoteReserve,
                          startingMode: config.startingMode,
                          pnlMethod: config.pnlMethod,
                          allowedSources: config.allowedSources,
                          excludedSources: config.excludedSources,
                          maxPriceDeviationBps: config.maxPriceDeviationBps,
                          dryRunMode: config.dryRunMode,
                          // Compounding settings
                          compoundingMode: config.compoundingMode ?? 'FIXED',
                          initialTradeSizeUsdc: config.initialTradeSizeUsdc,
                          compoundingReservePct: config.compoundingReservePct ?? 5,
                          // Multi-step scale-out settings
                          scaleOutSteps: config.scaleOutSteps ?? 1,
                          scaleOutRangePct: config.scaleOutRangePct ?? 2.0,
                          scaleOutSpacingPct: config.scaleOutSpacingPct,
                          // Exit mode settings
                          exitMode: config.exitMode ?? 'FULL_EXIT',
                          scaleOutPrimaryPct: config.scaleOutPrimaryPct ?? 0.65,
                          scaleOutSecondaryPct: config.scaleOutSecondaryPct ?? 0.35,
                          // Rolling rebuy settings
                          cycleMode: config.cycleMode ?? 'STANDARD',
                          primarySellPct: config.primarySellPct ?? 80,
                          allowRebuy: config.allowRebuy ?? false,
                          maxRebuyCount: config.maxRebuyCount ?? 1,
                          exposureCapPct: config.exposureCapPct ?? 50,
                          rebuyRegimeGate: config.rebuyRegimeGate ?? true,
                          rebuyDipPct: config.rebuyDipPct,
                        });
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (confirm('Delete this configuration?')) {
                          deleteMutation.mutate(config.id);
                        }
                      }}
                      disabled={
                        config.instances?.some((i) => i.status === 'RUNNING') ||
                        deleteMutation.isPending
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Edit Form */}
                {editingId === config.id && (
                  <div className="mt-4 pt-4 border-t border-border">
                    {renderForm()}
                    <div className="flex gap-2 mt-4">
                      <Button
                        onClick={() =>
                          updateMutation.mutate({ id: config.id, data: formData })
                        }
                        disabled={updateMutation.isPending}
                      >
                        {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEditingId(null);
                          setFormData(defaultConfig);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
