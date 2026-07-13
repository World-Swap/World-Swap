// server/listings.js — the structure for adding & browsing products
import { Router } from 'express';
import { q } from './config.js';
import { sealSecret } from './crypto.js';       // encrypts digital payloads at rest

export const listings = Router();

const KINDS = new Set(['digital', 'physical', 'service']);
const ASSET_TYPES = new Set(['key', 'link', 'text', 'file']);
const isAddr = a => /^0x[a-fA-F0-9]{40}$/.test(a || '');

// --- helper: upsert user by wallet, return id --------------------------------
async function ensureUser(wallet, handle) {
  const { rows } = await q(
    `INSERT INTO users (wallet, handle) VALUES ($1, $2)
     ON CONFLICT (lower(wallet)) DO UPDATE SET handle = COALESCE(EXCLUDED.handle, users.handle)
     RETURNING id`,
    [wallet, handle || null]
  );
  return rows[0].id;
}

// --- CREATE a listing --------------------------------------------------------
// POST /api/listings
// body: { kind, category, title, description, price_usdc, seller_wallet, handle,
//         delivery_days?, asset?: { asset_type, value } }   (asset only for digital)
listings.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!KINDS.has(b.kind))                 return res.status(400).json({ error: 'invalid kind' });
    if (!b.title || !b.description)         return res.status(400).json({ error: 'title and description required' });
    if (!b.category)                        return res.status(400).json({ error: 'category required' });
    if (!(Number(b.price_usdc) > 0))        return res.status(400).json({ error: 'price must be > 0' });
    if (!isAddr(b.seller_wallet))           return res.status(400).json({ error: 'valid seller_wallet required' });

    if (b.kind === 'digital') {
      const a = b.asset || {};
      if (!ASSET_TYPES.has(a.asset_type))   return res.status(400).json({ error: 'invalid asset_type' });
      if (!a.value)                         return res.status(400).json({ error: 'digital payload required' });
    } else if (!(Number(b.delivery_days) > 0)) {
      return res.status(400).json({ error: 'delivery_days required for physical/service' });
    }

    const sellerId = await ensureUser(b.seller_wallet, b.handle);

    const { rows } = await q(
      `INSERT INTO listings
         (seller_id, seller_wallet, kind, category, title, description, price_usdc, delivery_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, kind, category, title, description, price_usdc, delivery_days, status, created_at`,
      [sellerId, b.seller_wallet, b.kind, b.category, b.title, b.description,
       b.price_usdc, b.kind === 'digital' ? null : b.delivery_days]
    );
    const listing = rows[0];

    // Seal the digital payload separately — it is NEVER part of the listing row.
    if (b.kind === 'digital') {
      const a = b.asset;
      const { storage_key, ciphertext } = await sealSecret(a);   // encrypt or store-encrypted
      await q(
        `INSERT INTO digital_assets (listing_id, asset_type, storage_key, secret_ciphertext, content_type)
         VALUES ($1,$2,$3,$4,$5)`,
        [listing.id, a.asset_type, storage_key || null, ciphertext || null, a.content_type || null]
      );
    }

    res.status(201).json({ listing });
  } catch (e) {
    console.error('create listing', e);
    res.status(500).json({ error: 'could not create listing' });
  }
});

// --- BROWSE listings ---------------------------------------------------------
// GET /api/listings?kind=&category=&q=&limit=&cursor=
// Public read: digital payloads are never included.
listings.get('/', async (req, res) => {
  try {
    const { kind, category, q: search } = req.query;
    const limit = Math.min(Number(req.query.limit) || 24, 60);
    const where = [`status = 'active'`];
    const params = [];

    if (kind === 'goods')        { where.push(`kind IN ('digital','physical')`); }
    else if (kind === 'service') { params.push('service'); where.push(`kind = $${params.length}`); }
    else if (KINDS.has(kind))    { params.push(kind); where.push(`kind = $${params.length}`); }

    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (search)   { params.push(`%${search}%`); where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    params.push(limit);

    const { rows } = await q(
      `SELECT id, seller_wallet, handle, kind, category, title, description, price_usdc,
              delivery_days, created_at
         FROM listings
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ listings: rows });
  } catch (e) {
    console.error('browse', e);
    res.status(500).json({ error: 'could not fetch listings' });
  }
});

// --- SINGLE listing ----------------------------------------------------------
listings.get('/:id', async (req, res) => {
  const { rows } = await q(
    `SELECT id, seller_wallet, handle, kind, category, title, description, price_usdc,
            delivery_days, status, created_at
       FROM listings WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ listing: rows[0] });
});

// --- UPDATE / unpublish (seller only — enforce with wallet-auth middleware) --
listings.patch('/:id', async (req, res) => {
  const allowed = ['title', 'description', 'price_usdc', 'category', 'delivery_days', 'status'];
  const sets = [], params = [];
  for (const k of allowed) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k} = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  const { rows } = await q(
    `UPDATE listings SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, status`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ listing: rows[0] });
});

// --- Waitlist ----------------------------------------------------------------
// POST /api/waitlist  { email, source? }
export const waitlist = Router();
waitlist.post('/', async (req, res) => {
  const email = (req.body?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  await q(
    `INSERT INTO waitlist (email, source) VALUES ($1, $2)
     ON CONFLICT (lower(email)) DO NOTHING`,
    [email, req.body?.source || 'landing']
  );
  const { rows } = await q(`SELECT count(*)::int AS n FROM waitlist`);
  res.status(201).json({ ok: true, count: rows[0].n });
});
