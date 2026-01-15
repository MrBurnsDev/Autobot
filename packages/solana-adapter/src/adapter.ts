import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionConfirmationStrategy,
  SendTransactionError,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

import type {
  ChainAdapter,
  BalanceInfo,
  QuoteParams,
  QuoteResult,
  SwapParams,
  SwapResult,
  ConnectivityStatus,
  RouteInfo,
} from '@autobot/core';
import {
  QuoteError,
  TransactionError,
  RpcError,
  InsufficientBalanceError,
  Logger,
  parseTokenAmount,
  toRawAmount,
  retryWithBackoff,
  sleep,
} from '@autobot/core';

import { JupiterClient } from './jupiter-client.js';
import type { SolanaAdapterConfig, JupiterQuoteResponse } from './types.js';
import {
  SOL_MINT,
  USDC_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
  LAMPORTS_PER_SOL,
  DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  MAX_CONFIRMATION_RETRIES,
  CONFIRMATION_RETRY_DELAY_MS,
} from './constants.js';

const logger = new Logger('SolanaAdapter');

export class SolanaAdapter implements ChainAdapter {
  readonly chain = 'SOLANA' as const;

  private connection: Connection;
  private keypair: Keypair;
  private jupiterClient: JupiterClient;
  private priorityFeeMicroLamports: number;
  private confirmationCommitment: 'processed' | 'confirmed' | 'finalized';

