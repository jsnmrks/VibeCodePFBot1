Project Path: src

Source Tree:

```
src
├── listeners
│   ├── index.ts
│   └── pumpfun-listener.ts
├── index.ts
├── helpers
│   ├── logger.ts
│   ├── wallet.ts
│   ├── index.ts
│   ├── constants.ts
│   └── metrics.ts
├── services
│   ├── tracker.ts
│   ├── telegram-service.ts
│   └── momentum-tracker.ts
├── types
│   ├── index.ts
│   └── momentum.ts
└── dashboard
    ├── server.ts
    └── public
        └── index.html

```

`/home/jason/ClaudeBot2/src/listeners/index.ts`:

```ts
export * from './pumpfun-listener';
```

`/home/jason/ClaudeBot2/src/listeners/pumpfun-listener.ts`:

```ts
import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { Logger } from 'pino';
import { BotConfig, ListenerConfig } from '../types';
import { TokenTracker } from '../services/tracker';
import { LOG_STRINGS } from '../helpers/constants';
import { TelegramService } from '../services/telegram-service';
import { userInfo } from 'os';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

interface CreateEventData {
    name: string;
    symbol: string;
    uri: string;
    mint: PublicKey;
    bondingCurve: PublicKey;
    user: PublicKey;
    associatedBondingCurve: PublicKey;
}

export class PumpFunListener extends EventEmitter {
    private programLogsSubscription: number | null = null;
    private tokenTracker: TokenTracker;
    private isRunning: boolean = false;

    constructor(
        private readonly connection: Connection,
        private readonly logger: Logger,
        private readonly config: BotConfig,
        private readonly telegramService: TelegramService,
    ) {
        super();
        this.tokenTracker = new TokenTracker(connection, logger, this.config.programId, telegramService);
    }

    private async findAssociatedBondingCurve(mint: PublicKey, bondingCurve: PublicKey): Promise<PublicKey> {
        const [associatedBondingCurve] = await PublicKey.findProgramAddress(
            [
                bondingCurve.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                mint.toBuffer(),
            ],
            ATA_PROGRAM_ID
        );
        return associatedBondingCurve;
    }

    private async parseCreateEvent(logs: string[]): Promise<CreateEventData | null> {
        try {
            const createLog = logs.find(log => log === LOG_STRINGS.CREATE);
            if (!createLog) return null;

            const dataLog = logs.find(log => log.includes('Program data:'));
            if (!dataLog) return null;

            const encodedData = dataLog.split('Program data: ')[1].trim();
            const data = Buffer.from(encodedData, 'base64');

            let offset = 8; // Skip discriminator
            const view = new DataView(data.buffer, data.byteOffset);

            const readString = (): string => {
                const length = view.getUint32(offset, true);
                offset += 4;
                const value = data.slice(offset, offset + length).toString('utf8');
                offset += length;
                return value;
            };

            const readPubkey = (): PublicKey => {
                const value = new PublicKey(data.slice(offset, offset + 32));
                offset += 32;
                return value;
            };

            const name = readString();
            const symbol = readString();
            const uri = readString();
            const mint = readPubkey();
            const bondingCurve = readPubkey();
            const user = readPubkey();

            const associatedBondingCurve = await this.findAssociatedBondingCurve(mint, bondingCurve);

            return {
                name,
                symbol,
                uri,
                mint,
                bondingCurve,
                user,
                associatedBondingCurve
            };

        } catch (error) {
            this.logger.error({
                event: 'CREATE_EVENT_PARSE_ERROR',
                error: error instanceof Error ? error.message : 'Unknown error',
                logs
            });
            return null;
        }
    }
    
    private async parseBuyOrSellInstruction(logs: string[]): Promise<{
        mint: string,
        solAmount: bigint,
        tokenAmount: bigint,
        virtualSolReserves: bigint,
        virtualTokenReserves: bigint,
        realSolReserves: bigint,
        realTokenReserves: bigint
    } | null> {
        const dataLog = logs.find(log => log.includes('Program data:'));
        if (!dataLog) return null;
    
        const encodedData = dataLog.split('Program data: ')[1].trim();
        const data = Buffer.from(encodedData, 'base64');
        
        // Skip discriminator
        const mintPubkey = new PublicKey(data.slice(8, 40));
        const solAmount = data.readBigUInt64LE(40);
        const tokenAmount = data.readBigUInt64LE(48);
        const isBuy = data[56];
        const user = new PublicKey(data.slice(57, 89));
        const timestamp = data.readBigInt64LE(89);
        const virtualSolReserves = data.readBigUInt64LE(97);
        const virtualTokenReserves = data.readBigUInt64LE(105);
        const realSolReserves = data.readBigUInt64LE(113);
        const realTokenReserves = data.readBigUInt64LE(121);
    
        return {
            mint: mintPubkey.toBase58(),
            solAmount,
            tokenAmount,
            virtualSolReserves,
            virtualTokenReserves,
            realSolReserves,
            realTokenReserves
        };
    }

    public async start(config: ListenerConfig) {
        if (this.isRunning) {
            this.logger.warn('Listener already running');
            return;
        }

        try {
            this.logger.info('Starting PumpFun listener...');

            this.programLogsSubscription = this.connection.onLogs(
                new PublicKey(this.config.programId),
                async (logs: Logs) => {
                    if (!logs.logs?.length || logs.err) return;
            
                    try {
                        const instructionType = this.parseInstructionType(logs.logs);
                        switch (instructionType) {
                            case 'CREATE': {
                                const eventData = await this.parseCreateEvent(logs.logs);
                                if (eventData) {
                                    await this.tokenTracker.trackNewToken(
                                        eventData.mint,
                                        eventData.bondingCurve,
                                        eventData.associatedBondingCurve
                                    );
                                }
                                break;
                            }
                            case 'BUY':
                            case 'SELL': {
                                const txData = await this.parseBuyOrSellInstruction(logs.logs);
                                if (txData) {
                                    await this.tokenTracker.processTransaction(
                                        txData.mint,
                                        logs.signature,
                                        instructionType,
                                        {
                                            ...txData,
                                            timestamp: Date.now()
                                        },
                                        userInfo.toString()
                                    );
                                }
                                break;
                            }
                        }
                    } catch (error) {
                        this.logger.error({
                            event: 'LOG_PROCESSING_ERROR',
                            error: error instanceof Error ? error.message : 'Unknown error',
                            signature: logs.signature
                        });
                    }
                },
                'confirmed'
            );

            this.isRunning = true;
            this.logger.info('PumpFun listener started successfully');

        } catch (error) {
            this.logger.error('Error starting PumpFun listener:', error);
            await this.stop();
            throw error;
        }
    }

    private parseInstructionType(logs: string[]): 'CREATE' | 'BUY' | 'SELL' | null {
        if (logs.find(log => log === LOG_STRINGS.CREATE)) return 'CREATE';
        if (logs.find(log => log === LOG_STRINGS.BUY)) return 'BUY';
        if (logs.find(log => log === LOG_STRINGS.SELL)) return 'SELL';
        return null;
    }

    public async stop() {
        if (!this.isRunning) return;
        
        try {
            if (this.programLogsSubscription !== null) {
                await this.connection.removeOnLogsListener(this.programLogsSubscription);
                this.programLogsSubscription = null;
            }
            
            await this.tokenTracker.cleanup();
            this.isRunning = false;
            this.logger.info('PumpFun listener stopped successfully');
        } catch (error) {
            this.logger.error('Error stopping PumpFun listener:', error);
            throw error;
        }
    }
}
```

