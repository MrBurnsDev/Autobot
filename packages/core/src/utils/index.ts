import Decimal from 'decimal.js';
import { createHash, randomUUID } from 'crypto';

// Configure Decimal.js for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Safe decimal arithmetic for financial calculations
 */
export function safeMultiply(a: number, b: number): number {
  return new Decimal(a).mul(b).toNumber();
}

export function safeDivide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return new Decimal(a).div(b).toNumber();
}

export function safeAdd(a: number, b: number): number {
  return new Decimal(a).add(b).toNumber();
}

export function safeSubtract(a: number, b: number): number {
  return new Decimal(a).sub(b).toNumber();
}

/**
 * Convert basis points to decimal multiplier
 * e.g., 50 bps = 0.005 = 0.5%
 */
export function bpsToDecimal(bps: number): number {
  return new Decimal(bps).div(10000).toNumber();
}

/**
 * Calculate basis points difference between two prices
 */
export function calculateBpsDifference(price1: number, price2: number): number {
  if (price1 === 0) return 0;
  const diff = new Decimal(price2).sub(price1).div(price1).mul(10000);
  return Math.round(diff.toNumber());
}

/**
 * Calculate percentage change
 */
export function calculatePercentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return new Decimal(newValue).sub(oldValue).div(oldValue).mul(100).toNumber();
}

/**
 * Apply slippage to an amount
 */
export function applySlippage(amount: number, slippageBps: number, isBuy: boolean): number {
  const slippageFactor = bpsToDecimal(slippageBps);
  if (isBuy) {
    // For buys, we expect to receive less
    return new Decimal(amount).mul(1 - slippageFactor).toNumber();
  } else {
    // For sells, we expect to pay more
    return new Decimal(amount).mul(1 + slippageFactor).toNumber();
  }
}

/**
 * Generate a deterministic client order ID for idempotency
 */
export function generateClientOrderId(
  instanceId: string,
  side: string,
  timestamp: number,
  nonce?: string
): string {
  const input = `${instanceId}:${side}:${timestamp}:${nonce ?? randomUUID()}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Format token amount with proper decimals
 */
export function formatTokenAmount(amount: number, decimals: number): string {
  return new Decimal(amount).toFixed(decimals);
}

/**
 * Parse token amount from raw value
 */
export function parseTokenAmount(rawAmount: bigint | number, decimals: number): number {
  return new Decimal(rawAmount.toString()).div(new Decimal(10).pow(decimals)).toNumber();
}

/**
 * Convert token amount to raw value
 */
export function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(new Decimal(amount).mul(new Decimal(10).pow(decimals)).floor().toString());
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    shouldRetry?: (error: Error) => boolean;
  }
): Promise<T> {
  const { maxRetries, initialDelayMs, maxDelayMs, shouldRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRatePerSecond: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.refillRatePerSecond * 1000;
      await sleep(waitTime);
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerSecond);
    this.lastRefill = now;
  }
}

/**
 * Simple logger that never logs secrets
 */
export class Logger {
  private sensitiveKeys = [
    'privateKey',
    'secretKey',
    'apiKey',
    'password',
    'secret',
    'token',
    'PRIVATE_KEY',
    'SECRET_KEY',
    'API_KEY',
  ];

  constructor(private context: string) {}

  private sanitize(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitize(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (this.sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private format(level: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const sanitizedData = data ? JSON.stringify(this.sanitize(data)) : '';
    return `[${timestamp}] [${level}] [${this.context}] ${message} ${sanitizedData}`.trim();
  }

  info(message: string, data?: unknown): void {
    console.info(this.format('INFO', message, data));
  }

  warn(message: string, data?: unknown): void {
    console.warn(this.format('WARN', message, data));
  }

  error(message: string, data?: unknown): void {
    console.error(this.format('ERROR', message, data));
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG === 'true') {
      console.info(this.format('DEBUG', message, data));
    }
  }
}

/**
 * Check if we're in the same hour for rate limiting
 */
export function isSameHour(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate() &&
    date1.getHours() === date2.getHours()
  );
}

/**
 * Check if we're in the same day for daily limits
 */
export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}
