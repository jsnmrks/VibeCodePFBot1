import { Commitment } from '@solana/web3.js';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

// Helper function to get environment variables with validation
const getEnvVar = (key: string, defaultValue?: string): string => {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    logger.error(`Environment variable ${key} is not set`);
    process.exit(1);
  }
  return value;
};

// Helper function to get numeric environment variables
const getNumericEnvVar = (key: string, defaultValue?: number): number => {
  const value = process.env[key];
  if (value === undefined && defaultValue === undefined) {
    logger.error(`Environment variable ${key} is not set`);
    process.exit(1);
  }
  const numValue = Number(value || defaultValue);
  if (isNaN(numValue)) {
    logger.error(`Environment variable ${key} is not a valid number`);
    process.exit(1);
  }
  return numValue;
};

// Network Configuration
export const NETWORK = {
  ENDPOINT: getEnvVar('HELIUS_RPC_URL'),
  WS_ENDPOINT: getEnvVar('HELIUS_WSS_URL'),
  COMMITMENT: getEnvVar('COMMITMENT', 'confirmed') as Commitment
};

// Program IDs and Addresses
export const ADDRESSES = {
  PROGRAM_ID: getEnvVar('PUMPFUN_PROGRAM_ID'),
  SYSTEM_PROGRAM: '11111111111111111111111111111111',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ASSOCIATED_TOKEN_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  EVENT_AUTHORITY: 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'
};

// momentum config 
export const MOMENTUM = {
  MIN_BUY_VOLUME_MULTIPLIER: getNumericEnvVar('MOMENTUM_MIN_BUY_VOLUME_MULT', 2),
  MIN_BUY_SELL_RATIO: getNumericEnvVar('MOMENTUM_MIN_BUY_SELL_RATIO', 2),
  MIN_VELOCITY_MULTIPLIER: getNumericEnvVar('MOMENTUM_MIN_VELOCITY_MULT', 2),
  MIN_PRICE_PERCENT: getNumericEnvVar('MOMENTUM_MIN_PRICE_PERCENT', 0),
};

// Connection Configuration
export const CONNECTION_CONFIG = {
  COMMITMENT: NETWORK.COMMITMENT,
  DISABLE_RETRY_ON_RATE_LIMIT: false,
  CONFIRM_TRANSACTION_INITIAL_TIMEOUT: getNumericEnvVar('CONFIRM_TRANSACTION_TIMEOUT', 120000)
};

// Token Monitoring Thresholds
export const TOKEN_MONITORING = {
  MAX_TOKEN_AGE_MINUTES: getNumericEnvVar('MAX_TOKEN_AGE_MINUTES', 120),
  MIN_BUY_AMOUNT_SOL: getNumericEnvVar('MIN_BUY_AMOUNT_SOL', 0.1),
  MIN_UNIQUE_HOLDERS: getNumericEnvVar('MIN_UNIQUE_HOLDERS', 10),
  MIN_CURVE_PROGRESS_PERCENT: getNumericEnvVar('MIN_CURVE_PROGRESS_PERCENT', 5),
  MAX_CURVE_PROGRESS_PERCENT: getNumericEnvVar('MAX_CURVE_PROGRESS_PERCENT', 95),
  MIN_BUY_TRANSACTIONS: getNumericEnvVar('MIN_BUY_TRANSACTIONS', 3),
  MIN_VOLUME_SOL: getNumericEnvVar('MIN_VOLUME_SOL', 1),
  MONITORING_INTERVAL_MS: getNumericEnvVar('MONITORING_INTERVAL_MS', 10000),
  SIGNIFICANT_TX_THRESHOLD: getNumericEnvVar('SIGNIFICANT_TX_THRESHOLD', 0.5),
  MIN_SOL_LIQUIDITY: getNumericEnvVar('MIN_SOL_LIQUIDITY', 1)
};  

