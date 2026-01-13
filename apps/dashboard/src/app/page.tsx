'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Button } from '@/components/button';
import {
  Activity,
  DollarSign,
  TrendingUp,
  Zap,
  Shield,
  BarChart3,
  Settings,
  Bot,
} from 'lucide-react';
import Link from 'next/link';

export default function HomePage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center py-12">
        <div className="flex items-center justify-center gap-3 mb-4">
          <Bot className="h-12 w-12 text-primary" />
          <h1 className="text-5xl font-bold">Autobot</h1>
        </div>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
          Automated trading bot for Solana and Avalanche with intelligent buy-dip/sell-rise strategies
        </p>
      </div>

      {/* Feature Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/20">
                <Zap className="h-6 w-6 text-blue-400" />
              </div>
              <CardTitle>Multi-Chain Support</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Trade on Solana via Jupiter v6 API and Avalanche via ParaSwap.
              Execute swaps with optimal routing and minimal slippage.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20">
                <TrendingUp className="h-6 w-6 text-green-400" />
              </div>
              <CardTitle>Buy-Dip / Sell-Rise</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Configurable strategy that automatically buys on dips and sells on rises.
              Set your own thresholds and let the bot execute.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/20">
                <Shield className="h-6 w-6 text-purple-400" />
              </div>
              <CardTitle>Safety Controls</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Built-in circuit breakers, slippage limits, rate limiting,
              daily loss limits, and max drawdown protection.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/20">
                <BarChart3 className="h-6 w-6 text-orange-400" />
              </div>
              <CardTitle>Execution Cost Gating</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Smart execution that calculates net edge before trading.
              Only executes when profitable after fees and slippage.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/20">
                <Activity className="h-6 w-6 text-cyan-400" />
              </div>
              <CardTitle>Regime Detection</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Automatically detects market conditions (trending, ranging, volatile, chaos)
              and adapts trading parameters accordingly.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/20">
                <DollarSign className="h-6 w-6 text-yellow-400" />
              </div>
              <CardTitle>Scale-Out Exits</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Optional fee-efficient exit strategy. Sell 65% at target,
              hold 35% for extended gains with trailing stop protection.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <Link href="/bots">
              <Button>
                <Bot className="mr-2 h-4 w-4" />
                Manage Bots
              </Button>
            </Link>
            <Link href="/configure">
              <Button variant="secondary">
                <Settings className="mr-2 h-4 w-4" />
                Configure
              </Button>
            </Link>
            <Link href="/trades">
              <Button variant="secondary">
                <Activity className="mr-2 h-4 w-4" />
                View Trades
              </Button>
            </Link>
            <Link href="/pnl">
              <Button variant="secondary">
                <BarChart3 className="mr-2 h-4 w-4" />
                PnL Analysis
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Architecture Overview */}
      <Card>
        <CardHeader>
          <CardTitle>Architecture</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <h3 className="font-semibold">Frontend</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Next.js 14 with App Router</li>
                <li>React Query for data fetching</li>
                <li>Tailwind CSS styling</li>
                <li>Real-time status updates</li>
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold">Backend</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Fastify REST API</li>
                <li>PostgreSQL with Prisma ORM</li>
                <li>Trading worker with cycle loop</li>
                <li>Discord/webhook alerts</li>
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold">Solana Integration</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Jupiter v6 aggregator</li>
                <li>SOL/USDC trading pair</li>
                <li>Priority fees support</li>
                <li>Transaction confirmation</li>
              </ul>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold">Avalanche Integration</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>ParaSwap aggregator</li>
                <li>AVAX/USDC trading pair</li>
                <li>EIP-1559 gas pricing</li>
                <li>Multi-DEX routing</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-sm text-muted-foreground py-4">
        <p>Autobot Trading System v1.0.0</p>
      </div>
    </div>
  );
}
