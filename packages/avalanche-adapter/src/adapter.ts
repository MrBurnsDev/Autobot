import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  TransactionResponse,
  TransactionReceipt,
} from 'ethers';

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
  Logger,
  parseTokenAmount,
  toRawAmount,
  retryWithBackoff,
  sleep,
} from '@autobot/core';

import { ParaSwapClient } from './paraswap-client.js';
import type { AvalancheAdapterConfig, ParaSwapPriceResponse } from './types.js';
import {
  WAVAX_ADDRESS,
  USDC_ADDRESS,
  AVAX_DECIMALS,
  USDC_DECIMALS,
  AVALANCHE_CHAIN_ID,
  ERC20_ABI,
  DEFAULT_GAS_LIMIT,
  GAS_BUFFER_PERCENT,
  MAX_FEE_PER_GAS_GWEI,
  MAX_PRIORITY_FEE_GWEI,
  MAX_CONFIRMATION_RETRIES,
  CONFIRMATION_RETRY_DELAY_MS,
  AVAX_ADDRESS,
} from './constants.js';

const logger = new Logger('AvalancheAdapter');

export class AvalancheAdapter implements ChainAdapter {
  readonly chain = 'AVALANCHE' as const;

  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private paraswapClient: ParaSwapClient;
  private maxGasPriceGwei: bigint;
  private usdcContract: Contract;

  constructor(config: AvalancheAdapterConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl, AVALANCHE_CHAIN_ID);

    // Normalize private key (add 0x if missing)
    const privateKey = config.privateKey.startsWith('0x')
      ? config.privateKey
      : `0x${config.privateKey}`;
    this.wallet = new Wallet(privateKey, this.provider);

    this.paraswapClient = new ParaSwapClient(undefined, config.paraswapPartner);
    this.maxGasPriceGwei = config.maxGasPriceGwei ?? MAX_FEE_PER_GAS_GWEI;

    // Initialize USDC contract for balance checks and approvals
    this.usdcContract = new Contract(USDC_ADDRESS, ERC20_ABI, this.wallet);

