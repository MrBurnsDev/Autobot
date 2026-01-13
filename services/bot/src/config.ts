import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.string().default('3001'),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string(),

  // Redis (optional)
  REDIS_URL: z.string().optional(),

  // Solana
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  SOLANA_PRIVATE_KEY_BASE58: z.string().optional(),
  JUPITER_API_BASE: z.string().default('https://quote-api.jup.ag/v6'),
  SOLANA_PRIORITY_FEE_MICRO_LAMPORTS: z.string().default('1000'),

  // Avalanche
  AVALANCHE_RPC_URL: z.string().default('https://api.avax.network/ext/bc/C/rpc'),
  EVM_PRIVATE_KEY: z.string().optional(),
  PARASWAP_PARTNER: z.string().default('autobot'),
  AVALANCHE_MAX_GAS_GWEI: z.string().default('100'),

  // Bot settings
  BOT_LOOP_INTERVAL_MS: z.string().default('10000'),
  POSITION_SNAPSHOT_INTERVAL_MS: z.string().default('60000'),
  PNL_SNAPSHOT_INTERVAL_MS: z.string().default('3600000'),

  // Alerting (optional)
  WEBHOOK_URL: z.string().optional(),
  DISCORD_WEBHOOK_URL: z.string().optional(),

  // Debug
  DEBUG: z.string().default('false'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return {
    server: {
      port: parseInt(result.data.PORT, 10),
      host: result.data.HOST,
      nodeEnv: result.data.NODE_ENV,
    },
    database: {
      url: result.data.DATABASE_URL,
    },
    redis: result.data.REDIS_URL
      ? {
          url: result.data.REDIS_URL,
        }
      : undefined,
    solana: {
      rpcUrl: result.data.SOLANA_RPC_URL,
      privateKeyBase58: result.data.SOLANA_PRIVATE_KEY_BASE58,
      jupiterApiBase: result.data.JUPITER_API_BASE,
      priorityFeeMicroLamports: parseInt(result.data.SOLANA_PRIORITY_FEE_MICRO_LAMPORTS, 10),
    },
    avalanche: {
      rpcUrl: result.data.AVALANCHE_RPC_URL,
      privateKey: result.data.EVM_PRIVATE_KEY,
      paraswapPartner: result.data.PARASWAP_PARTNER,
      maxGasGwei: BigInt(result.data.AVALANCHE_MAX_GAS_GWEI),
    },
    bot: {
      loopIntervalMs: parseInt(result.data.BOT_LOOP_INTERVAL_MS, 10),
      positionSnapshotIntervalMs: parseInt(result.data.POSITION_SNAPSHOT_INTERVAL_MS, 10),
      pnlSnapshotIntervalMs: parseInt(result.data.PNL_SNAPSHOT_INTERVAL_MS, 10),
    },
    alerts: {
      webhookUrl: result.data.WEBHOOK_URL,
      discordWebhookUrl: result.data.DISCORD_WEBHOOK_URL,
    },
    debug: result.data.DEBUG === 'true',
  };
}

export const config = loadConfig();
export type Config = typeof config;