// Trading Parameters
export const TRADING = {
  DEFAULT_SLIPPAGE: getNumericEnvVar('DEFAULT_SLIPPAGE', 10),
  MIN_SOL_BALANCE: getNumericEnvVar('MIN_SOL_BALANCE', 0.05),
  DEFAULT_PRIORITY_FEE: getNumericEnvVar('DEFAULT_PRIORITY_FEE', 0.000001),
  MAX_PRIORITY_FEE: getNumericEnvVar('MAX_PRIORITY_FEE', 0.01),
  BUY_AMOUNT: getNumericEnvVar('BUY_AMOUNT', 0.1),
  MAX_RETRIES: getNumericEnvVar('MAX_RETRIES', 3),
  RETRY_DELAY: getNumericEnvVar('RETRY_DELAY', 1000)
};

// Risk Management
export const RISK = {
  STOP_LOSS_PERCENTAGE: getNumericEnvVar('STOP_LOSS_PERCENTAGE', 10),
  TAKE_PROFIT_PERCENTAGE: getNumericEnvVar('TAKE_PROFIT_PERCENTAGE', 50),
  MAX_POSITION_SIZE_SOL: getNumericEnvVar('MAX_POSITION_SIZE_SOL', 1),
  MIN_LIQUIDITY_SOL: getNumericEnvVar('MIN_LIQUIDITY_SOL', 1),
  MAX_SLIPPAGE_PERCENTAGE: getNumericEnvVar('MAX_SLIPPAGE_PERCENTAGE', 15)
};

// Token Analysis Parameters
export const ANALYSIS = {
  MIN_MARKET_CAP: getNumericEnvVar('MIN_MARKET_CAP', 5000),
  MIN_VOLUME_24H: getNumericEnvVar('MIN_VOLUME_24H', 5),
  MIN_TX_VELOCITY: getNumericEnvVar('MIN_TX_VELOCITY', 1),
  REQUIRE_MINT_REVOKED: getEnvVar('REQUIRE_MINT_REVOKED', 'true') === 'true',
  REQUIRE_FREEZE_REVOKED: getEnvVar('REQUIRE_FREEZE_REVOKED', 'true') === 'true',
  REQUIRE_LIQUIDITY_BURNED: getEnvVar('REQUIRE_LIQUIDITY_BURNED', 'true') === 'true'
};

// Monitoring Configuration
export const MONITORING = {
  METRICS_INTERVAL: getNumericEnvVar('METRICS_INTERVAL', 5000),
  LOG_LEVEL: getEnvVar('LOG_LEVEL', 'info'),
  PRICE_CHECK_INTERVAL: getNumericEnvVar('PRICE_CHECK_INTERVAL', 1000),
  HEALTH_CHECK_INTERVAL: getNumericEnvVar('HEALTH_CHECK_INTERVAL', 30000)
};

// Auto Trading Configuration
export const AUTO_TRADING = {
  ENABLED: getEnvVar('AUTO_TRADING_ENABLED', 'false') === 'true',
  AUTO_SELL: getEnvVar('AUTO_SELL', 'false') === 'true',
  BUY_DELAY: getNumericEnvVar('AUTO_BUY_DELAY', 0),
  SELL_DELAY: getNumericEnvVar('AUTO_SELL_DELAY', 0)
};

// Bonding Curve Constants
export const BONDING_CURVE = {
  SEEDS: {
    GLOBAL: Buffer.from('global'),
    BONDING_CURVE: Buffer.from('bonding-curve'),
    MINT_AUTHORITY: Buffer.from('mint-authority')
  },
  STATUS: {
    ACTIVE: 1,
    COMPLETED: 2
  }
};

// Instruction Discriminators
export const DISCRIMINATORS = {
  CREATE: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),
  BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173])
};

// Instruction Log Strings
export const LOG_STRINGS = {
  CREATE: 'Program log: Instruction: Create',
  BUY: 'Program log: Instruction: Buy',
  SELL: 'Program log: Instruction: Sell'
};

// Error Messages
export const ERRORS = {
  INSUFFICIENT_BALANCE: 'Insufficient SOL balance',
  INVALID_SLIPPAGE: 'Invalid slippage percentage',
  EXCESSIVE_SLIPPAGE: 'Slippage exceeds maximum allowed',
  CONNECTION_FAILED: 'Failed to connect to network',
  TRANSACTION_FAILED: 'Transaction failed',
  INVALID_TOKEN: 'Invalid token address',
  RPC_ERROR: 'RPC node error',
  TIMEOUT: 'Transaction timeout'
};