`/home/jason/ClaudeBot2/src/index.ts`:

```ts
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
```

`/home/jason/ClaudeBot2/src/helpers/logger.ts`:

```ts
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

```

`/home/jason/ClaudeBot2/src/helpers/wallet.ts`:

```ts
import { 
    Connection, 
    Keypair, 
    LAMPORTS_PER_SOL, 
    PublicKey, 
    Transaction,
    VersionedTransaction,
    TransactionMessage,
    ComputeBudgetProgram
  } from '@solana/web3.js';
  import { mnemonicToSeedSync } from 'bip39';
  import { derivePath } from 'ed25519-hd-key';
  import bs58 from 'bs58';
  import { logger, logWalletEvent } from './logger';
  import { TRADING } from './constants';
  
  export class WalletManager {
    constructor(
      private readonly connection: Connection,
      private keypair: Keypair
    ) {}
  
    /**
     * Get wallet balance in SOL
     */
    public async getBalance(): Promise<number> {
      try {
        const balance = await this.connection.getBalance(this.keypair.publicKey);
        return balance / LAMPORTS_PER_SOL;
      } catch (error) {
        logger.error('Error getting wallet balance:', error);
        throw error;
      }
    }
  
    /**
     * Check if wallet has sufficient SOL for a trade
     */
    public async hasSufficientBalance(amount: number, priorityFee: number): Promise<boolean> {
      const balance = await this.getBalance();
      const requiredBalance = amount + priorityFee + TRADING.MIN_SOL_BALANCE;
      return balance >= requiredBalance;
    }
  
    /**
     * Add compute unit limit and priority fee to a transaction
     */
    private addPriorityFee(
      transaction: Transaction | VersionedTransaction,
      priorityFee: number,
      computeUnits: number = 200_000
    ): Transaction | VersionedTransaction {
      const microLamports = Math.floor(priorityFee * LAMPORTS_PER_SOL * 1000000);
      
      const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports
      });
      
      const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits
      });
  
      if (transaction instanceof VersionedTransaction) {
        const message = TransactionMessage.decompile(transaction.message);
        message.instructions.unshift(priorityFeeIx, computeUnitLimitIx);
        return new VersionedTransaction(message.compileToLegacyMessage());
      } else {
        transaction.instructions.unshift(priorityFeeIx, computeUnitLimitIx);
        return transaction;
      }
    }
  
    /**
     * Sign and send a transaction
     */
    public async signAndSendTransaction(
      transaction: Transaction | VersionedTransaction,
      priorityFee?: number
    ): Promise<string> {
      try {
        if (priorityFee) {
          transaction = this.addPriorityFee(transaction, priorityFee);
        }
  
        if (transaction instanceof VersionedTransaction) {
          transaction.sign([this.keypair]);
        } else {
          transaction.partialSign(this.keypair);
        }
  
        const signature = await this.connection.sendRawTransaction(
          transaction.serialize(),
          { skipPreflight: true }
        );
  
        logWalletEvent('TRANSACTION_SIGNED', {
          signature,
          priorityFee
        });
  
        return signature;
      } catch (error) {
        logger.error('Error signing and sending transaction:', error);
        throw error;
      }
    }
  
    /**
     * Wait for transaction confirmation
     */
    public async confirmTransaction(signature: string, maxRetries = 3): Promise<boolean> {
      let retries = 0;
      while (retries < maxRetries) {
        try {
          const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
          
          if (confirmation.value.err) {
            logger.error('Transaction failed:', confirmation.value.err);
            return false;
          }
  
          logWalletEvent('TRANSACTION_CONFIRMED', { signature });
          return true;
        } catch (error) {
          logger.warn(`Confirmation attempt ${retries + 1} failed:`, error);
          retries++;
          if (retries === maxRetries) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
      }
      return false;
    }
  
    /**
     * Create a Keypair from various input formats
     */
    public static createKeypair(input: string): Keypair {
      try {
        // Check if input is a JSON array (secret key)
        if (input.startsWith('[')) {
          return Keypair.fromSecretKey(new Uint8Array(JSON.parse(input)));
        }
  
        // Check if input is a mnemonic phrase
        if (input.includes(' ')) {
          const seed = mnemonicToSeedSync(input, '');
          const path = `m/44'/501'/0'/0'`;
          return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
        }
  
        // Assume input is base58 encoded private key
        return Keypair.fromSecretKey(bs58.decode(input));
      } catch (error) {
        logger.error('Error creating keypair:', error);
        throw new Error('Invalid wallet input format');
      }
    }
  
    /**
     * Get the public key
     */
    public getPublicKey(): PublicKey {
      return this.keypair.publicKey;
    }
  
    /**
     * Update the keypair
     */
    public updateKeypair(newKeypair: Keypair) {
      this.keypair = newKeypair;
      logger.info('Wallet keypair updated');
    }
  
    /**
     * Get token account for a specific mint
     */
    public async getTokenAccount(mint: PublicKey): Promise<PublicKey | null> {
      try {
        const tokenAccounts = await this.connection.getTokenAccountsByOwner(
          this.keypair.publicKey,
          { mint }
        );
  
        if (tokenAccounts.value.length === 0) {
          return null;
        }
  
        return tokenAccounts.value[0].pubkey;
      } catch (error) {
        logger.error('Error getting token account:', error);
        throw error;
      }
    }
  }
  
```

`/home/jason/ClaudeBot2/src/helpers/index.ts`:

```ts
export * from './logger';
export * from './constants';
export * from './wallet';

```

`/home/jason/ClaudeBot2/src/helpers/constants.ts`:

```ts
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

```

`/home/jason/ClaudeBot2/src/services/tracker.ts`:

