// Jupiter API v6 types

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string; // In smallest unit (lamports/token units)
  slippageBps: number;
  swapMode?: 'ExactIn' | 'ExactOut';
  dexes?: string[]; // Allowed DEXes
  excludeDexes?: string[]; // Excluded DEXes
  restrictIntermediateTokens?: boolean;
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
  platformFeeBps?: number;
  maxAccounts?: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  platformFee: {
    amount: string;
    feeBps: number;
  } | null;
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterRoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterSwapRequest {
  userPublicKey: string;
  quoteResponse: JupiterQuoteResponse;
  wrapAndUnwrapSol?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  trackingAccount?: string;
  computeUnitPriceMicroLamports?: number;
  prioritizationFeeLamports?: number | 'auto';
  asLegacyTransaction?: boolean;
  useTokenLedger?: boolean;
  destinationTokenAccount?: string;
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
}

export interface JupiterSwapResponse {
  swapTransaction: string; // Base64 encoded versioned transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: JupiterInstruction;
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction;
  addressLookupTableAddresses: string[];
}

export interface JupiterInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
}

export interface SolanaAdapterConfig {
  rpcUrl: string;
  privateKeyBase58: string;
  jupiterApiBase?: string;
  jupiterApiKey?: string; // API key from https://station.jup.ag
  priorityFeeMicroLamports?: number;
  useVersionedTransactions?: boolean;
  confirmationCommitment?: 'processed' | 'confirmed' | 'finalized';
  maxRetries?: number;
}

export interface TransactionMeta {
  slot: number;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  err: unknown;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
  owner?: string;
  programId?: string;
}

// D3fenders Swap API response wrappers
export interface D3fendersQuoteResponse {
  success: boolean;
  data: JupiterQuoteResponse;
  fee?: {
    enabled: boolean;
    bps: number;
    percentage: string;
    estimatedLamports: string;
    estimatedSol: string;
    treasury: string;
  };
}

export interface D3fendersBuildResponse {
  success: boolean;
  data: JupiterSwapResponse;
  fee?: {
    enabled: boolean;
    bps: number;
    percentage: string;
    estimatedLamports: string;
    estimatedSol: string;
    treasury: string;
  };
}
