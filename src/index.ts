import { Connection, ConnectionConfig, PublicKey } from '@solana/web3.js';
import { PumpFunListener } from './listeners/pumpfun-listener';
import { WalletManager } from './helpers/wallet';
import { TOKEN_MONITORING } from './helpers/constants';
import { TelegramService } from './services/telegram-service';
import { MomentumTracker } from './services/momentum-tracker';
import { BotConfig, TokenMetrics, QualifiedTokenMetrics } from './types';
import { logger, logSystemEvent, logSystemError, logTradeExecution } from './helpers/logger';
import dotenv from 'dotenv';

dotenv.config();

// Bot configuration
const botConfig: BotConfig = {
  rpcEndpoint: process.env.HELIUS_RPC_URL!,
  wsEndpoint: process.env.HELIUS_WSS_URL!,
  programId: process.env.PUMPFUN_PROGRAM_ID!,
  commitment: 'confirmed',
  defaultSlippage: parseFloat(process.env.DEFAULT_SLIPPAGE || '1'),
  maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '3'),
  defaultPriorityFee: parseFloat(process.env.PRIORITY_FEE || '0.003'),
  maxPriorityFee: parseFloat(process.env.MAX_PRIORITY_FEE || '0.01'),
  buyAmount: parseFloat(process.env.BUY_AMOUNT || '0.1'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
  retryDelay: parseInt(process.env.RETRY_DELAY || '1000'),
  stopLossPercentage: parseFloat(process.env.STOP_LOSS || '10'),
  takeProfitPercentage: parseFloat(process.env.TAKE_PROFIT || '20'),
  maxPositionSizeSol: parseFloat(process.env.MAX_POSITION_SIZE || '5'),
  minSolReserves: parseFloat(process.env.MIN_LIQUIDITY_SOL || '1'),
  minMarketCap: parseFloat(process.env.MIN_MARKET_CAP || '0'),
  minVolume24h: parseFloat(process.env.MIN_VOLUME_24H || '0'),
  minTxVelocity: parseFloat(process.env.MIN_TX_VELOCITY || '0'),
  requireLiquidityBurned: process.env.REQUIRE_LIQUIDITY_BURNED === 'true',
  metricsInterval: parseInt(process.env.METRICS_INTERVAL || '30000'),
  logLevel: process.env.LOG_LEVEL || 'info',
  priceCheckInterval: parseInt(process.env.PRICE_CHECK_INTERVAL || '5000'),
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000'),
  autoTradingEnabled: process.env.AUTO_TRADING === 'true',
  autoSell: process.env.AUTO_SELL === 'true',
  buyDelay: parseInt(process.env.BUY_DELAY || '0'),
  sellDelay: parseInt(process.env.SELL_DELAY || '0')
};

async function initializeTelegram(): Promise<TelegramService> {
  logger.info('Initializing Telegram service...');
  
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH || !process.env.TELEGRAM_TARGET_USER) {
      throw new Error('Missing required Telegram environment variables');
  }

  const telegramService = new TelegramService(
      parseInt(process.env.TELEGRAM_API_ID),
      process.env.TELEGRAM_API_HASH,
      process.env.TELEGRAM_TARGET_USER,
      logger,
      process.env.TELEGRAM_SESSION
  );

  await telegramService.initialize();
  logger.info('Telegram service initialized successfully');
  return telegramService;
}

async function initializeBot(telegramService: TelegramService) {
  try {
      logger.info('Initializing bot components...');

      // Initialize connection
      const connectionConfig: ConnectionConfig = {
          commitment: 'confirmed',
          disableRetryOnRateLimit: false,
          confirmTransactionInitialTimeout: 12000,
          wsEndpoint: process.env.HELIUS_WSS_URL
      };

      const connection = new Connection(process.env.HELIUS_RPC_URL!, connectionConfig);
      logger.info('Connected to Solana network');

      // Initialize wallet
      const wallet = WalletManager.createKeypair(process.env.SECRET_KEY!);
      const walletManager = new WalletManager(connection, wallet);
      logger.info('Wallet initialized');

      // Initialize listener
      const listener = new PumpFunListener(
          connection,
          logger,
          botConfig,
          telegramService
      );

      // Set up event handlers
      setupEventHandlers(listener);

      // Start the listener
      await listener.start({
          walletPublicKey: walletManager.getPublicKey(),
          autoSell: botConfig.autoSell,
          monitorMetrics: true
      });

      logSystemEvent('BOT_STARTED', {
          wallet: walletManager.getPublicKey().toBase58()
      });

      // Handle cleanup
      setupCleanupHandlers(listener, telegramService);

      return { listener, telegramService };
  } catch (error) {
      logSystemError(error as Error, {
          context: 'BOT_INITIALIZATION'
      });
      throw error;
  }
}

function setupEventHandlers(listener: PumpFunListener) {
  listener.on('tokenQualified', async (address, metrics) => {
      logSystemEvent('TOKEN_QUALIFIED', {
          token: address.toBase58(),
          metrics: metrics
      });
  });

  listener.on('tokenDiscarded', (address, reason) => {
      logSystemEvent('TOKEN_DISCARDED', {
          token: address.toBase58(),
          reason: reason
      });
  });

  listener.on('trade', (logs) => {
      logSystemEvent('TRADE_DETECTED', { logs });
  });

  listener.on('walletChange', (accountInfo) => {
      logSystemEvent('WALLET_CHANGED', {
          balance: accountInfo.lamports
      });
  });

  listener.on('error', (error) => {
      logSystemError(error, {
          context: 'LISTENER_ERROR'
      });
  });
}

function setupCleanupHandlers(listener: PumpFunListener, telegramService: TelegramService) {
  process.on('SIGINT', async () => {
      logSystemEvent('SHUTDOWN_INITIATED', { reason: 'SIGINT' });
      await Promise.all([
          listener.stop(),
          telegramService.cleanup()
      ]);
      process.exit(0);
  });

  process.on('SIGTERM', async () => {
      logSystemEvent('SHUTDOWN_INITIATED', { reason: 'SIGTERM' });
      await Promise.all([
          listener.stop(),
          telegramService.cleanup()
      ]);
      process.exit(0);
  });
}

async function main() {
  try {
      logger.info('Starting initialization sequence...');
      
      // Validate required environment variables
      if (!process.env.HELIUS_RPC_URL || !process.env.PUMPFUN_PROGRAM_ID || !process.env.SECRET_KEY) {
          throw new Error('Missing required environment variables. Please check your .env file');
      }

      // First, initialize Telegram
      const telegramService = await initializeTelegram();
      
      // Then, initialize the rest of the bot
      await initializeBot(telegramService);

      // Keep the process running
      await new Promise(() => {});

  } catch (error) {
      logSystemError(error as Error, {
          context: 'MAIN_PROCESS'
      });
      process.exit(1);
  }
}

// Run the bot
main().catch((error) => {
  logSystemError(error as Error, {
      context: 'STARTUP'
  });
  process.exit(1);
});