```ts
import { Connection, PublicKey, AccountInfo, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Logger } from 'pino';
import { EventEmitter } from 'events';
import { DashboardServer } from '../dashboard/server';
import { TOKEN_MONITORING } from '../helpers';
import { MomentumTracker } from './momentum-tracker';
import { TelegramService } from './telegram-service';
import { MomentumSignal, TokenQualificationStatus } from '../types/momentum';
import { token } from '@coral-xyz/anchor/dist/cjs/utils';

interface TrackedToken {
    address: PublicKey;
    bondingCurveAddress: PublicKey;
    associatedBondingCurveAddress: PublicKey;
    createdAt: Date;
    lastUpdate: Date;
    buyCount: number;
    sellCount: number;
    state: BondingCurveState;
    qualified: boolean;
}

interface DisqualificationStats {
    [reason: string]: number;
}

interface BondingCurveState {
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    curveProgress: number;
    price: number
}

export class TokenTracker extends EventEmitter {
    private readonly minCurveProgress = TOKEN_MONITORING.MIN_CURVE_PROGRESS_PERCENT;
    private readonly maxCurveProgress = TOKEN_MONITORING.MAX_CURVE_PROGRESS_PERCENT;
    private readonly minBuyAmountSol = TOKEN_MONITORING.MIN_BUY_AMOUNT_SOL;
    private readonly trackedTokens: Map<string, TrackedToken> = new Map();
    private readonly accountSubscriptionBatch: Map<string, PublicKey[]> = new Map();
    private readonly MAX_ACCOUNTS_PER_SUBSCRIPTION = 100;
    private momentumTracker: MomentumTracker;
    private batchSubscriptionId: number | null = null;
    private disqualificationStats: DisqualificationStats = {
        'Insufficient buy transactions in first minute': 0,
        'Outside of bonding curve progress range': 0,
        // Add other reasons as needed
    };

    private dashboardServer?: DashboardServer;
    private stats = {
        tokensTracking: 0,
        tokensQualified: 0,
        tokensDisqualified: 0
    };

    constructor(
        private readonly connection: Connection,
        private readonly logger: Logger,
        private readonly programId: string,
        private readonly telegramService: TelegramService,
        dashboardPort: number = 3000
    ) {
        super();
        this.initializeDashboard(dashboardPort);
        // Initialize momentum tracker
        this.momentumTracker = new MomentumTracker(connection, logger, telegramService); 
        this.setupMomentumTracking();
        /*
        this.momentumTracker.on('buySignal', (data) => {
            this.logger.info('Received buy signal:', data);
            this.handleMomentumSignal(data);
        });
        */
    }

    private initializeDashboard(port: number) {
        this.dashboardServer = new DashboardServer(port);
        this.dashboardServer.start();
        this.updateDashboardStats();
    }

    private setupMomentumTracking(): void {
        // Listen for momentum signals
        this.momentumTracker.on('momentumSignal', (signal: MomentumSignal) => {
            this.handleMomentumSignal(signal);
        });
    
        // Listen for metrics updates
        this.momentumTracker.on('metricsUpdated', (tokenAddress: string, data: any) => {
            this.dashboardServer?.updateMomentumMetrics(tokenAddress, {
                ...data.metrics,
                status: data.status,
                timestamp: data.timestamp
            });
        });
    
        // Listen for disqualification
        this.momentumTracker.on('tokenDisqualified', (tokenAddress: string, reasons: string[]) => {
            const token = this.trackedTokens.get(tokenAddress);
            if (!token) return;

            this.logger.info({
                event: 'TOKEN_MOMENTUM_DISQUALIFIED',
                tokenAddress,
                reasons
            });
    
            // Update dashboard
            this.dashboardServer?.updateMonitoredToken(tokenAddress, {
                buyTransactions: token.buyCount || 0,
                sellTransactions: token.sellCount || 0,
                curveProgress: token.state.curveProgress || 0,
                status: 'disqualified',
                reason: reasons.join(', ')
            });
        });
    }
    
    private handleMomentumSignal(signal: MomentumSignal): void {
        this.logger.info({
            event: 'MOMENTUM_SIGNAL_DETECTED',
            tokenAddress: signal.tokenAddress,
            strength: signal.signalStrength,
            triggers: signal.triggerReason
        });
    
        // Update dashboard with momentum signal
        this.dashboardServer?.updateMomentumSignal(signal.tokenAddress, {
            signalStrength: signal.signalStrength,
            timestamp: signal.timestamp,
            metrics: signal.metrics,
            triggers: signal.triggerReason
        });
    
        // Emit event for other components
        this.emit('momentumSignal', signal);
    }

    private parseBondingCurveState(accountInfo: AccountInfo<Buffer>): BondingCurveState {
        const dataStart = 8; // Skip discriminator
        const virtualTokenReserves = accountInfo.data.readBigUInt64LE(dataStart);
        const virtualSolReserves = accountInfo.data.readBigUInt64LE(dataStart + 8);
        const realTokenReserves = accountInfo.data.readBigUInt64LE(dataStart + 16);
        const realSolReserves = accountInfo.data.readBigUInt64LE(dataStart + 24);
        const tokenTotalSupply = accountInfo.data.readBigUInt64LE(dataStart + 32);
        
        // Calculate price in SOL per token
        const price = Number(virtualSolReserves) / LAMPORTS_PER_SOL / (Number(virtualTokenReserves) / 10 ** 6);

        // Calculate curve progress with proper token decimals
        // const currentTokenBalance = tokenTotalSupply - realTokenReserves;
        // const reservedTokens = BigInt(0);
        const curveProgress = (Number(realSolReserves) / Number(virtualSolReserves)) * 100;

        return {
            virtualTokenReserves,
            virtualSolReserves,
            realTokenReserves,
            realSolReserves,
            tokenTotalSupply,
            curveProgress,
            price
        };
    }

    private updateDashboard(tokenKey: string, token: TrackedToken) {
        this.dashboardServer?.updateMonitoredToken(tokenKey, {
            buyTransactions: token.buyCount,
            sellTransactions: token.sellCount,
            curveProgress: token.state.curveProgress,
            status: token.qualified ? 'qualified' : 'monitoring',
        });
    }

    public async trackNewToken(
        tokenAddress: PublicKey,
        bondingCurveAddress: PublicKey,
        associatedBondingCurveAddress: PublicKey
    ): Promise<void> {
        const tokenKey = tokenAddress.toBase58();

        if (this.trackedTokens.has(tokenKey)) {
            this.logger.info({
                event: 'TOKEN_ALREADY_TRACKED',
                token: tokenKey
            });
            return;
        }

        try {
            // Get initial state
            const accountInfo = await this.connection.getAccountInfo(bondingCurveAddress);
            if (!accountInfo) {
                throw new Error('Failed to get initial bonding curve state');
            }

            const state = this.parseBondingCurveState(accountInfo);

            // Create token tracking object
            const token: TrackedToken = {
                address: tokenAddress,
                bondingCurveAddress,
                associatedBondingCurveAddress,
                createdAt: new Date(),
                lastUpdate: new Date(),
                buyCount: 0,
                sellCount: 0,
                state,
                qualified: false,
            };

            this.trackedTokens.set(tokenKey, token);
            this.stats.tokensTracking = this.trackedTokens.size;

            // Update dashboard with initial state
            this.updateDashboard(tokenKey, token);
            this.updateDashboardStats();

            await this.subscribeToAccountBatch();

            // diqualify token if <10 buys in 1 min
            setTimeout(() => {
                const token = this.trackedTokens.get(tokenKey);
                if (token && token.buyCount < 10) {
                    this.disqualifyToken(
                        tokenKey,
                        token,
                        `Insufficient buy transactions (${token.buyCount}/10) in first minute`
                    );
                }
            }, 60 * 1000); // 1 minute

            this.logger.info({
                event: 'TOKEN_TRACKING_STARTED',
                token: tokenKey,
                initialState: {
                    ...state,
                    virtualSolReserves: Number(state.virtualSolReserves) / LAMPORTS_PER_SOL,
                    realSolReserves: Number(state.realSolReserves) / LAMPORTS_PER_SOL
                }
            });

        } catch (error) {
            this.logger.error({
                event: 'TRACK_NEW_TOKEN_ERROR',
                token: tokenKey,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            throw error;
        }
    }
    
    private async subscribeToAccountBatch() {
        if (this.batchSubscriptionId) {
            await this.connection.removeProgramAccountChangeListener(this.batchSubscriptionId);
            this.batchSubscriptionId = null;
        }
    
        const accounts = Array.from(this.trackedTokens.values())
            .map(token => token.bondingCurveAddress);
    
        if (accounts.length === 0) return;
    
        // Create a map to lookup tokens by their bonding curve address
        const bondingCurveToToken = new Map(
            Array.from(this.trackedTokens.values())
                .map(token => [token.bondingCurveAddress.toBase58(), token])
        );
    
        this.batchSubscriptionId = this.connection.onProgramAccountChange(
            new PublicKey(this.programId),
            async (keyedAccountInfo) => {
                const bondingCurveKey = keyedAccountInfo.accountId.toBase58();
        
                const token = bondingCurveToToken.get(bondingCurveKey);
                if (!token) return;
    
                try {
                    const newState = this.parseBondingCurveState(keyedAccountInfo.accountInfo);
                    const curveProgress = newState.curveProgress;
            
                    if (curveProgress < this.minCurveProgress || curveProgress > this.maxCurveProgress) {
                        this.disqualifyToken(
                            token.address.toBase58(),  // Use token address as key, not bonding curve address
                            token,
                            'Outside of bonding curve progress range'
                        );
                        return;
                    }
    
                    token.state = newState;
                    token.lastUpdate = new Date();
                    this.updateDashboard(token.address.toBase58(), token);
                } catch (error) {
                    this.handleSubscriptionError(error);
                }
            },
            'confirmed'
        );
    }

    public async processTransaction(
        tokenAddress: string,
        signature: string,
        type: 'BUY' | 'SELL',
        txData: {
            solAmount: bigint,
            tokenAmount: bigint,
            timestamp: number,
            virtualSolReserves: bigint,
            virtualTokenReserves: bigint,
            realSolReserves: bigint,
            realTokenReserves: bigint,
        },
        sender: string
    ): Promise<void> {
        const token = this.trackedTokens.get(tokenAddress);
        if (!token) return;
    
        // Convert amounts from lamports/raw to SOL/tokens
        const solAmount = Number(txData.solAmount) / LAMPORTS_PER_SOL;
        const tokenAmount = Number(txData.tokenAmount) / 1_000_000; // Assuming 6 decimals
    
        // Calculate price from virtual reserves
        const price = Number(txData.virtualSolReserves) / Number(txData.virtualTokenReserves);

        // Use passed sender address instead of making RPC call
        this.momentumTracker.addTrade(
            tokenAddress,
            price,
            type.toLowerCase() as 'buy' | 'sell',
            solAmount,
            tokenAmount,
            sender  // Use the passed sender address
        );

        // Add this part for momentum tracking:
        this.momentumTracker.addTrade(
            tokenAddress,
            price,
            type.toLowerCase() as 'buy' | 'sell',
            solAmount,
            tokenAmount
        );
    
        if (type === 'BUY') {
            token.buyCount++;
            this.momentumTracker.addTrade(
                tokenAddress,
                price,
                'buy',
                solAmount
            );
        } else {
            token.sellCount++;
            this.momentumTracker.addTrade(
                tokenAddress,
                price,
                'sell',
                solAmount
            );
        }
    
        // Update token state
        token.state = {
            virtualTokenReserves: txData.virtualTokenReserves,
            virtualSolReserves: txData.virtualSolReserves,
            realTokenReserves: txData.realTokenReserves,
            realSolReserves: txData.realSolReserves,
            tokenTotalSupply: token.state.tokenTotalSupply,
            curveProgress: (Number(txData.realSolReserves) / Number(txData.virtualSolReserves)) * 100,
            price
        };
    
        token.lastUpdate = new Date();
        this.updateDashboard(tokenAddress, token);
    
        this.logger.info({
            event: 'TRANSACTION_PROCESSED',
            tokenAddress,
            type,
            metrics: {
                solAmount,
                tokenAmount,
                price,
                curveProgress: token.state.curveProgress
            }
        });
    }

    private handleSubscriptionError(error: any) {
        if (error.message?.includes('429')) {
            // Implement exponential backoff
            setTimeout(() => this.subscribeToAccountBatch(), 5000);
        }
        this.logger.error({
            event: 'SUBSCRIPTION_ERROR',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }

    private cleanupTokenData(tokenKey: string, token: TrackedToken) {
        try {
            // Store necessary data before cleanup
            const bondingCurveKey = token.bondingCurveAddress.toBase58();
            const curveProgress = token.state.curveProgress;

            // Log cleanup initiation
            this.logger.debug({
                event: 'TOKEN_CLEANUP_STARTED',
                tokenKey,
                bondingCurveKey,
            });

            // Remove from tracked tokens map first
            this.trackedTokens.delete(tokenKey);

            // Update tracking stats
            this.stats.tokensTracking = this.trackedTokens.size;

            // Now it's safe to clear references since we've stored what we need
            token.state = null!;
            token.address = null!;
            token.bondingCurveAddress = null!;
            token.associatedBondingCurveAddress = null!;

            // Log completion
            this.logger.debug({
                event: 'TOKEN_CLEANUP_COMPLETED',
                tokenKey,
                remainingTokens: this.trackedTokens.size
            });

            return { bondingCurveKey, curveProgress };
        } catch (error) {
            this.logger.error({
                event: 'TOKEN_CLEANUP_ERROR',
                tokenKey,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            return null;
        }
    }

    private disqualifyToken(
        tokenKey: string, 
        token: TrackedToken,
        reason: string
    ) {
        // Store necessary values before cleanup
        const buyCount = token.buyCount;
        const sellCount = token.sellCount;
        const curveProgress = token.state.curveProgress;
        
        // Clean up token data first and get stored values
        const cleanupData = this.cleanupTokenData(tokenKey, token);
        if (!cleanupData) return;  // Exit if cleanup failed
        
        // Map the reason to a standardized category
        let standardReason = reason;
        if (reason.includes('outside allowed range')) {
            standardReason = 'Outside of bonding curve progress range';
        } else if (reason.includes('Insufficient buy transactions')) {
            standardReason = 'Insufficient buy transactions in first minute';
        }

        // Update stats
        this.stats.tokensDisqualified++;
        
        // Update the dashboard using stored values
        this.dashboardServer?.updateMonitoredToken(tokenKey, {
            buyTransactions: buyCount,
            sellTransactions: sellCount,
            curveProgress: curveProgress,
            status: 'disqualified',
            reason: standardReason
        });

        // Log the disqualification
        this.logger.info({
            event: 'TOKEN_DISQUALIFIED',
            tokenKey,
            reason: standardReason,
            currentStats: {
                tokensTracking: this.trackedTokens.size,
                tokensDisqualified: this.stats.tokensDisqualified
            }
        });

        // Emit event
        this.emit('tokenDisqualified', tokenKey, standardReason);
        
        // Update subscription batch
        this.subscribeToAccountBatch();
    }

    public async cleanup(): Promise<void> {
        try {

            this.momentumTracker.cleanup();
            // Clean up all token data
            const tokens = Array.from(this.trackedTokens.entries());
            for (const [tokenKey, token] of tokens) {
                this.cleanupTokenData(tokenKey, token);
            }

            // Remove subscription
            if (this.batchSubscriptionId !== null) {
                await this.connection.removeProgramAccountChangeListener(this.batchSubscriptionId);
                this.batchSubscriptionId = null;
            }
            
            // Clear collections
            this.trackedTokens.clear();
            
            // Reset stats
            this.stats.tokensTracking = 0;
            
            // Stop dashboard
            if (this.dashboardServer) {
                this.dashboardServer.stop();
            }
    
            this.logger.info('TokenTracker cleanup completed');
        } catch (error) {
            this.logger.error({
                event: 'CLEANUP_ERROR',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            throw error;
        }
    }

    private updateDashboardStats() {
        if (this.dashboardServer) {
            this.dashboardServer.updateStats({
                tokensTracking: this.stats.tokensTracking,
                tokensQualified: this.stats.tokensQualified,
                tokensDisqualified: this.stats.tokensDisqualified,
                disqualificationReasons: this.disqualificationStats
            });
        }
    }
}
```

