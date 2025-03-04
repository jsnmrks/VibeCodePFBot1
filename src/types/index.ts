import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// Bonding Curve Types
export interface BondingCurveState {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  tokenTotalSupply: bigint;
  complete: boolean;
  curveProgressPercent: number;
  creationTimestamp: number;
}

// Add a new interface for token monitoring metrics
export interface TokenMonitoringMetrics {
  uniqueHolders: number;
  buyTransactions: {
    count: number;
    qualifyingCount: number;  // Transactions meeting MIN_BUY_AMOUNT_SOL
    timestamps: number[];
  };
  volumeSol: number;
  ageMinutes: number;
  lastUpdated: number;
}

// Price and Trading Types
export interface PriceImpact {
  currentPrice: number;
  newPrice: number;
  priceImpact: number;
  expectedSlippage: number;
}

export interface TradeParams {
  amount: number;
  slippage: number;
  priorityFee: number;
  maxRetries: number;
}

export type TradeType = 'BUY' | 'SELL';

export interface TradeResult {
  success: boolean;
  signature?: string;
  error?: string;
  price: number;
  amount: number;
  actualSlippage: number;
  timestamp: string;
}

// Metrics Types
export interface TokenMetrics {
  timestamp: string;
  price: number;
  marketCap: number;
  volume24h: number;
  txVelocity: number;
  bondingCurveProgress: number;
  virtualLiquidity: number;
  realLiquidity: number;
  liquidityUtilization: number;
  liquidityDepth: number;
}

export interface MetricsSnapshot {
  metrics: TokenMetrics;
  timestamp: number;
}

// Configuration Types
export interface BotConfig {
  // Network settings
  rpcEndpoint: string;
  wsEndpoint: string;
  programId: string;
  commitment: string;

  // Trading parameters
  defaultSlippage: number;
  maxSlippage: number;
  defaultPriorityFee: number;
  maxPriorityFee: number;
  buyAmount: number;
  maxRetries: number;
  retryDelay: number;

  // Risk management
  stopLossPercentage: number;
  takeProfitPercentage: number;
  maxPositionSizeSol: number;
  minSolReserves: number;

  // Analysis settings
  minMarketCap: number;
  minVolume24h: number;
  minTxVelocity: number;
  requireLiquidityBurned: boolean;

  // Monitoring
  metricsInterval: number;
  logLevel: string;
  priceCheckInterval: number;
  healthCheckInterval: number;

  // Auto trading
  autoTradingEnabled: boolean;
  autoSell: boolean;
  buyDelay: number;
  sellDelay: number;
}

export interface QualifiedTokenMetrics {
   address: PublicKey;
   metrics: TokenMetrics;
}

export interface TokenSecurity {
  isLiquidityBurned: boolean;
  hasValidMetadata: boolean;
}

// Event Types
export interface TokenCreatedEvent {
  address: string;
  timestamp: string;
  creator: string;
  initialState: BondingCurveState;
}

export interface TradeEvent {
  type: TradeType;
  tokenAddress: string;
  trader: string;
  amount: number;
  price: number;
  timestamp: string;
  signature: string;
}

// Listener Types
export interface ListenerConfig {
  walletPublicKey: PublicKey;
  autoSell: boolean;
  monitorMetrics: boolean;
}

export interface ProgramSubscription {
  id: number;
  type: 'logs' | 'account' | 'signature';
  address: string;
}

// Bot Instance Types
export interface BotInstance {
  connection: Connection;
  wallet: Keypair;
  config: BotConfig;
  subscriptions: ProgramSubscription[];
}

// Position Management Types
export interface TokenPosition {
  tokenAddress: string;
  amount: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercentage: number;
  realizedPnl: number;
  realizedPnlPercentage: number;
  trades: TradeResult[];
}

export interface PositionUpdate {
  type: 'ENTRY' | 'EXIT' | 'PRICE_UPDATE';
  position: TokenPosition;
  timestamp: string;
}

// Error Types
export interface TradeError extends Error {
  type: 'SLIPPAGE' | 'LIQUIDITY' | 'NETWORK' | 'TRANSACTION' | 'UNKNOWN';
  details?: Record<string, unknown>;
}

export interface ValidationError extends Error {
  field: string;
  value: unknown;
  constraint: string;
}

// Utility Types
export type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
