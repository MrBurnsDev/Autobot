export class AutobotError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean = false,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AutobotError';
  }
}

export class QuoteError extends AutobotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'QUOTE_ERROR', true, details);
    this.name = 'QuoteError';
  }
}

export class InsufficientBalanceError extends AutobotError {
  constructor(
    public required: number,
    public available: number,
    public asset: string
  ) {
    super(
      `Insufficient ${asset} balance: required ${required}, available ${available}`,
      'INSUFFICIENT_BALANCE',
      false,
      { required, available, asset }
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class SlippageExceededError extends AutobotError {
  constructor(
    public expected: number,
    public actual: number
  ) {
    super(
      `Slippage exceeded: expected ${expected} bps, actual ${actual} bps`,
      'SLIPPAGE_EXCEEDED',
      true,
      { expected, actual }
    );
    this.name = 'SlippageExceededError';
  }
}

export class PriceImpactError extends AutobotError {
  constructor(
    public impactBps: number,
    public maxBps: number
  ) {
    super(
      `Price impact too high: ${impactBps} bps exceeds max ${maxBps} bps`,
      'PRICE_IMPACT_EXCEEDED',
      true,
      { impactBps, maxBps }
    );
    this.name = 'PriceImpactError';
  }
}

export class TransactionError extends AutobotError {
  constructor(
    message: string,
    public txSignature?: string,
    retryable: boolean = false,
    details?: Record<string, unknown>
  ) {
    super(message, 'TRANSACTION_ERROR', retryable, { ...details, txSignature });
    this.name = 'TransactionError';
  }
}

export class RpcError extends AutobotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'RPC_ERROR', true, details);
    this.name = 'RpcError';
  }
}

export class CircuitBreakerError extends AutobotError {
  constructor(
    public reason: string,
    details?: Record<string, unknown>
  ) {
    super(`Circuit breaker triggered: ${reason}`, 'CIRCUIT_BREAKER', false, details);
    this.name = 'CircuitBreakerError';
  }
}

export class PriceDeviationError extends AutobotError {
  constructor(
    public primaryPrice: number,
    public secondaryPrice: number,
    public deviationBps: number,
    public maxDeviationBps: number
  ) {
    super(
      `Price deviation too high: ${deviationBps} bps exceeds max ${maxDeviationBps} bps`,
      'PRICE_DEVIATION',
      true,
      { primaryPrice, secondaryPrice, deviationBps, maxDeviationBps }
    );
    this.name = 'PriceDeviationError';
  }
}

export class ConfigurationError extends AutobotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', false, details);
    this.name = 'ConfigurationError';
  }
}

export class DuplicateOrderError extends AutobotError {
  constructor(public clientOrderId: string) {
    super(`Duplicate order attempted: ${clientOrderId}`, 'DUPLICATE_ORDER', false, {
      clientOrderId,
    });
    this.name = 'DuplicateOrderError';
  }
}