  constructor(config: SolanaAdapterConfig) {
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.confirmationCommitment ?? 'confirmed',
    });

    // Decode private key from base58
    const secretKey = bs58.decode(config.privateKeyBase58);
    this.keypair = Keypair.fromSecretKey(secretKey);

    this.jupiterClient = new JupiterClient(config.jupiterApiBase, config.jupiterApiKey);
    this.priorityFeeMicroLamports =
      config.priorityFeeMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS;
    this.confirmationCommitment = config.confirmationCommitment ?? 'confirmed';

    logger.info('Solana adapter initialized', {
      publicKey: this.keypair.publicKey.toBase58(),
      rpcUrl: config.rpcUrl.replace(/\/\/.*@/, '//*****@'), // Redact credentials
    });
  }

  /**
   * Get wallet address
   */
  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /**
   * Get current balances
   */
  async getBalances(): Promise<BalanceInfo> {
    try {
      // Get native SOL balance
      const solBalance = await this.connection.getBalance(this.keypair.publicKey);
      const solAmount = parseTokenAmount(solBalance, SOL_DECIMALS);

      // Get USDC balance
      let usdcAmount = 0;
      try {
        const usdcAta = await getAssociatedTokenAddress(USDC_MINT, this.keypair.publicKey);
        const usdcAccount = await getAccount(this.connection, usdcAta);
        usdcAmount = parseTokenAmount(usdcAccount.amount, USDC_DECIMALS);
      } catch (err) {
        if (!(err instanceof TokenAccountNotFoundError)) {
          throw err;
        }
        // USDC account doesn't exist yet, balance is 0
      }

      logger.debug('Fetched balances', {
        sol: solAmount,
        usdc: usdcAmount,
      });

      return {
        base: solAmount,
        quote: usdcAmount,
        baseDecimals: SOL_DECIMALS,
        quoteDecimals: USDC_DECIMALS,
        nativeForGas: solAmount,
      };
    } catch (err) {
      throw new RpcError(`Failed to fetch balances: ${(err as Error).message}`);
    }
  }

  /**
   * Get executable quote from Jupiter
   */
  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    const { side, amount, amountIsBase, slippageBps, allowedSources, excludedSources } = params;

    // Determine input/output mints based on side
    const inputMint = side === 'BUY' ? USDC_MINT : SOL_MINT;
    const outputMint = side === 'BUY' ? SOL_MINT : USDC_MINT;
    const inputDecimals = side === 'BUY' ? USDC_DECIMALS : SOL_DECIMALS;

    // Convert amount to raw units
    let rawAmount: string;
    if (amountIsBase) {
      // Amount is in SOL
      if (side === 'BUY') {
        // We want to buy X SOL - use ExactOut mode
        rawAmount = toRawAmount(amount, SOL_DECIMALS).toString();
      } else {
        // We want to sell X SOL
        rawAmount = toRawAmount(amount, SOL_DECIMALS).toString();
      }
    } else {
      // Amount is in USDC
      rawAmount = toRawAmount(amount, USDC_DECIMALS).toString();
    }

    try {
      const quoteResponse = await this.jupiterClient.getQuote({
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount: rawAmount,
        slippageBps,
        swapMode: amountIsBase && side === 'BUY' ? 'ExactOut' : 'ExactIn',
        dexes: allowedSources && allowedSources.length > 0 ? allowedSources : undefined,
        excludeDexes: excludedSources && excludedSources.length > 0 ? excludedSources : undefined,
      });

      // Parse amounts
      const inputAmount = parseTokenAmount(
        BigInt(quoteResponse.inAmount),
        side === 'BUY' ? USDC_DECIMALS : SOL_DECIMALS
      );
      const outputAmount = parseTokenAmount(
        BigInt(quoteResponse.outAmount),
        side === 'BUY' ? SOL_DECIMALS : USDC_DECIMALS
      );

      // Calculate price (USDC per SOL)
      const price =
        side === 'BUY'
          ? inputAmount / outputAmount // USDC spent / SOL received
          : outputAmount / inputAmount; // USDC received / SOL sold

      // Parse price impact
      const priceImpactBps = Math.round(parseFloat(quoteResponse.priceImpactPct) * 100);

      // Build route info
      const routeInfo = this.buildRouteInfo(quoteResponse);

      return {
        inputMint: quoteResponse.inputMint,
        outputMint: quoteResponse.outputMint,
        inputAmount,
        outputAmount,
        price,
        priceImpactBps: isNaN(priceImpactBps) ? null : priceImpactBps,
        route: routeInfo,
        expiresAt: Date.now() + 30_000, // Quote valid for ~30 seconds
        rawQuote: quoteResponse,
      };
    } catch (err) {
      if (err instanceof QuoteError) throw err;
      throw new QuoteError(`Failed to get quote: ${(err as Error).message}`);
    }
  }

  /**
   * Execute a swap
   */
  async executeSwap(params: SwapParams): Promise<SwapResult> {
    const { quote, clientOrderId, priorityFeeMicroLamports } = params;
    const jupiterQuote = quote.rawQuote as JupiterQuoteResponse;

    logger.info('Executing swap', {
      clientOrderId,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputAmount: quote.inputAmount,
      expectedOutput: quote.outputAmount,
    });

    // Get pre-swap balances for accurate fill calculation
    const preBalances = await this.getBalances();

    try {
      // Get swap transaction from Jupiter
      const swapResponse = await this.jupiterClient.getSwapTransaction({
        userPublicKey: this.keypair.publicKey.toBase58(),
        quoteResponse: jupiterQuote,
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
        computeUnitPriceMicroLamports:
          priorityFeeMicroLamports ?? this.priorityFeeMicroLamports,
        dynamicComputeUnitLimit: true,
      });

      // Deserialize and sign transaction
      const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      // Sign with our keypair
      transaction.sign([this.keypair]);

      // Get blockhash info for confirmation
      const latestBlockhash = await this.connection.getLatestBlockhash(this.confirmationCommitment);

      // Simulate transaction first
      logger.debug('Simulating transaction');
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: 'processed',
      });

      if (simulation.value.err) {
        throw new TransactionError(
          `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
          undefined,
          true,
          { simulationError: simulation.value.err, logs: simulation.value.logs }
        );
      }

      // Send transaction
      logger.info('Sending transaction');
      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true, // Already simulated
        maxRetries: 3,
        preflightCommitment: 'processed',
      });

      logger.info('Transaction sent', { signature });

      // Confirm transaction with retries
      const confirmed = await this.confirmTransaction(
        signature,
        latestBlockhash.blockhash,
        latestBlockhash.lastValidBlockHeight
      );

      if (!confirmed.success) {
        throw new TransactionError(
          `Transaction failed to confirm: ${confirmed.error}`,
          signature,
          true
        );
      }

      // Get post-swap balances
      await sleep(1000); // Brief delay for balance propagation
      const postBalances = await this.getBalances();

      // Calculate actual fill amounts from balance changes
      const baseDelta = Math.abs(postBalances.base - preBalances.base);
      const quoteDelta = Math.abs(postBalances.quote - preBalances.quote);

      // Determine actual amounts based on trade direction
      const isBuy = quote.inputMint === USDC_MINT.toBase58();
      const actualInputAmount = isBuy ? quoteDelta : baseDelta;
      const actualOutputAmount = isBuy ? baseDelta : quoteDelta;

      // Calculate executed price
      const executedPrice = isBuy
        ? actualInputAmount / actualOutputAmount // USDC/SOL for buy
        : actualOutputAmount / actualInputAmount; // USDC/SOL for sell

      // Calculate actual slippage
      const expectedPrice = quote.price;
      const slippageBps = Math.round(
        Math.abs((executedPrice - expectedPrice) / expectedPrice) * 10000
      );

      // Estimate fee (from transaction meta)
      const feeNative = parseTokenAmount(swapResponse.prioritizationFeeLamports + 5000, SOL_DECIMALS);
      const feeNativeUsdc = feeNative * executedPrice;

      logger.info('Swap executed successfully', {
        signature,
        inputAmount: actualInputAmount,
        outputAmount: actualOutputAmount,
        executedPrice,
        slippageBps,
      });

      return {
        success: true,
        txSignature: signature,
        slot: BigInt(confirmed.slot ?? 0),
        inputAmount: actualInputAmount,
        outputAmount: actualOutputAmount,
        executedPrice,
        feeNative,
        feeNativeUsdc,
        actualSlippageBps: slippageBps,
      };
    } catch (err) {
      logger.error('Swap failed', { error: (err as Error).message, clientOrderId });

      if (err instanceof TransactionError) throw err;

      const errorMessage = (err as Error).message;
      const isRetryable =
        errorMessage.includes('blockhash') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('rate limit');

      return {
        success: false,
        txSignature: '',
        inputAmount: 0,
        outputAmount: 0,
        executedPrice: 0,
        feeNative: 0,
        feeNativeUsdc: 0,
        actualSlippageBps: null,
        error: {
          code: 'SWAP_FAILED',
          message: errorMessage,
          retryable: isRetryable,
        },
      };
    }
  }

  /**
   * Confirm transaction with retries
   */
  private async confirmTransaction(
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number
  ): Promise<{ success: boolean; slot?: number; error?: string }> {
    const strategy: TransactionConfirmationStrategy = {
      signature,
      blockhash,
      lastValidBlockHeight,
    };

    try {
      const result = await this.connection.confirmTransaction(
        strategy,
        this.confirmationCommitment
      );

      if (result.value.err) {
        return {
          success: false,
          error: JSON.stringify(result.value.err),
        };
      }

      return {
        success: true,
        slot: result.context.slot,
      };
    } catch (err) {
      // Check if transaction landed anyway
      for (let i = 0; i < MAX_CONFIRMATION_RETRIES; i++) {
        await sleep(CONFIRMATION_RETRY_DELAY_MS);

        try {
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === this.confirmationCommitment) {
            return { success: true, slot: status.context.slot };
          }
          if (status.value?.err) {
            return { success: false, error: JSON.stringify(status.value.err) };
          }
        } catch {
          // Continue retrying
        }
      }

      return {
        success: false,
        error: `Confirmation timeout: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Check connectivity
   */
  async checkConnectivity(): Promise<ConnectivityStatus> {
    const errors: string[] = [];
    let rpcConnected = false;
    let apiConnected = false;
    let blockHeight: number = 0;

    const start = Date.now();

    // Check RPC
    try {
      const slot = await this.connection.getSlot();
      blockHeight = slot;
      rpcConnected = true;
    } catch (err) {
      errors.push(`RPC error: ${(err as Error).message}`);
    }

    // Check Jupiter API
    const jupiterHealth = await this.jupiterClient.checkHealth();
    apiConnected = jupiterHealth.connected;
    if (!apiConnected) {
      errors.push('Jupiter API not responding');
    }

    const latencyMs = Date.now() - start;

    return {
      rpcConnected,
      apiConnected,
      latencyMs,
      blockHeight,
      errors,
    };
  }

  /**
   * Get current slot
   */
  async getCurrentBlock(): Promise<number> {
    return this.connection.getSlot();
  }

  /**
   * Ensure USDC token account exists
   */
  async ensureUsdcTokenAccount(): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(USDC_MINT, this.keypair.publicKey);

    try {
      await getAccount(this.connection, ata);
      return ata;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        // Create the ATA
        logger.info('Creating USDC token account');

        const instruction = createAssociatedTokenAccountInstruction(
          this.keypair.publicKey,
          ata,
          this.keypair.publicKey,
          USDC_MINT
        );

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const message = new TransactionMessage({
          payerKey: this.keypair.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [instruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([this.keypair]);

        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        await this.connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        });

        logger.info('USDC token account created', { ata: ata.toBase58(), signature });
        return ata;
      }
      throw err;
    }
  }

  /**
   * Build route info from Jupiter response
   */
  private buildRouteInfo(quote: JupiterQuoteResponse): RouteInfo {
    const sources = [...new Set(quote.routePlan.map((r) => r.swapInfo.label))];
    const hops = quote.routePlan.length;

    return {
      sources,
      hops,
      description: sources.join(' -> '),
    };
  }
}
