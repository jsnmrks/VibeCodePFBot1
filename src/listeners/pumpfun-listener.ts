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