    logger.info('Avalanche adapter initialized', {
      address: this.wallet.address,
      rpcUrl: config.rpcUrl.replace(/\/\/.*@/, '//*****@'), // Redact credentials
    });
  }

  /**
   * Get wallet address
   */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * Get current balances
   */
  async getBalances(): Promise<BalanceInfo> {
    try {
      // Get native AVAX balance
      const avaxBalance = await this.provider.getBalance(this.wallet.address);
      const avaxAmount = parseFloat(formatUnits(avaxBalance, AVAX_DECIMALS));

      // Get USDC balance
      const balanceOfFn = this.usdcContract.balanceOf as (address: string) => Promise<bigint>;
      const usdcBalance = await balanceOfFn(this.wallet.address);
      const usdcAmount = parseFloat(formatUnits(usdcBalance, USDC_DECIMALS));

      logger.debug('Fetched balances', {
        avax: avaxAmount,
        usdc: usdcAmount,
      });

      return {
        base: avaxAmount,
        quote: usdcAmount,
        baseDecimals: AVAX_DECIMALS,
        quoteDecimals: USDC_DECIMALS,
        nativeForGas: avaxAmount,
      };
    } catch (err) {
      throw new RpcError(`Failed to fetch balances: ${(err as Error).message}`);
    }
  }

  /**
   * Get executable quote from ParaSwap
   */
  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    const { side, amount, amountIsBase, slippageBps, allowedSources, excludedSources } = params;

    // Determine input/output tokens based on side
    // For BUY: spending USDC to get AVAX
    // For SELL: spending AVAX to get USDC
    const srcToken = side === 'BUY' ? USDC_ADDRESS : AVAX_ADDRESS;
    const destToken = side === 'BUY' ? AVAX_ADDRESS : USDC_ADDRESS;
    const srcDecimals = side === 'BUY' ? USDC_DECIMALS : AVAX_DECIMALS;
    const destDecimals = side === 'BUY' ? AVAX_DECIMALS : USDC_DECIMALS;

    // Convert amount to raw units
    let rawAmount: string;
    if (amountIsBase) {
      // Amount is in AVAX
      rawAmount = parseUnits(amount.toString(), AVAX_DECIMALS).toString();
    } else {
      // Amount is in USDC
      rawAmount = parseUnits(amount.toString(), USDC_DECIMALS).toString();
    }

    try {
      const priceResponse = await this.paraswapClient.getPrice({
        srcToken,
        destToken,
        srcDecimals,
        destDecimals,
        amount: rawAmount,
        side: amountIsBase ? 'SELL' : 'SELL', // ParaSwap primarily supports SELL side
        network: AVALANCHE_CHAIN_ID,
        includeDEXS: allowedSources?.join(','),
        excludeDEXS: excludedSources?.join(','),
      });

      const route = priceResponse.priceRoute;

      // Parse amounts
      const inputAmount = parseFloat(formatUnits(route.srcAmount, srcDecimals));
      const outputAmount = parseFloat(formatUnits(route.destAmount, destDecimals));

      // Calculate price (USDC per AVAX)
      const price =
        side === 'BUY'
          ? inputAmount / outputAmount // USDC spent / AVAX received
          : outputAmount / inputAmount; // USDC received / AVAX sold

      // Build route info
      const routeInfo = this.buildRouteInfo(priceResponse);

      // Calculate price impact (rough estimate from USD values)
      let priceImpactBps: number | null = null;
      if (route.srcUSD && route.destUSD) {
        const srcUSD = parseFloat(route.srcUSD);
        const destUSD = parseFloat(route.destUSD);
        if (srcUSD > 0) {
          priceImpactBps = Math.round(((srcUSD - destUSD) / srcUSD) * 10000);
        }
      }

      return {
        inputMint: srcToken,
        outputMint: destToken,
        inputAmount,
        outputAmount,
        price,
        priceImpactBps,
        route: routeInfo,
        expiresAt: Date.now() + 30_000, // Quote valid for ~30 seconds
        rawQuote: priceResponse,
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
    const { quote, clientOrderId, maxFeePerGas } = params;
    const paraswapQuote = quote.rawQuote as ParaSwapPriceResponse;

    logger.info('Executing swap', {
      clientOrderId,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputAmount: quote.inputAmount,
      expectedOutput: quote.outputAmount,
    });

    // Get pre-swap balances
    const preBalances = await this.getBalances();

    try {
      // Check and set approval if needed (only for USDC, not native AVAX)
      if (quote.inputMint === USDC_ADDRESS) {
        await this.ensureApproval(
          USDC_ADDRESS,
          paraswapQuote.priceRoute.tokenTransferProxy,
          BigInt(paraswapQuote.priceRoute.srcAmount)
        );
      }

      // Build swap transaction
      const txRequest = await this.paraswapClient.buildTransaction({
        srcToken: quote.inputMint,
        destToken: quote.outputMint,
        srcAmount: paraswapQuote.priceRoute.srcAmount,
        destAmount: paraswapQuote.priceRoute.destAmount,
        priceRoute: paraswapQuote.priceRoute,
        userAddress: this.wallet.address,
        slippage: 100, // 1% slippage buffer for ParaSwap (they use different scale)
      });

      // Get current gas prices
      const feeData = await this.provider.getFeeData();
      const maxFeeGwei = maxFeePerGas ?? this.maxGasPriceGwei;
      const maxPriorityFeeGwei = MAX_PRIORITY_FEE_GWEI;

      // Estimate gas
      const gasEstimate = await this.provider.estimateGas({
        from: this.wallet.address,
        to: txRequest.to,
        data: txRequest.data,
        value: BigInt(txRequest.value),
      });

      // Add buffer to gas estimate
      const gasLimit = (gasEstimate * BigInt(100 + GAS_BUFFER_PERCENT)) / 100n;

      // Build and send transaction
      const tx = await this.wallet.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: BigInt(txRequest.value),
        gasLimit,
        maxFeePerGas: parseUnits(maxFeeGwei.toString(), 'gwei'),
        maxPriorityFeePerGas: parseUnits(maxPriorityFeeGwei.toString(), 'gwei'),
        chainId: AVALANCHE_CHAIN_ID,
      });

      logger.info('Transaction sent', { hash: tx.hash });

      // Wait for confirmation
      const receipt = await this.waitForConfirmation(tx);

      if (!receipt || receipt.status === 0) {
        throw new TransactionError(
          `Transaction failed: ${tx.hash}`,
          tx.hash,
          false
        );
      }

      // Get post-swap balances
      await sleep(2000); // Brief delay for balance propagation
      const postBalances = await this.getBalances();

      // Calculate actual fill amounts from balance changes
      const baseDelta = Math.abs(postBalances.base - preBalances.base);
      const quoteDelta = Math.abs(postBalances.quote - preBalances.quote);

      // Determine actual amounts based on trade direction
      const isBuy = quote.inputMint === USDC_ADDRESS;
      const actualInputAmount = isBuy ? quoteDelta : baseDelta;
      const actualOutputAmount = isBuy ? baseDelta : quoteDelta;

      // Calculate executed price
      const executedPrice = isBuy
        ? actualInputAmount / actualOutputAmount // USDC/AVAX for buy
        : actualOutputAmount / actualInputAmount; // USDC/AVAX for sell

      // Calculate actual slippage
      const expectedPrice = quote.price;
      const slippageBps = Math.round(
        Math.abs((executedPrice - expectedPrice) / expectedPrice) * 10000
      );

      // Calculate gas fee in native and USD
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.gasPrice ?? 0n;
      const feeNative = parseFloat(formatUnits(gasUsed * effectiveGasPrice, AVAX_DECIMALS));
      const feeNativeUsdc = feeNative * executedPrice; // Rough conversion

      logger.info('Swap executed successfully', {
        hash: tx.hash,
        inputAmount: actualInputAmount,
        outputAmount: actualOutputAmount,
        executedPrice,
        slippageBps,
        gasUsed: gasUsed.toString(),
      });

      return {
        success: true,
        txSignature: tx.hash,
        blockNumber: BigInt(receipt.blockNumber),
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
        errorMessage.includes('nonce') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('underpriced');

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
   * Ensure token approval for spender
   */
  private async ensureApproval(
    tokenAddress: string,
    spenderAddress: string,
    requiredAmount: bigint
  ): Promise<void> {
    const token = new Contract(tokenAddress, ERC20_ABI, this.wallet);

    // Check current allowance
    const allowanceFn = token.allowance as (owner: string, spender: string) => Promise<bigint>;
    const currentAllowance = await allowanceFn(this.wallet.address, spenderAddress);

    if (currentAllowance >= requiredAmount) {
      logger.debug('Sufficient allowance exists', {
        token: tokenAddress,
        spender: spenderAddress,
        current: currentAllowance.toString(),
        required: requiredAmount.toString(),
      });
      return;
    }

    logger.info('Setting token approval', {
      token: tokenAddress,
      spender: spenderAddress,
      amount: requiredAmount.toString(),
    });

    // Approve exact amount (not unlimited)
    const approveFn = token.approve as (spender: string, amount: bigint) => Promise<{ hash: string; wait: () => Promise<{ status: number } | null> }>;
    const approveTx = await approveFn(spenderAddress, requiredAmount);
    const receipt = await approveTx.wait();

    if (!receipt || receipt.status === 0) {
      throw new TransactionError(
        `Approval transaction failed: ${approveTx.hash}`,
        approveTx.hash,
        true
      );
    }

    logger.info('Approval confirmed', { hash: approveTx.hash });
  }

  /**
   * Wait for transaction confirmation with retries
   */
  private async waitForConfirmation(
    tx: TransactionResponse
  ): Promise<TransactionReceipt | null> {
    for (let i = 0; i < MAX_CONFIRMATION_RETRIES; i++) {
      try {
        const receipt = await tx.wait(1);
        return receipt;
      } catch (err) {
        const errorMessage = (err as Error).message;

        // If transaction was replaced or cancelled
        if (errorMessage.includes('replaced') || errorMessage.includes('cancelled')) {
          throw new TransactionError(
            `Transaction replaced or cancelled: ${tx.hash}`,
            tx.hash,
            false
          );
        }

        // Check if transaction exists
        const txReceipt = await this.provider.getTransactionReceipt(tx.hash);
        if (txReceipt) {
          return txReceipt;
        }

        await sleep(CONFIRMATION_RETRY_DELAY_MS);
      }
    }

    throw new TransactionError(
      `Transaction confirmation timeout: ${tx.hash}`,
      tx.hash,
      true
    );
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
      const block = await this.provider.getBlockNumber();
      blockHeight = block;
      rpcConnected = true;
    } catch (err) {
      errors.push(`RPC error: ${(err as Error).message}`);
    }

    // Check ParaSwap API
    const paraswapHealth = await this.paraswapClient.checkHealth();
    apiConnected = paraswapHealth.connected;
    if (!apiConnected) {
      errors.push('ParaSwap API not responding');
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
   * Get current block number
   */
  async getCurrentBlock(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Build route info from ParaSwap response
   */
  private buildRouteInfo(response: ParaSwapPriceResponse): RouteInfo {
    const sources: string[] = [];

    for (const routeStep of response.priceRoute.bestRoute) {
      for (const swap of routeStep.swaps) {
        for (const exchange of swap.swapExchanges) {
          if (!sources.includes(exchange.exchange)) {
            sources.push(exchange.exchange);
          }
        }
      }
    }

    const hops = response.priceRoute.bestRoute.reduce(
      (total, step) => total + step.swaps.length,
      0
    );

    return {
      sources,
      hops,
      description: sources.join(' -> '),
    };
  }
}
