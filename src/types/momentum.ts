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