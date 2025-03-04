// src/services/momentum-tracker.ts

import { Logger } from 'pino';
import { Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { TelegramService } from './telegram-service';
import { MOMENTUM } from '../helpers';
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
        minBuyVolume: 3,           // 1 SOL minimum volume in tracking window
        minUniqueWallets: 5,       // At least 5 unique buyers
        maxPriceDropPercent: 99,   // No more than 15% drop from peak
        minBuyVelocity: 1,       // At least 1 buy per 2 seconds
        minTimeInSeconds: 3       // Must track for at least 30 seconds
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

        const timeAliveSeconds = (Date.now() - data.created) / 1000;
        const GRACE_PERIOD = 5; // 5 second grade period before disqualification checks

        // Check disqualification criteria
        const checks = timeAliveSeconds > GRACE_PERIOD ? [
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
        ]: [];

        const failedChecks = checks.filter(check => !check.condition);

        if (failedChecks.length > 0) {
            if (timeAliveSeconds > GRACE_PERIOD) { 
                data.qualificationStatus = TokenQualificationStatus.DISQUALIFIED;
                this.emit('tokenDisqualified', tokenAddress, failedChecks.map(c => c.reason));
            }
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
            this.emit('updateMomentumSignal', signal);

            // Notify via Telegram if configured
            if (this.telegramService && !data.notifiedTelegram) {
                this.telegramService.sendMintAddress(tokenAddress)
                    .catch(err => this.logger.error('Failed to send Telegram notification:', err));
                data.notifiedTelegram = true;
            }
        }
    }

    private shouldEmitMomentumSignal(metrics: MomentumMetrics): boolean {
        const result = (
            metrics.buyVolume > MOMENTUM.MIN_BUY_VOLUME_MULTIPLIER * this.criteria.minBuyVolume &&
            metrics.buySellRatio > MOMENTUM.MIN_BUY_SELL_RATIO &&
            metrics.velocityTrend > MOMENTUM.MIN_VELOCITY_MULTIPLIER * this.criteria.minBuyVelocity &&
            metrics.pricePercent > MOMENTUM.MIN_PRICE_PERCENT
        );
        console.log('Momentum check:', {metrics, thresholds: {
            buyVolume: MOMENTUM.MIN_BUY_VOLUME_MULTIPLIER * this.criteria.minBuyVolume,
            ratio: MOMENTUM.MIN_BUY_SELL_RATIO,
            velocity: MOMENTUM.MIN_VELOCITY_MULTIPLIER * this.criteria.minBuyVelocity,
            price: MOMENTUM.MIN_PRICE_PERCENT
        }, result});
        return result;
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