`/home/jason/ClaudeBot2/src/services/telegram-service.ts`:

```ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger } from 'pino';
import { createInterface } from 'readline';
import dotenv from 'dotenv';

dotenv.config();

export class TelegramService {
    private client: TelegramClient;
    private isConnected: boolean = false;
    private readonly session: StringSession;
    private readonly rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });

    constructor(
        private readonly apiId: number,
        private readonly apiHash: string,
        private readonly targetUserId: string,
        private readonly logger: Logger,
        sessionString?: string
    ) {
        this.session = new StringSession(sessionString || '');
        this.client = new TelegramClient(
            this.session, 
            apiId, 
            apiHash, 
            { connectionRetries: 5 }
        );
    }

    private async userInput(prompt: string): Promise<string> {
        return new Promise((resolve) => {
            this.rl.question(prompt, (answer) => {
                resolve(answer);
            });
        });
    }

    public async initialize(): Promise<void> {
        try {
            await this.client.start({
                phoneNumber: async () => this.userInput("Phone number: "),
                password: async () => this.userInput("Password: "),
                phoneCode: async () => this.userInput("Code: "),
                onError: (err) => {
                    this.logger.error("Telegram error:", err);
                    throw err;
                },
            });

            this.isConnected = true;


        // Get and log the session string after successful connection
        const sessionString = this.client.session.save();
        
        // Log with clear formatting
        console.log("\n----------------------------------------");
        console.log("TELEGRAM SESSION STRING (save this to .env):");
        console.log(sessionString);
        console.log("----------------------------------------\n");

/*
            const sessionString = this.client.session.save();
            this.logger.info("Session string:", sessionString);
            this.rl.close();
*/

        } catch (error) {
            this.logger.error("Telegram init failed:", error);
            this.rl.close();
            throw error;
        }
    }

    public async sendMintAddress(mintAddress: string): Promise<void> {
        if (!this.isConnected) return;

        try {
            await this.client.sendMessage(this.targetUserId, { message: mintAddress });
        } catch (error) {
            this.logger.error("Failed to send:", error);
        }
    }

    public async cleanup(): Promise<void> {
        if (this.isConnected) {
            await this.client.disconnect();
            this.isConnected = false;
        }
    }
}
```

