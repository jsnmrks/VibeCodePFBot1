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