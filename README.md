# Autobot - Automated Trading Bot

A production-grade automated trading application for Solana (SOL/USDC) and Avalanche (AVAX/USDC) pairs.

## Features

- **Dual Chain Support**: Trade on Solana (via Jupiter v6) and Avalanche (via ParaSwap)
- **Configurable Strategy**: Buy on dips, sell on rises with customizable thresholds
- **Safety Controls**: Circuit breakers, rate limiting, slippage protection, daily loss limits
- **Real-time Dashboard**: Monitor status, view trades, track PnL
- **Webhook Alerts**: Discord and generic webhook notifications
- **PnL Tracking**: Realized and unrealized PnL with average cost basis

## Architecture

```
├── apps/
│   └── dashboard/          # Next.js web dashboard
├── services/
│   └── bot/                # Fastify backend service
├── packages/
│   ├── core/               # Strategy engine, types, utilities
│   ├── db/                 # Prisma database schema
│   ├── solana-adapter/     # Jupiter v6 integration
│   └── avalanche-adapter/  # ParaSwap integration
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 16+
- Docker (optional, for containerized deployment)

### Development Setup

1. **Clone and install dependencies**:
```bash
cd Autobot
pnpm install
```

2. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Set up database**:
```bash
pnpm db:generate
pnpm db:push
```

4. **Start development servers**:
```bash
# Terminal 1: Start backend
pnpm dev:bot

# Terminal 2: Start dashboard
pnpm dev:dashboard
```

5. **Access dashboard**: http://localhost:3000

### Docker Deployment

1. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your private keys and RPC URLs
```

2. **Start all services**:
```bash
docker compose up -d
```

3. **Access dashboard**: http://localhost:3000

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `SOLANA_PRIVATE_KEY_BASE58` | Solana wallet private key (base58) | For Solana |
| `EVM_PRIVATE_KEY` | Avalanche wallet private key (hex) | For Avalanche |
| `SOLANA_RPC_URL` | Solana RPC endpoint | For Solana |
| `AVALANCHE_RPC_URL` | Avalanche RPC endpoint | For Avalanche |

See `.env.example` for all options.

### Strategy Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `buyDipPct` | 2% | Buy when price drops X% from last sell |
| `sellRisePct` | 5% | Sell when price rises X% from last buy |
| `tradeSize` | 25 USDC | Trade size (depends on mode) |
| `maxSlippageBps` | 50 | Maximum slippage in basis points |
| `cooldownSeconds` | 60 | Minimum seconds between trades |
| `maxTradesPerHour` | 10 | Maximum trades per hour |
| `dailyLossLimitUsdc` | 50 | Stop trading after X USDC daily loss |

## Wallet Setup

### Solana

1. Create a new wallet using Phantom or Solflare
2. Export the private key (Settings → Security → Export Private Key)
3. Fund the wallet with SOL (for gas) and USDC
4. Set `SOLANA_PRIVATE_KEY_BASE58` in `.env`

### Avalanche

1. Create a new wallet (MetaMask or similar)
2. Export the private key (Account Details → Export Private Key)
3. Fund the wallet with AVAX (for gas) and USDC
4. Set `EVM_PRIVATE_KEY` in `.env`

**IMPORTANT**: Use a dedicated wallet with limited funds for trading. Never use your main wallet.

## Verifying First Trade

1. Create a bot configuration in the dashboard
2. Set `dryRunMode: true` initially to test
3. Start the bot and verify it's getting quotes
4. Disable dry run mode when ready
5. The bot will execute the first trade based on `startingMode`

## Safety Features

- **Slippage Protection**: Trades abort if slippage exceeds configured maximum
- **Price Impact Check**: Optional maximum price impact threshold
- **Rate Limiting**: Configurable max trades per hour
- **Daily Loss Limit**: Auto-pause after configured daily loss
- **Consecutive Failure Limit**: Auto-pause after N failed trades
- **Gas Reserves**: Always keeps minimum SOL/AVAX for gas
- **Dry Run Mode**: Test strategy without executing trades

## API Endpoints

### Health
- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed connectivity status

### Configuration
- `GET /api/configs` - List all configurations
- `POST /api/configs` - Create configuration
- `PATCH /api/configs/:id` - Update configuration
- `DELETE /api/configs/:id` - Delete configuration

### Bots
- `GET /api/bots` - List all bot instances
- `POST /api/bots` - Create bot instance
- `POST /api/bots/:id/start` - Start bot
- `POST /api/bots/:id/stop` - Stop bot
- `GET /api/bots/:id/status` - Get live status

### Trades
- `GET /api/trades` - List trades
- `GET /api/bots/:id/trades/stats` - Trade statistics

### PnL
- `GET /api/bots/:id/pnl` - PnL summary
- `GET /api/bots/:id/positions` - Position history
- `GET /api/bots/:id/export/csv` - Export trades CSV

## Troubleshooting

### Bot not starting
- Check RPC connectivity in dashboard (Configure → Test Connectivity)
- Verify private key is correct format
- Ensure wallet has sufficient balance

### Trades failing
- Check slippage settings (increase if needed during volatility)
- Verify RPC endpoint is responsive
- Check for circuit breaker triggers

### High slippage
- Reduce trade size
- Add more allowed DEXes for better routing
- Trade during lower volatility periods

## Development

### Build all packages
```bash
pnpm build
```

### Run tests
```bash
pnpm test
```

### Type checking
```bash
pnpm typecheck
```

### Database migrations
```bash
pnpm db:migrate
```

## Security Considerations

1. **Never commit private keys** - Use environment variables
2. **Use dedicated wallets** - Limited funds, separate from main holdings
3. **Monitor regularly** - Check dashboard and alerts
4. **Start small** - Test with minimal trade sizes first
5. **Understand the risks** - Automated trading can result in losses

## License

MIT
