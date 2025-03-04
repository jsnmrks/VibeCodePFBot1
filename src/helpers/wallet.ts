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
  