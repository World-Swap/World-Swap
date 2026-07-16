// server/config.js — central config from environment
import pg from 'pg';

export const config = {
  port: process.env.PORT || 8080,
  databaseUrl: process.env.DATABASE_URL,          // Neon connection string

  // TEST_MODE=true  -> settlement is mocked in the DB; no wallet/contract needed.
  // TEST_MODE=false -> real on-chain USDC settlement via SwapEscrow + watcher.
  testMode: String(process.env.TEST_MODE || 'true').toLowerCase() === 'true',

  chain: {
    name: process.env.CHAIN_NAME || 'base-sepolia',
    rpcUrl: process.env.RPC_URL,
    usdc: process.env.USDC_ADDRESS,
    escrow: process.env.ESCROW_ADDRESS,
    feeRecipient: process.env.FEE_RECIPIENT,
    arbiter: process.env.ARBITER_ADDRESS,
    explorer: process.env.EXPLORER_URL || 'https://sepolia.basescan.org',
    // Sent to every browser, so this must NEVER be the private RPC. If RPC_URL
    // is ever an Alchemy/Infura URL it has a key in it — publishing that would
    // hand out your quota. Keep this a public endpoint, always.
    publicRpc: process.env.PUBLIC_RPC_URL || 'https://sepolia.base.org',
    confirmations: Number(process.env.CONFIRMATIONS || 2),
  },

  feeBps: 50,                                      // 0.5%
};

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

export const q = (text, params) => pool.query(text, params);
