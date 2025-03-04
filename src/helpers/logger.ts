import pino from 'pino';
import { PublicKey } from '@solana/web3.js';

// Define custom types for our logging contexts
interface TokenContext {
  tokenAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  bondingCurveAddress?: string;
}

interface TradeContext {
  signature?: string;
  amount?: number;
  price?: number;
  slippage?: number;
  type?: 'BUY' | 'SELL';
  priorityFee?: number;
}

interface MetricsContext {
  virtualTokenReserves?: number;
  virtualSolReserves?: number;
  realTokenReserves?: number;
  realSolReserves?: number;
  marketCap?: number;
  txVelocity?: number;
  volume24h?: number;
}

// Create the logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: [
    'wallet.privateKey',
    'config.privateKey',
    'signature',
    '*.privateKey',
    '*.secret',
    '*.password',
    'config.rpcEndpoint',    
    'config.wsEndpoint',     
  ],
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
      minimumLevel: 'info', // Add this
      messageFormat: '{msg} {context}', // Add this for cleaner output
      hideObject: false // Show objects only when necessary
    },
  }
});

// Token-related logging functions
export const logTokenCreation = (context: TokenContext) => {
  logger.info({ event: 'TOKEN_CREATED', ...context }, 'New token created');
};

export const logTokenAnalysis = (context: TokenContext & MetricsContext) => {
  logger.info({ event: 'TOKEN_ANALYZED', ...context }, 'Token analysis completed');
};

// Trade-related logging functions
export const logTradeExecution = (context: TradeContext & TokenContext) => {
  logger.info({ event: 'TRADE_EXECUTED', ...context }, `${context.type} trade executed`);
};

export const logTradeError = (error: Error, context: TradeContext & TokenContext) => {
  logger.error(
    { 
      event: 'TRADE_ERROR',
      error: error.message,
      stack: error.stack,
      ...context 
    },
    'Trade execution failed'
  );
};

// Metrics logging functions
export const logMetricsUpdate = (context: MetricsContext & TokenContext) => {
  logger.info({ event: 'METRICS_UPDATE', ...context }, 'Metrics updated');
};

// System logging functions
export const logSystemEvent = (event: string, details: Record<string, unknown>) => {
  logger.info({ event: 'SYSTEM_EVENT', eventType: event, ...details }, event);
};

export const logSystemError = (error: Error, context: Record<string, unknown> = {}) => {
  logger.error(
    {
      event: 'SYSTEM_ERROR',
      error: error.message,
      stack: error.stack,
      ...context
    },
    'System error occurred'
  );
};

// Bonding curve specific logging
export const logBondingCurveUpdate = (
  tokenAddress: PublicKey,
  context: {
    virtualTokenReserves: number;
    virtualSolReserves: number;
    realTokenReserves: number;
    realSolReserves: number;
    currentPrice: number;
    priceChange: number;
  }
) => {
  logger.info(
    {
      event: 'BONDING_CURVE_UPDATE',
      tokenAddress: tokenAddress.toString(),
      ...context
    },
    'Bonding curve state updated'
  );
};

// Wallet logging
export const logWalletEvent = (
  event: 'BALANCE_CHANGE' | 'TRANSACTION_SIGNED' | 'TRANSACTION_CONFIRMED',
  context: Record<string, unknown>
) => {
  logger.info(
    {
      event: `WALLET_${event}`,
      ...context
    },
    `Wallet ${event.toLowerCase()}`
  );
};
