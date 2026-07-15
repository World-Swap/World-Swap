// server/auth.js — Sign-In With Ethereum (EIP-4361) + stateless HMAC sessions.
//
// Why this exists: every order route used to trust a ?wallet= query param, and
// buyer addresses are public on-chain. Anyone could read another wallet's orders
// or pull a paid digital deliverable. Now the wallet must PROVE it's the wallet
// by signing a one-time nonce; the server issues a signed, HttpOnly cookie.
//
// No new dependencies: ethers verifies the signature, node:crypto signs the cookie.
import crypto from 'node:crypto';
import { Router } from 'express';
import { ethers } from 'ethers';
import { q, config } from './config.js';

const COOKIE = 'ws_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;             // 7 days

// If SESSION_SECRET is unset we still run, but sessions die on restart.
const RAW_SECRET = process.env.SESSION_SECRET;
if (!RAW_SECRET) console.warn('[auth] SESSION_SECRET not set — sessions will not survive a restart.');
const KEY = crypto.createHash('sha256')
  .update(RAW_SECRET || crypto.randomBytes(32).toString('hex'))
  .digest();

// ---- token ----------------------------------------------------------------
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac  = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return (p && typeof p.exp === 'number' && p.exp > Date.now()) ? p : null;
  } catch { return null; }
}

// ---- cookies (no cookie-parser dependency) --------------------------------
export function readCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || req.secure;

function setSession(req, res, wallet) {
  const token = signToken({ w: wallet.toLowerCase(), exp: Date.now() + TTL_MS });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; SameSite=Lax` +
    (isHttps(req) ? '; Secure' : ''));
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` + (isHttps(req) ? '; Secure' : ''));
}

// ---- middleware -----------------------------------------------------------
export function requireAuth(req, res, next) {
  const p = readToken(readCookies(req)[COOKIE]);
  if (!p) return res.status(401).json({ error: 'sign in required' });
  req.wallet = p.w;                                  // always lower-case
  next();
}
export function optionalAuth(req, _res, next) {
  const p = readToken(readCookies(req)[COOKIE]);
  if (p) req.wallet = p.w;
  next();
}

// ---- profile shaping ------------------------------------------------------
// `self` decides whether private fields (email) come back.
export function publicProfile(u, self = false) {
  if (!u) return null;
  const out = {
    wallet: u.wallet,
    handle: u.handle || null,
    display_name: u.display_name || null,
    bio: u.bio || null,
    avatar_seed: u.avatar_seed || u.wallet,
    rep_score: u.rep_score ?? 0,
    created_at: u.created_at,
  };
  if (self) { out.email = u.email || null; out.is_self = true; }
  return out;
}

export async function upsertUser(wallet) {
  const w = wallet.toLowerCase();
  const seed = crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);
  const { rows } = await q(
    `INSERT INTO users (wallet, avatar_seed, last_seen_at)
          VALUES ($1, $2, now())
     ON CONFLICT (lower(wallet))
     DO UPDATE SET last_seen_at = now(),
                   avatar_seed  = COALESCE(users.avatar_seed, EXCLUDED.avatar_seed)
       RETURNING *`, [w, seed]);
  return rows[0];
}

// ---- routes ---------------------------------------------------------------
export const auth = Router();

// The exact message the client must sign. Kept server-side so both ends agree.
export function buildSiweMessage({ domain, address, uri, chainId, nonce, issuedAt }) {
  return `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in to World Swap. This only proves you own this wallet — it costs nothing and moves no funds.

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

auth.get('/nonce', async (_req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  await q(`INSERT INTO auth_nonces (nonce) VALUES ($1)`, [nonce]);
  q(`DELETE FROM auth_nonces WHERE created_at < now() - interval '15 minutes'`).catch(() => {});
  res.json({ nonce });
});

auth.post('/verify', async (req, res) => {
  try {
    const { message, signature } = req.body || {};
    if (typeof message !== 'string' || typeof signature !== 'string')
      return res.status(400).json({ error: 'message and signature required' });

    const nonce  = (message.match(/^Nonce: (.+)$/m) || [])[1]?.trim();
    const addr   = (message.match(/^(0x[a-fA-F0-9]{40})$/m) || [])[1];
    const domain = (message.match(/^(.+) wants you to sign in with your Ethereum account:$/m) || [])[1]?.trim();
    const issued = (message.match(/^Issued At: (.+)$/m) || [])[1]?.trim();
    if (!nonce || !addr || !domain) return res.status(400).json({ error: 'malformed message' });

    // Domain must match this host: a signature farmed on another site won't work here.
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    if (domain.split(':')[0].toLowerCase() !== host.toLowerCase())
      return res.status(400).json({ error: 'domain mismatch' });

    const t = Date.parse(issued || '');
    if (!t || Math.abs(Date.now() - t) > 10 * 60 * 1000)
      return res.status(400).json({ error: 'message expired — try again' });

    // Nonce is single-use: deleting it IS the check.
    const used = await q(`DELETE FROM auth_nonces WHERE nonce = $1 RETURNING nonce`, [nonce]);
    if (!used.rowCount) return res.status(400).json({ error: 'invalid or already-used nonce' });

    let recovered;
    try { recovered = ethers.verifyMessage(message, signature); }
    catch { return res.status(401).json({ error: 'bad signature' }); }
    if (recovered.toLowerCase() !== addr.toLowerCase())
      return res.status(401).json({ error: 'signature does not match address' });

    const user = await upsertUser(recovered);
    setSession(req, res, recovered);
    res.json({ wallet: recovered.toLowerCase(), profile: publicProfile(user, true) });
  } catch (e) {
    console.error('[auth/verify]', e);
    res.status(500).json({ error: 'sign-in failed' });
  }
});

// TEST_MODE only: the demo wallet is fake and cannot sign. Never reachable in prod.
auth.post('/dev', async (req, res) => {
  if (!config.testMode) return res.status(404).json({ error: 'not found' });
  const w = req.body?.wallet;
  if (!/^0x[a-fA-F0-9]{40}$/.test(w || '')) return res.status(400).json({ error: 'wallet required' });
  const user = await upsertUser(w);
  setSession(req, res, w);
  res.json({ wallet: w.toLowerCase(), profile: publicProfile(user, true) });
});

auth.get('/me', optionalAuth, async (req, res) => {
  if (!req.wallet) return res.json({ wallet: null, profile: null });
  const { rows } = await q(`SELECT * FROM users WHERE lower(wallet) = $1`, [req.wallet]);
  res.json({ wallet: req.wallet, profile: publicProfile(rows[0], true) });
});

auth.post('/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });
