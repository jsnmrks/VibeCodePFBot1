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

        this.momentumTracker.on('updateMomentumSignal', (signal: MomentumSignal) => {
            this.dashboardServer?.updateMomentumSignal(signal.tokenAddress, {
                signalStrength: signal.signalStrength,
                timestamp: signal.timestamp,
                metrics: signal.metrics,
                triggers: signal.triggerReason
            });
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