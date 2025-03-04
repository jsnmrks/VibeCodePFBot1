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
        this.stats.momentumTokens.set(tokenAddress, {
            address: tokenAddress,
            ...data,
            metrics: data.metrics
        });
        
        this.io.emit('momentumSignal', {
            tokenAddress,
            ...data
        });
        
        // Emit updated stats to refresh the table
        this.io.emit('statsUpdate', this.getFormattedStats());
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
