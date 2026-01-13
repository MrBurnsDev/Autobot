// Avalanche C-Chain addresses

// Native AVAX (represented as zero address in EVM)
export const AVAX_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Wrapped AVAX (WAVAX) on Avalanche C-Chain
export const WAVAX_ADDRESS = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';

// USDC on Avalanche C-Chain (native USDC, not bridged)
export const USDC_ADDRESS = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

// Bridged USDC.e (older, bridged from Ethereum)
export const USDC_E_ADDRESS = '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664';

// Token decimals
export const AVAX_DECIMALS = 18;
export const USDC_DECIMALS = 6;

// Chain ID
export const AVALANCHE_CHAIN_ID = 43114;

// RPC endpoints
export const AVALANCHE_RPC_URL = 'https://api.avax.network/ext/bc/C/rpc';

// Trader Joe V2.1 Router (LBRouter)
export const TRADER_JOE_LB_ROUTER = '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30';

// Trader Joe V2 Factory
export const TRADER_JOE_LB_FACTORY = '0x8e42f2F4101563bF679975178e880FD87d3eFd4e';

// ParaSwap API endpoints
export const PARASWAP_API_URL = 'https://apiv5.paraswap.io';
export const PARASWAP_PARTNER = 'autobot';

// LI.FI API endpoints (alternative aggregator)
export const LIFI_API_URL = 'https://li.quest/v1';

// Transaction settings
export const DEFAULT_GAS_LIMIT = 500_000n;
export const GAS_BUFFER_PERCENT = 20; // Add 20% buffer to estimated gas
export const MAX_FEE_PER_GAS_GWEI = 100n;
export const MAX_PRIORITY_FEE_GWEI = 2n;

// Confirmation settings
export const MAX_CONFIRMATION_RETRIES = 30;
export const CONFIRMATION_RETRY_DELAY_MS = 2000;
export const TRANSACTION_TIMEOUT_MS = 120_000;

// Popular DEXes on Avalanche (for source selection)
export const AVALANCHE_DEX_NAMES = [
  'TraderJoe',
  'TraderJoeV2',
  'TraderJoeV2.1',
  'Pangolin',
  'SushiSwap',
  'Curve',
  'Platypus',
  'GMX',
  'KyberSwap',
  'WooFi',
  'Balancer',
] as const;

export type AvalancheDexName = (typeof AVALANCHE_DEX_NAMES)[number];

// ERC20 ABI (minimal for approve and balanceOf)
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// Trader Joe LB Router ABI (minimal for swaps)
export const TRADER_JOE_LB_ROUTER_ABI = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, tuple(uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256 amountOut)',
  'function swapExactTokensForAVAX(uint256 amountIn, uint256 amountOutMinAVAX, tuple(uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256 amountOut)',
  'function swapExactAVAXForTokens(uint256 amountOutMin, tuple(uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) payable returns (uint256 amountOut)',
  'function getSwapIn(address lbPair, uint128 amountOut, bool swapForY) view returns (uint128 amountIn, uint128 amountOutLeft, uint128 fee)',
  'function getSwapOut(address lbPair, uint128 amountIn, bool swapForY) view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)',
];

// Trader Joe LB Factory ABI
export const TRADER_JOE_LB_FACTORY_ABI = [
  'function getLBPairInformation(address tokenA, address tokenB, uint256 binStep) view returns (address lbPair, uint256 binStep, uint256 createdByOwner, uint256 ignored)',
  'function getAllLBPairs(address tokenA, address tokenB) view returns (tuple(uint256 binStep, address LBPair, bool createdByOwner, bool ignoredForRouting)[])',
];
