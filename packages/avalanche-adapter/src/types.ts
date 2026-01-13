// ParaSwap API types

export interface ParaSwapPriceRequest {
  srcToken: string;
  destToken: string;
  srcDecimals: number;
  destDecimals: number;
  amount: string;
  side: 'SELL' | 'BUY';
  network: number;
  excludeDEXS?: string;
  includeDEXS?: string;
  partner?: string;
}

export interface ParaSwapPriceResponse {
  priceRoute: ParaSwapPriceRoute;
}

export interface ParaSwapPriceRoute {
  blockNumber: number;
  network: number;
  srcToken: string;
  srcDecimals: number;
  srcAmount: string;
  destToken: string;
  destDecimals: number;
  destAmount: string;
  bestRoute: ParaSwapRouteStep[];
  gasCostUSD: string;
  gasCost: string;
  srcUSD: string;
  destUSD: string;
  side: 'SELL' | 'BUY';
  tokenTransferProxy: string;
  contractAddress: string;
  contractMethod: string;
  partnerFee: number;
  maxImpactReached: boolean;
  hmac: string;
}

export interface ParaSwapRouteStep {
  percent: number;
  swaps: ParaSwapSwap[];
}

export interface ParaSwapSwap {
  srcToken: string;
  srcDecimals: number;
  destToken: string;
  destDecimals: number;
  swapExchanges: ParaSwapExchange[];
}

export interface ParaSwapExchange {
  exchange: string;
  srcAmount: string;
  destAmount: string;
  percent: number;
  poolAddresses?: string[];
  data?: {
    router?: string;
    path?: string[];
    factory?: string;
    initCode?: string;
    gasUSD?: string;
  };
}

export interface ParaSwapTransactionRequest {
  srcToken: string;
  destToken: string;
  srcAmount: string;
  destAmount: string;
  priceRoute: ParaSwapPriceRoute;
  userAddress: string;
  partner?: string;
  partnerAddress?: string;
  slippage: number; // In basis points (10000 = 100%)
  deadline?: number;
  receiver?: string;
}

export interface ParaSwapTransactionResponse {
  from: string;
  to: string;
  value: string;
  data: string;
  gasPrice: string;
  chainId: number;
}

// LI.FI API types (alternative aggregator)

export interface LifiQuoteRequest {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  fromAddress: string;
  slippage?: number;
  order?: 'RECOMMENDED' | 'FASTEST' | 'CHEAPEST' | 'SAFEST';
  denyExchanges?: string[];
  allowExchanges?: string[];
}

export interface LifiQuoteResponse {
  id: string;
  type: string;
  tool: string;
  action: {
    fromChainId: number;
    fromAmount: string;
    fromToken: LifiToken;
    toChainId: number;
    toToken: LifiToken;
    slippage: number;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
    gasCosts: LifiGasCost[];
    feeCosts: LifiFeeCost[];
  };
  includedSteps: LifiStep[];
  transactionRequest?: {
    from: string;
    to: string;
    chainId: number;
    data: string;
    value: string;
    gasLimit: string;
    gasPrice: string;
  };
}

export interface LifiToken {
  address: string;
  chainId: number;
  symbol: string;
  decimals: number;
  name: string;
  priceUSD: string;
}

export interface LifiGasCost {
  type: string;
  price: string;
  estimate: string;
  limit: string;
  amount: string;
  amountUSD: string;
  token: LifiToken;
}

export interface LifiFeeCost {
  name: string;
  description: string;
  percentage: string;
  token: LifiToken;
  amount: string;
  amountUSD: string;
  included: boolean;
}

export interface LifiStep {
  id: string;
  type: string;
  tool: string;
  toolDetails: {
    key: string;
    name: string;
    logoURI: string;
  };
  action: {
    fromChainId: number;
    fromAmount: string;
    fromToken: LifiToken;
    toChainId: number;
    toToken: LifiToken;
    slippage: number;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
  };
}

// Avalanche adapter config

export interface AvalancheAdapterConfig {
  rpcUrl: string;
  privateKey: string; // Hex string with or without 0x prefix
  preferredAggregator?: 'paraswap' | 'lifi' | 'traderjoe';
  paraswapPartner?: string;
  maxGasPriceGwei?: bigint;
  maxRetries?: number;
}

// Trader Joe specific types

export interface TraderJoePath {
  pairBinSteps: bigint[];
  versions: number[];
  tokenPath: string[];
}

export interface TraderJoeQuote {
  amountIn: bigint;
  amountOut: bigint;
  path: TraderJoePath;
  lbPair: string;
  binStep: number;
}
