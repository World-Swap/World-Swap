// server/index.js — Express entry: serves the API and the frontend.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { listings, waitlist } from './listings.js';
import { payments } from './payments.js';
import { auth } from './auth.js';
import { profiles } from './profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);            // Render terminates TLS in front of us
app.use(express.json({ limit: '4mb' }));

// API
app.use('/api/auth',     auth);
app.use('/api/profile',  profiles);
app.use('/api/listings', listings);
app.use('/api/orders',   payments);
app.use('/api/waitlist', waitlist);
app.get('/api/config', (_req, res) => res.json({
  test_mode: config.testMode,
  chain: config.chain.name,
  chain_id: 84532,
  escrow: config.chain.escrow || null,
  token: config.chain.usdc || null,
}));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Frontend (public/): landing at /, marketplace app at /app
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));
app.get('/app', (_req, res) => res.sendFile(path.join(pub, 'app.html')));

app.listen(config.port, () => console.log(`World Swap on :${config.port} (test_mode=${config.testMode})`));
