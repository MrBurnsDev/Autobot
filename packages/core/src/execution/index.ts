// Execution cost calculation and net edge gating
export {
  ExecutionCostCalculator,
  formatExecutionCostLog,
  type ExecutionCostConfig,
  type ExecutionCostResult,
} from './cost-calculator.js';

// Market regime classification
export {
  RegimeClassifier,
  formatRegimeLog,
  type MarketRegime,
  type RegimeConfig,
  type HourlyAnalytics,
  type RegimeClassification,
  type RegimeSignal,
  type RegimeRecommendation,
} from './regime-classifier.js';

// Capital tier evaluation
export {
  CapitalTierEvaluator,
  DEFAULT_CAPITAL_TIER_CONFIG,
  DEFAULT_SPLIT_CONFIG,
  type CapitalTierConfig,
  type CapitalTier,
  type ExecutionMode,
  type CapitalTierResult,
  type SplitDecisionConfig,
} from './capital-tier.js';

// Split execution
export {
  SplitExecutor,
  DEFAULT_SPLIT_EXECUTION_CONFIG,
  type SplitExecutionConfig,
  type ChunkResult,
  type SplitExecutionResult,
} from './split-executor.js';

// Scale-out exit management
export {
  ScaleOutManager,
  formatScaleOutLog,
  DEFAULT_SCALE_OUT_CONFIG,
  type ExitMode,
  type ExtensionState,
  type ScaleOutConfig,
  type ExtensionStateData,
  type ScaleOutDecision,
  type ExtensionExitDecision,
  type ScaleOutLevel,
} from './scale-out-manager.js';

// Compounding calculator for dynamic trade sizing
export {
  CompoundingCalculator,
  formatCompoundingLog,
  DEFAULT_COMPOUNDING_CONFIG,
  type CompoundingMode,
  type CompoundingConfig,
  type TradeSizeResult,
} from './compounding-calculator.js';

// Capital allocation and isolation
export {
  CapitalAllocator,
  formatCapitalCheckLog,
  formatWalletGuardrailLog,
  DEFAULT_CAPITAL_ALLOCATOR_CONFIG,
  type BotCapitalState,
  type TradePlan,
  type CapitalCheckResult,
  type WalletGuardrailResult,
  type CapitalAllocatorConfig,
} from './capital-allocator.js';

// Reserve reset manager (3-bucket adaptive strategy)
export {
  ReserveResetManager,
  formatReserveResetLog,
  formatReserveStateLog,
  DEFAULT_RESERVE_RESET_CONFIG,
  type RescueRegimeGate,
  type ChaseRegimeGate,
  type ReserveResetConfig,
  type ReserveState,
  type ReserveResetAction,
  type ReserveResetDecision,
  type ReserveResetContext,
} from './reserve-reset-manager.js';