`/home/jason/ClaudeBot2/src/services/momentum-tracker.ts`:

```ts
// src/services/momentum-tracker.ts

import { Logger } from 'pino';
import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { TelegramService } from './telegram-service';
import {
    TradeEvent,
    TokenMomentumData,
    MomentumMetrics,
    DisqualificationCriteria,
    TokenQualificationStatus,
    MomentumSignal,
    WindowedMetrics
} from '../types/momentum';

export class MomentumTracker extends EventEmitter {
    private readonly tokens = new Map<string, TokenMomentumData>();
    private readonly windowSize = 6 * 1000; // 60 second window
    private cleanupInterval: NodeJS.Timeout | null = null;

    private readonly criteria: DisqualificationCriteria = {
        minBuyVolume: .1,           // 1 SOL minimum volume
        minUniqueWallets: 1,       // At least 5 unique buyers
        maxPriceDropPercent: 99,   // No more than 15% drop from peak
        minBuyVelocity: 0.1,       // At least 1 buy per 10 seconds
        minTimeInSeconds: 1       // Must track for at least 30 seconds
    };

    constructor(
        private readonly connection: Connection,
        private readonly logger: Logger,
        private readonly telegramService?: TelegramService,
    ) {
        super();
        this.startCleanupInterval();
    }

    private startCleanupInterval(): void {
        // Run cleanup every minute
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldTokens();
        }, 60 * 1000);
    }

    private cleanupOldTokens(): void {
        const now = Date.now();
        const maxAge = 2 * 60 * 60 * 1000; // 2 hours

        for (const [address, data] of this.tokens.entries()) {
            if (now - data.created > maxAge) {
                this.tokens.delete(address);
                this.logger.info({
                    event: 'TOKEN_CLEANUP',
                    address,
                    age: (now - data.created) / 1000,
                    reason: 'MAX_AGE_EXCEEDED'
                });
            }
        }
    }

    public addTrade(
        tokenAddress: string,
        price: number,
        type: 'buy' | 'sell',
        solAmount: number,
        tokenAmount: number = 0,
        wallet: string = 'unknown'
    ): void {
        const event: TradeEvent = {
            timestamp: Date.now(),
            type,
            solAmount,
            tokenAmount,
            wallet,
            price
        };

        this.processTradeEvent(tokenAddress, event);
    }

    private processTradeEvent(tokenAddress: string, event: TradeEvent): void {
        let tokenData = this.tokens.get(tokenAddress);
        
        if (!tokenData) {
            tokenData = this.initializeTokenData(event);
            this.tokens.set(tokenAddress, tokenData);
        }

        // Add new event
        tokenData.events.push(event);
        tokenData.lastPrice = event.price;
        tokenData.highestPrice = Math.max(tokenData.highestPrice, event.price);

        // Update cumulative volumes
        if (event.type === 'buy') {
            tokenData.totalBuyVolume += event.solAmount;
        } else {
            tokenData.totalSellVolume += event.solAmount;
        }

        // Update window
        tokenData.windowEnd = event.timestamp;
        tokenData.windowStart = tokenData.windowEnd - this.windowSize;

        // Calculate metrics and check qualification
        const metrics = this.calculateMetrics(tokenData);
        this.checkQualification(tokenAddress, tokenData, metrics);

        // Emit metrics update for dashboard
        this.emit('metricsUpdated', tokenAddress, {
            metrics,
            status: tokenData.qualificationStatus,
            timestamp: event.timestamp
        });
    }

    private initializeTokenData(event: TradeEvent): TokenMomentumData {
        return {
            events: [],
            windowStart: event.timestamp - this.windowSize,
            windowEnd: event.timestamp,
            created: event.timestamp,
            lastPrice: event.price,
            initialPrice: event.price,
            highestPrice: event.price,
            totalBuyVolume: 0,
            totalSellVolume: 0,
            qualificationStatus: TokenQualificationStatus.MONITORING
        };
    }

    private getWindowedEvents(data: TokenMomentumData): TradeEvent[] {
        return data.events.filter(event => 
            event.timestamp >= data.windowStart && 
            event.timestamp <= data.windowEnd
        );
    }

    private calculateWindowedMetrics(events: TradeEvent[]): WindowedMetrics {
        const buyEvents = events.filter(e => e.type === 'buy');
        const sellEvents = events.filter(e => e.type === 'sell');
        
        const metrics: WindowedMetrics = {
            buyCount: buyEvents.length,
            sellCount: sellEvents.length,
            buyVolume: buyEvents.reduce((sum, e) => sum + e.solAmount, 0),
            sellVolume: sellEvents.reduce((sum, e) => sum + e.solAmount, 0),
            uniqueBuyers: new Set(buyEvents.map(e => e.wallet)),
            uniqueSellers: new Set(sellEvents.map(e => e.wallet)),
            priceRange: {
                start: events[0]?.price ?? 0,
                end: events[events.length - 1]?.price ?? 0,
                high: Math.max(...events.map(e => e.price)),
                low: Math.min(...events.map(e => e.price))
            }
        };

        return metrics;
    }

    private calculateMetrics(data: TokenMomentumData): MomentumMetrics {
        const windowedEvents = this.getWindowedEvents(data);
        const windowedMetrics = this.calculateWindowedMetrics(windowedEvents);
        
        const timeSpanSeconds = (data.windowEnd - data.windowStart) / 1000;
        const velocityTrend = windowedMetrics.buyCount / timeSpanSeconds;
        
        const priceChange = ((data.lastPrice - data.initialPrice) / data.initialPrice) * 100;
        const highestPricePercent = ((data.highestPrice - data.initialPrice) / data.initialPrice) * 100;

        return {
            buyVolume: windowedMetrics.buyVolume,
            sellVolume: windowedMetrics.sellVolume,
            priceImpact: priceChange,
            uniqueBuyers: windowedMetrics.uniqueBuyers.size,
            velocityTrend,
            buySellRatio: windowedMetrics.sellVolume === 0 ? 
                windowedMetrics.buyVolume : 
                windowedMetrics.buyVolume / windowedMetrics.sellVolume,
            pricePercent: priceChange,
            highestPricePercent
        };
    }

    private checkQualification(
        tokenAddress: string, 
        data: TokenMomentumData, 
        metrics: MomentumMetrics
    ): void {
        // Skip if already disqualified
        if (data.qualificationStatus === TokenQualificationStatus.DISQUALIFIED) {
            return;
        }

        const windowedEvents = this.getWindowedEvents(data);
        const timeAliveSeconds = (Date.now() - data.created) / 1000;

        // Check disqualification criteria
        const checks = [
            {
                condition: metrics.buyVolume >= this.criteria.minBuyVolume,
                reason: 'Insufficient buy volume'
            },
            {
                condition: metrics.uniqueBuyers >= this.criteria.minUniqueWallets,
                reason: 'Not enough unique buyers'
            },
            {
                condition: ((data.highestPrice - data.lastPrice) / data.highestPrice) * 100 <= this.criteria.maxPriceDropPercent,
                reason: 'Price dropped too much from peak'
            },
            {
                condition: metrics.velocityTrend >= this.criteria.minBuyVelocity,
                reason: 'Buy velocity too low'
            },
            {
                condition: timeAliveSeconds >= this.criteria.minTimeInSeconds,
                reason: 'Token too new'
            }
        ];

        const failedChecks = checks.filter(check => !check.condition);

        if (failedChecks.length > 0) {
            data.qualificationStatus = TokenQualificationStatus.DISQUALIFIED;
            this.emit('tokenDisqualified', tokenAddress, failedChecks.map(c => c.reason));
            return;
        }

        // Check for strong momentum signal
        if (this.shouldEmitMomentumSignal(metrics)) {
            const signal: MomentumSignal = {
                tokenAddress,
                metrics,
                timestamp: Date.now(),
                signalStrength: this.calculateSignalStrength(metrics),
                triggerReason: this.getSignalTriggers(metrics)
            };

            this.emit('momentumSignal', signal);

            // Notify via Telegram if configured
            if (this.telegramService && !data.notifiedTelegram) {
                this.telegramService.sendMintAddress(tokenAddress)
                    .catch(err => this.logger.error('Failed to send Telegram notification:', err));
                data.notifiedTelegram = true;
            }
        }
    }

    private shouldEmitMomentumSignal(metrics: MomentumMetrics): boolean {
        return (
            metrics.buyVolume > 2 * this.criteria.minBuyVolume &&
            metrics.buySellRatio > 2 &&
            metrics.velocityTrend > 2 * this.criteria.minBuyVelocity &&
            metrics.pricePercent > 0
        );
    }

    private calculateSignalStrength(metrics: MomentumMetrics): number {
        // Calculate a score from 0-100 based on metrics
        const volumeScore = Math.min(metrics.buyVolume / (2 * this.criteria.minBuyVolume), 1) * 25;
        const ratioScore = Math.min(metrics.buySellRatio / 3, 1) * 25;
        const velocityScore = Math.min(metrics.velocityTrend / (3 * this.criteria.minBuyVelocity), 1) * 25;
        const priceScore = Math.min(Math.max(metrics.pricePercent, 0) / 20, 1) * 25;

        return Math.floor(volumeScore + ratioScore + velocityScore + priceScore);
    }

    private getSignalTriggers(metrics: MomentumMetrics): string[] {
        const triggers: string[] = [];

        if (metrics.buyVolume > 3 * this.criteria.minBuyVolume) {
            triggers.push('High buy volume');
        }
        if (metrics.buySellRatio > 3) {
            triggers.push('Strong buy/sell ratio');
        }
        if (metrics.velocityTrend > 3 * this.criteria.minBuyVelocity) {
            triggers.push('Rapid buying');
        }
        if (metrics.pricePercent > 20) {
            triggers.push('Significant price increase');
        }

        return triggers;
    }

    public cleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.tokens.clear();
        this.removeAllListeners();
    }
}
```

`/home/jason/ClaudeBot2/src/types/index.ts`:

```ts
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

```

`/home/jason/ClaudeBot2/src/types/momentum.ts`:

```ts
export interface TradeEvent {
    timestamp: number;          // UNIX timestamp in milliseconds
    type: 'buy' | 'sell';
    solAmount: number;         // Amount in SOL
    tokenAmount: number;       // Amount of tokens
    wallet: string;           // Wallet address that made the trade
    price: number;            // Price in SOL per token
}

export interface TokenMomentumData {
    events: TradeEvent[];
    windowStart: number;       // Start of current window
    windowEnd: number;         // End of current window
    created: number;          // Token creation timestamp
    lastPrice: number;        // Most recent price
    initialPrice: number;     // First recorded price
    highestPrice: number;     // Highest price seen
    totalBuyVolume: number;   // Cumulative buy volume in SOL
    totalSellVolume: number;  // Cumulative sell volume in SOL
    qualificationStatus: TokenQualificationStatus;
    notifiedTelegram?: boolean;
}

export interface MomentumMetrics {
    buyVolume: number;        // Buy volume in current window
    sellVolume: number;       // Sell volume in current window
    priceImpact: number;      // Percentage price change in window
    uniqueBuyers: number;     // Number of unique buying wallets
    velocityTrend: number;    // Rate of change of buy velocity
    buySellRatio: number;     // Ratio of buys to sells
    pricePercent: number;     // Current price as percentage of initial
    highestPricePercent: number; // Highest price as percentage of initial
}

export interface DisqualificationCriteria {
    minBuyVolume: number;        // Minimum buy volume in SOL
    minUniqueWallets: number;    // Minimum unique buyers
    maxPriceDropPercent: number; // Maximum allowed price drop from peak
    minBuyVelocity: number;      // Minimum buys per second
    minTimeInSeconds: number;    // Minimum tracking time before qualification
}

export enum TokenQualificationStatus {
    MONITORING = 'MONITORING',
    QUALIFIED = 'QUALIFIED',
    DISQUALIFIED = 'DISQUALIFIED'
}

export interface MomentumSignal {
    tokenAddress: string;
    metrics: MomentumMetrics;
    timestamp: number;
    signalStrength: number;    // 0-100 score
    triggerReason: string[];   // Reasons why signal was triggered
}

export interface WindowedMetrics {
    buyCount: number;
    sellCount: number;
    buyVolume: number;
    sellVolume: number;
    uniqueBuyers: Set<string>;
    uniqueSellers: Set<string>;
    priceRange: {
        start: number;
        end: number;
        high: number;
        low: number;
    };
}
```

`/home/jason/ClaudeBot2/src/dashboard/server.ts`:

