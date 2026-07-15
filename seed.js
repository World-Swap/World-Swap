// server/profiles.js — public identity for wallets.
//
// A wallet address tells a buyer nothing. A profile (handle, bio, completed
// orders, volume) is what lets two strangers decide to transact. Email is
// optional and never leaves this server except to the owner.
import { Router } from 'express';
import { q } from './config.js';
import { requireAuth, optionalAuth, publicProfile } from './auth.js';

export const profiles = Router();

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'support', 'help', 'worldswap', 'world_swap', 'world-swap',
  'system', 'root', 'moderator', 'mod', 'staff', 'official', 'api', 'escrow', 'arbiter',
  'null', 'undefined', 'anonymous', 'me',
]);

// GET /api/profile/me
profiles.get('/me', requireAuth, async (req, res) => {
  const { rows } = await q(`SELECT * FROM users WHERE lower(wallet) = $1`, [req.wallet]);
  if (!rows[0]) return res.status(404).json({ error: 'no profile' });
  res.json({ profile: publicProfile(rows[0], true) });
});

// PUT /api/profile/me  { handle?, display_name?, bio?, email? }
profiles.put('/me', requireAuth, async (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (b.handle !== undefined) {
    const h = String(b.handle || '').trim().toLowerCase();
    if (h && !HANDLE_RE.test(h))
      return res.status(400).json({ error: 'handle must be 3–20 characters: a–z, 0–9, underscore' });
    if (h && RESERVED.has(h)) return res.status(400).json({ error: 'that handle is reserved' });
    patch.handle = h || null;
  }
  if (b.display_name !== undefined)
    patch.display_name = String(b.display_name || '').trim().slice(0, 50) || null;
  if (b.bio !== undefined)
    patch.bio = String(b.bio || '').trim().slice(0, 300) || null;
  if (b.email !== undefined) {
    const e = String(b.email || '').trim().toLowerCase();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      return res.status(400).json({ error: "that email doesn't look right" });
    patch.email = e || null;
  }

  const keys = Object.keys(patch);
  if (!keys.length) return res.status(400).json({ error: 'nothing to update' });

  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await q(
      `UPDATE users SET ${sets} WHERE lower(wallet) = $1 RETURNING *`,
      [req.wallet, ...keys.map(k => patch[k])]);
    if (!rows[0]) return res.status(404).json({ error: 'no profile' });

    // Keep the denormalized handle on listings in step with the profile.
    if (patch.handle !== undefined)
      await q(`UPDATE listings SET handle = $2 WHERE lower(seller_wallet) = $1`,
        [req.wallet, patch.handle]);

    res.json({ profile: publicProfile(rows[0], true) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'that handle is already taken' });
    console.error('[profile/put]', e);
    res.status(500).json({ error: 'could not save profile' });
  }
});

// GET /api/profile/:id  — public, by handle or wallet.
// Tolerant by design: any wallet is viewable even if it has never set a profile
// (seeded sellers, or someone who just signed in). We synthesise a stub rather
// than 404, so "by <seller>" links in Browse always resolve to something useful.
profiles.get('/:id', optionalAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const byWallet = /^0x[a-fA-F0-9]{40}$/.test(id);

  const { rows } = await q(
    byWallet ? `SELECT * FROM users WHERE lower(wallet) = $1`
             : `SELECT * FROM users WHERE lower(handle) = $1`,
    [id.toLowerCase()]);
  let u = rows[0];

  // No user row? Fall back to the wallet behind the listings.
  if (!u) {
    const fb = await q(
      byWallet ? `SELECT seller_wallet, handle FROM listings WHERE lower(seller_wallet) = $1 LIMIT 1`
               : `SELECT seller_wallet, handle FROM listings WHERE lower(handle) = $1 LIMIT 1`,
      [id.toLowerCase()]);
    const wallet = byWallet ? id : fb.rows[0]?.seller_wallet;
    if (!wallet) return res.status(404).json({ error: 'no such profile' });
    u = {
      wallet: wallet.toLowerCase(),
      handle: fb.rows[0]?.handle || null,
      display_name: null, bio: null, email: null,
      avatar_seed: wallet.toLowerCase(), rep_score: 0,
      created_at: null, unclaimed: true,
    };
  }

  const w = u.wallet.toLowerCase();
  const [stats, ls] = await Promise.all([
    q(`SELECT COUNT(*) FILTER (WHERE state = 'released')                     AS completed,
              COALESCE(SUM(amount_usdc) FILTER (WHERE state = 'released'), 0) AS volume
         FROM orders WHERE lower(seller_wallet) = $1`, [w]),
    q(`SELECT id, title, kind, category, price_usdc
         FROM listings
        WHERE lower(seller_wallet) = $1 AND status = 'active'
        ORDER BY created_at DESC LIMIT 12`, [w]),
  ]);

  const shaped = publicProfile(u, req.wallet === w);
  if (u.unclaimed) shaped.unclaimed = true;

  res.json({
    profile: shaped,
    stats: {
      completed: Number(stats.rows[0].completed),
      volume: Number(stats.rows[0].volume),
    },
    listings: ls.rows,
  });
});