```ts
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { EventEmitter } from 'events';
import { MomentumMetrics, TokenQualificationStatus } from '../types/momentum';

interface DisqualificationStats {
    [reason: string]: number;
}

interface TokenMomentumData {
    address: string;
    metrics: MomentumMetrics;
}

export class DashboardServer extends EventEmitter {
    private app: express.Application;
    private server: any;
    private io: Server;
    private stats = {
        tokensTracking: 0,
        tokensQualified: 0,
        tokensDisqualified: 0,
        momentumTokens: new Map<string, TokenMomentumData>(),
        lastUpdate: new Date().toISOString(),
        monitoredTokens: new Map<string, {
            address: string,
            createdAt: string,
            buyTransactions: number,
            sellTransactions: number,
            curveProgress: number,
            status: 'monitoring' | 'qualified' | 'disqualified'
        }>(),
        disqualificationReasons: {} as DisqualificationStats,
    };
    private momentumMetrics: Map<string, {
        metrics: MomentumMetrics;
        status: TokenQualificationStatus;
        signalStrength?: number;
        triggers?: string[];
        lastUpdate: number;
    }> = new Map();

    // Add cleanup configuration
    private cleanupInterval!: NodeJS.Timeout;

    constructor(private readonly port: number = 3000) {
        super();
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: "http://localhost:3000",
                methods: ["GET", "POST"]
            }
        });

        this.setupExpress();
        this.setupSocketIO();
    }

    // In DashboardServer class (server.ts), add these methods:
    public updateMomentumMetrics(
        tokenAddress: string,
        data: {
            metrics: MomentumMetrics;
            status: TokenQualificationStatus;
            timestamp: number;
        }
    ): void {
        const momentumData = {
            ...data,
            lastUpdate: Date.now()
        };
        
        this.io.emit('momentumUpdate', {
            tokenAddress,
            ...momentumData
        });
    }

    public updateMomentumSignal(
        tokenAddress: string,
        data: {
            signalStrength: number;
            timestamp: number;
            metrics: MomentumMetrics;
            triggers: string[];
        }
    ): void {
        this.io.emit('momentumSignal', {
            tokenAddress,
            ...data
        });
    }

    private setupExpress() {
        // Serve static files from the public directory
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Basic health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        });

        // Add API endpoints for token data
        this.app.get('/api/tokens', (req, res) => {
            res.json({
                monitored: Array.from(this.stats.monitoredTokens.values()),
            });
        });
    }

    private setupSocketIO() {
        this.io.on('connection', (socket) => {
            console.log('Dashboard client connected');
            
            // Send initial stats on connection
            socket.emit('statsUpdate', this.stats);

            socket.on('disconnect', () => {
                console.log('Dashboard client disconnected');
            });
        });
    }

    private getFormattedStats() {
        return {
            tokensTracking: this.stats.tokensTracking,
            tokensQualified: this.stats.tokensQualified,
            tokensDisqualified: this.stats.tokensDisqualified,
            lastUpdate: this.stats.lastUpdate,
            monitoredTokens: Array.from(this.stats.monitoredTokens.values()),
            disqualificationReasons: this.stats.disqualificationReasons,
            momentumTokens: Array.from(this.stats.momentumTokens.values())
        };
    }

    // Method to update stats
    public updateStats(newStats: {
        tokensTracking?: number;
        tokensQualified?: number;
        tokensDisqualified?: number;
        qualifiedTokens?: Map<string, any>;
        disqualificationReasons?: { [reason: string]: number};
    }) {
        // Update primitive values
        if (newStats.tokensTracking !== undefined) this.stats.tokensTracking = newStats.tokensTracking;
        if (newStats.tokensQualified !== undefined) this.stats.tokensQualified = newStats.tokensQualified;
        if (newStats.tokensDisqualified !== undefined) this.stats.tokensDisqualified = newStats.tokensDisqualified;
        
        // Update disqualification reasons
        if (newStats.disqualificationReasons) {
            this.stats.disqualificationReasons = newStats.disqualificationReasons;
        }
    
        this.stats.lastUpdate = new Date().toISOString();
    
        // Emit the updated stats
        this.io.emit('statsUpdate', this.getFormattedStats());
    }

    // Method to add or update a monitored token
    public updateMonitoredToken(
        address: string,
        data: {
            buyTransactions: number;
            sellTransactions: number;
            curveProgress: number;
            status: 'monitoring' | 'qualified' | 'disqualified';
            reason?: string;
        }
     ) {
        if (data.status === 'disqualified') {
            this.stats.monitoredTokens.delete(address);
            // Update reason counter if provided
            if (data.reason) {
                this.stats.disqualificationReasons[data.reason] = 
                    (this.stats.disqualificationReasons[data.reason] || 0) + 1;
            }
        } else {
            this.stats.monitoredTokens.set(address, {
                address,
                createdAt: new Date().toISOString(),
                buyTransactions: data.buyTransactions,
                sellTransactions: data.sellTransactions,
                curveProgress: data.curveProgress,
                status: data.status
            });
        }
     
        this.io.emit('statsUpdate', this.getFormattedStats());
     }
     
    // Start the server
    public start() {
        this.server.listen(this.port, () => {
            console.log(`Dashboard server running at http://localhost:${this.port}`);
        });
    }

    // Stop the server
    public stop() {
        clearInterval(this.cleanupInterval);
        this.server.close();
    }
}

```

`/home/jason/ClaudeBot2/src/dashboard/public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token Tracking Dashboard</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }

        .dashboard {
            max-width: 1200px;
            margin: 0 auto;
        }

        .stats-overview {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-2px);
        }

        .stat-number {
            font-size: 24px;
            font-weight: bold;
            color: #2c3e50;
        }

        .stat-label {
            color: #7f8c8d;
            font-size: 14px;
        }

        .token-sections {
            display: grid;
            grid-template-columns: 1fr;
            gap: 30px;
        }

        .section {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .section-title {
            margin: 0 0 20px 0;
            color: #2c3e50;
            font-size: 18px;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .token-count {
            font-size: 14px;
            color: #7f8c8d;
            background: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
        }

        .token-table {
            width: 100%;
            border-collapse: collapse;
        }

        .token-table th,
        .token-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }

        .token-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
            position: sticky;
            top: 0;
            z-index: 1;
        }

        .token-table tbody tr:hover {
            background: #f8f9fa;
        }

        .token-address {
            font-family: monospace;
            color: #3498db;
            cursor: pointer;
        }

        .token-address:hover {
            text-decoration: underline;
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: #ecf0f1;
            border-radius: 4px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: #2ecc71;
            transition: width 0.3s ease;
        }

        .status-monitoring {
            color: #f39c12;
        }

        .status-qualified {
            color: #2ecc71;
        }

        .timestamp {
            color: #95a5a6;
            font-size: 12px;
        }

        .search-bar {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            margin-bottom: 20px;
            font-size: 14px;
        }

        .search-bar:focus {
            outline: none;
            border-color: #3498db;
        }

        .no-data {
            text-align: center;
            padding: 20px;
            color: #7f8c8d;
            font-style: italic;
        }


        .signal-strength-high {
            color: #2ecc71;
            font-weight: bold;
        }

        .signal-strength-medium {
            color: #f39c12;
            font-weight: bold;
        }

        .signal-strength-low {
            color: #95a5a6;
        }

        .text-center {
            text-align: center;
        }

        .text-green {
            color: #2ecc71;
        }

        .text-red {
            color: #e74c3c;
        }

        .triggers {
            max-width: 200px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: help;
        }

        #momentumTokensTable th {
            white-space: nowrap;
            padding: 12px 8px;
        }

        #momentumTokensTable td {
            padding: 12px 8px;
            vertical-align: middle;
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="stats-overview">
            <div class="stat-card">
                <div class="stat-number" id="tokensTracking">0</div>
                <div class="stat-label">Tokens Tracking</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="tokensQualified">0</div>
                <div class="stat-label">Tokens Qualified</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="tokensDisqualified">0</div>
                <div class="stat-label">Tokens Disqualified</div>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">
                Momentum Signals
                <span class="token-count" id="momentumTokenCount">0 tokens</span>
            </h2>
            <table class="token-table" id="momentumTokensTable">
                <thead>
                    <tr>
                        <th>Token Address</th>
                        <th>Signal Strength</th>
                        <th>Buy Volume</th>
                        <th>Buy/Sell Ratio</th>
                        <th>Velocity</th>
                        <th>Price Impact</th>
                        <th>Buyers</th>
                        <th>Triggers</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>

        <div class="token-sections">
            <div class="section">
                <h2 class="section-title">
                    Monitored Tokens
                    <span class="token-count" id="monitoredTokenCount">0 tokens</span>
                </h2>
                <input type="text" class="search-bar" id="monitoredSearch" placeholder="Search by token address...">
                <table class="token-table" id="monitoredTokensTable">
                    <thead>
                        <tr>
                            <th>Token Address</th>
                            <th>Status</th>
                            <th>Buy Transactions</th>
                            <th>Sell Transactions</th>
                            <th>Curve Progress</th>
                            <th>Created At</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>

            <div class="section">
                <h2 class="section-title">
                    Disqualification Summary
                    <span class="token-count" id="disqualifiedTotal">0 tokens</span>
                </h2>
                <table class="token-table">
                    <thead>
                        <tr>
                            <th>Reason</th>
                            <th>Count</th>
                        </tr>
                    </thead>
                    <tbody id="disqualificationSummary"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let currentStats = {};
        
        // Setup search functionality
        const setupSearch = (inputId, tableId, dataKey) => {
            const input = document.getElementById(inputId);
            input.addEventListener('input', () => {
                const searchTerm = input.value.toLowerCase();
                updateMonitoredTokensTable(searchTerm);
            });
        };

        // Initialize search for monitored tokens
        setupSearch('monitoredSearch', 'monitoredTokensTable', 'monitoredTokens');

        socket.on('statsUpdate', (stats) => {
            console.log('Received stats update:', stats);
            currentStats = stats;
            updateOverviewStats(stats);
            updateMonitoredTokensTable();
            updateDisqualificationSummary(stats);
            updateMomentumTable(stats);
        });

        function updateOverviewStats(stats) {
            document.getElementById('tokensTracking').textContent = stats.tokensTracking;
            document.getElementById('tokensQualified').textContent = stats.tokensQualified;
            document.getElementById('tokensDisqualified').textContent = stats.tokensDisqualified;
            
            const monitoredTokens = Array.from(stats.monitoredTokens.values());
            document.getElementById('monitoredTokenCount').textContent = 
                `${monitoredTokens.length} tokens`;
            document.getElementById('disqualifiedTotal').textContent = 
                `${stats.tokensDisqualified} tokens`;
        }

        function updateMonitoredTokensTable(searchTerm = '') {
            const tbody = document.querySelector('#monitoredTokensTable tbody');
            const tokens = Array.from(currentStats.monitoredTokens.values());
            
            // Filter tokens based on search term
            const filteredTokens = tokens.filter(token => {
                return searchTerm === '' || token.address.toLowerCase().includes(searchTerm);
            });

            // Sort tokens by curve progress
            filteredTokens.sort((a, b) => b.curveProgress - a.curveProgress);

            tbody.innerHTML = '';
            
            if (filteredTokens.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="no-data">No tokens found</td>
                    </tr>
                `;
                return;
            }

            filteredTokens.forEach(token => {
                const row = `
                    <tr>
                        <td class="token-address">${token.address}</td>
                        <td class="status-${token.status.toLowerCase()}">${token.status}</td>
                        <td>${token.buyTransactions}</td>
                        <td>${token.sellTransactions}</td>
                        <td>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${token.curveProgress}%"></div>
                            </div>
                            ${token.curveProgress.toFixed(1)}%
                        </td>
                        <td class="timestamp">${new Date(token.createdAt).toLocaleString()}</td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });

            // Add click handlers for token addresses
            tbody.querySelectorAll('.token-address').forEach(element => {
                element.addEventListener('click', () => {
                    copyToClipboard(element.textContent, element);
                });
            });
        }

        function getSignalStrengthClass(strength) {
            if (strength >= 75) return 'high';
            if (strength >= 50) return 'medium';
            return 'low';
        }

        function formatTriggers(triggers) {
            if (!triggers || triggers.length === 0) return 'None';
            return triggers.join(', ');
        }

        function updateDisqualificationSummary(stats) {
            const summaryTable = document.getElementById('disqualificationSummary');
            summaryTable.innerHTML = '';
            
            Object.entries(stats.disqualificationReasons).forEach(([reason, count]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${reason}</td>
                    <td>${count}</td>
                `;
                summaryTable.appendChild(row);
            });
        }
        
        function updateMomentumTable(stats) {
            const tbody = document.querySelector('#momentumTokensTable tbody');
            const momentumTokens = stats.momentumTokens || [];
            
            document.getElementById('momentumTokenCount').textContent = 
                `${momentumTokens.length} tokens`;
            
            tbody.innerHTML = '';
            
            if (momentumTokens.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="no-data">No momentum signals detected</td>
                    </tr>
                `;
                return;
            }

            momentumTokens.forEach(token => {
                const row = `
                    <tr>
                        <td class="token-address">${token.address}</td>
                        <td class="text-center signal-strength-${getSignalStrengthClass(token.signalStrength)}">
                            ${token.signalStrength}
                        </td>
                        <td class="text-center">${token.metrics.buyVolume.toFixed(2)} SOL</td>
                        <td class="text-center">${token.metrics.buySellRatio.toFixed(2)}x</td>
                        <td class="text-center">${token.metrics.velocityTrend.toFixed(2)}/s</td>
                        <td class="text-center ${token.metrics.priceImpact >= 0 ? 'text-green' : 'text-red'}">
                            ${token.metrics.priceImpact.toFixed(2)}%
                        </td>
                        <td class="text-center">${token.metrics.uniqueBuyers}</td>
                        <td class="text-center triggers" title="${formatTriggers(token.triggers)}">
                            ${formatTriggers(token.triggers)}
                        </td>
                        <td class="text-center timestamp">${new Date(token.timestamp).toLocaleString()}</td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });

            // Add click handlers for token addresses
            tbody.querySelectorAll('.token-address').forEach(element => {
                element.addEventListener('click', () => {
                    copyToClipboard(element.textContent, element);
                });
            });
        }

        function copyToClipboard(text, element) {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            
            try {
                document.execCommand('copy');
                element.textContent = 'Copied!';
                element.style.color = '#27ae60';
                
                setTimeout(() => {
                    element.textContent = text;
                    element.style.color = '#3498db';
                }, 1000);
            } catch (err) {
                console.error('Failed to copy:', err);
                element.textContent = 'Failed to copy';
                element.style.color = '#e74c3c';
            }
            
            document.body.removeChild(textArea);
        }

        // Socket connection status
        socket.on('connect', () => {
            console.log('Connected to dashboard server');
        });

        socket.on('disconnect', () => {
            console.log('Disconnected from dashboard server');
        });

        socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
        });
    </script>
</body>
</html>

```