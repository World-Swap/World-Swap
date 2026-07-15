// server/payments.js — order creation, escrow lifecycle, gated delivery.
import { Router } from 'express';
import { keccak256, toUtf8Bytes, JsonRpcProvider, Contract } from 'ethers';
import { q, config } from './config.js';
import { settleFunding, settleRelease } from './settlement.js';
import { unsealForOrder } from './crypto.js';
import { requireAuth } from './auth.js';

export const payments = Router();
const isAddr = a => /^0x[a-fA-F0-9]{40}$/.test(a || '');
const feeOf  = amt => (Number(amt) * config.feeBps / 10_000);

const SWAP_READ_ABI = ['function orders(bytes32) view returns (address buyer,address seller,uint256 amount,uint8 state)'];
// contract State enum: 0 None, 1 Funded, 2 Released, 3 Refunded, 4 Disputed

async function getOrder(id) {
  const { rows } = await q(`SELECT * FROM orders WHERE id = $1`, [id]);
  return rows[0];
}

const lc = v => String(v || '').toLowerCase();

// Fetch the order and assert the signed-in wallet is one of `roles`.
// Returns the order, or null after sending the error response.
async function guard(req, res, roles) {
  const o = await getOrder(req.params.id);
  if (!o) { res.status(404).json({ error: 'not found' }); return null; }
  const ok = roles.some(r =>
    r === 'buyer'   ? lc(o.buyer_wallet)  === req.wallet :
    r === 'seller'  ? lc(o.seller_wallet) === req.wallet :
    r === 'arbiter' ? lc(config.chain.arbiter) === req.wallet : false);
  if (!ok) { res.status(403).json({ error: `only the ${roles.join(' or ')} can do that` }); return null; }
  return o;
}

// --- CREATE order ------------------------------------------------------------
// POST /api/orders  { listing_id }   — buyer is the signed-in wallet, never the body.
payments.post('/', requireAuth, async (req, res) => {
  try {
    const { listing_id } = req.body || {};
    const buyer_wallet = req.wallet;

    const { rows } = await q(
      `SELECT id, kind, seller_wallet, handle, price_usdc FROM listings WHERE id=$1 AND status='active'`, [listing_id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'listing not available' });

    const fee = feeOf(listing.price_usdc);
    const ins = await q(
      `INSERT INTO orders (onchain_order_id, listing_id, kind, buyer_wallet, seller_wallet, handle, amount_usdc, fee_usdc, state)
       VALUES ('0x0',$1,$2,$3,$4,$5,$6,$7,'created') RETURNING id`,
      [listing.id, listing.kind, buyer_wallet, listing.seller_wallet, listing.handle, listing.price_usdc, fee]);
    const orderId = ins.rows[0].id;
    const onchainOrderId = keccak256(toUtf8Bytes(orderId));
    await q(`UPDATE orders SET onchain_order_id=$1 WHERE id=$2`, [onchainOrderId, orderId]);

    res.status(201).json({
      order_id: orderId,
      onchain_order_id: onchainOrderId,
      test_mode: config.testMode,
      mode: listing.kind === 'digital' ? 'instant' : 'escrow',
      chain: config.chain.name,
      token: config.chain.usdc,
      escrow: config.chain.escrow,
      seller: listing.seller_wallet,
      amount_usdc: listing.price_usdc,
      fee_usdc: fee,
    });
  } catch (e) { console.error('create order', e); res.status(500).json({ error: 'could not create order' }); }
});

// --- PAY (buyer funds) -------------------------------------------------------
// POST /api/orders/:id/pay   { tx_hash? }
// TEST_MODE: mocks settlement in the DB. On-chain: records tx (watcher is authoritative).
payments.post('/:id/pay', requireAuth, async (req, res) => {
  const o = await guard(req, res, ['buyer']);
  if (!o) return;
  if (o.state !== 'created') return res.status(409).json({ error: 'already paid' });
  const result = await settleFunding(o);
  if (!config.testMode && req.body?.tx_hash)
    await q(`UPDATE orders SET tx_fund=$2 WHERE id=$1`, [o.id, req.body.tx_hash]);
  res.json({ result, state: (await getOrder(o.id)).state });
});

// --- VERIFY on-chain state (no watcher needed for testing) -------------------
// POST /api/orders/:id/verify  { tx_hash? }
// Reads the escrow contract's order state and syncs the DB. Only advances money
// states (created->funded, ->released, ->refunded); preserves off-chain
// sub-states like shipped/submitted.
payments.post('/:id/verify', requireAuth, async (req, res) => {
  const o = await guard(req, res, ['buyer', 'seller']);
  if (!o) return;
  if (config.testMode) return res.json({ state: o.state, test_mode: true });
  if (!config.chain.rpcUrl || !config.chain.escrow)
    return res.status(500).json({ error: 'chain not configured' });
  try {
    const provider = new JsonRpcProvider(config.chain.rpcUrl);
    const swap = new Contract(config.chain.escrow, SWAP_READ_ABI, provider);
    const oc = await swap.orders(o.onchain_order_id);
    const st = Number(oc.state);
    let to = null, patch = {};
    if (st === 2)       { to = 'released'; patch.released_at = new Date(); if (req.body?.tx_hash) patch.tx_release = req.body.tx_hash; }
    else if (st === 3)  { to = 'refunded'; }
    else if (st === 4)  { to = 'disputed'; }
    else if (st === 1 && o.state === 'created') { to = 'funded'; patch.funded_at = new Date(); if (req.body?.tx_hash) patch.tx_fund = req.body.tx_hash; }
    if (to) {
      const cols = ['state = $2'], params = [o.id, to];
      for (const [k, v] of Object.entries(patch)) { params.push(v); cols.push(`${k} = $${params.length}`); }
      await q(`UPDATE orders SET ${cols.join(', ')} WHERE id = $1`, params);
    }
    res.json({ state: to || o.state, onchain_state: st });
  } catch (e) {
    console.error('verify', e);
    res.status(500).json({ error: 'verify failed' });
  }
});
async function transition(id, from, to, patch = {}) {
  const cols = ['state = $2'], params = [id, to];
  for (const [k, v] of Object.entries(patch)) { params.push(v); cols.push(`${k} = $${params.length}`); }
  const fromClause = Array.isArray(from) ? `state = ANY($${params.push(from)})`
                                         : (params.push(from), `state = $${params.length}`);
  const { rows } = await q(
    `UPDATE orders SET ${cols.join(', ')} WHERE id=$1 AND ${fromClause} RETURNING id, state`, params);
  return rows[0];
}

payments.post('/:id/ship', requireAuth, async (req, res) => {
  if (!await guard(req, res, ['seller'])) return;
  const o = await transition(req.params.id, 'funded', 'shipped', { tracking: req.body?.tracking || null });
  o ? res.json({ order: o }) : res.status(409).json({ error: 'invalid transition' });
});
payments.post('/:id/start', requireAuth, async (req, res) => {
  if (!await guard(req, res, ['seller'])) return;
  const o = await transition(req.params.id, 'funded', 'in_progress');
  o ? res.json({ order: o }) : res.status(409).json({ error: 'invalid transition' });
});
payments.post('/:id/submit', requireAuth, async (req, res) => {
  if (!await guard(req, res, ['seller'])) return;
  const o = await transition(req.params.id, ['funded', 'in_progress'], 'submitted', { deliverable_ref: req.body?.deliverable || null });
  o ? res.json({ order: o }) : res.status(409).json({ error: 'invalid transition' });
});
payments.post('/:id/changes', requireAuth, async (req, res) => {
  if (!await guard(req, res, ['buyer'])) return;
  const o = await transition(req.params.id, 'submitted', 'in_progress', { deliverable_ref: null });
  o ? res.json({ order: o }) : res.status(409).json({ error: 'invalid transition' });
});

// Buyer confirms delivery / approves work -> release funds.
// A disputed order is the arbiter's call, not the buyer's.
payments.post('/:id/release', requireAuth, async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (!['funded', 'shipped', 'submitted', 'in_progress', 'disputed'].includes(o.state))
    return res.status(409).json({ error: 'not releasable' });
  const isBuyer   = lc(o.buyer_wallet) === req.wallet;
  const isArbiter = lc(config.chain.arbiter) === req.wallet;
  if (o.state === 'disputed' ? !isArbiter : !isBuyer)
    return res.status(403).json({
      error: o.state === 'disputed' ? 'only the arbiter can release a disputed order'
                                    : 'only the buyer can release' });
  const result = await settleRelease(o);
  res.json({ result, state: (await getOrder(o.id)).state });
});

// Dispute: either party may open. Arbiter resolves.
payments.post('/:id/dispute', requireAuth, async (req, res) => {
  if (!await guard(req, res, ['buyer', 'seller'])) return;
  const o = await transition(req.params.id, ['funded', 'shipped', 'in_progress', 'submitted'], 'disputed');
  if (!o) return res.status(409).json({ error: 'invalid transition' });
  await q(`INSERT INTO disputes (order_id, opened_by, reason) VALUES ($1,$2,$3)`,
    [req.params.id, req.wallet, req.body?.reason || null]);
  res.json({ order: o });
});
payments.post('/:id/resolve', requireAuth, async (req, res) => {
  const ord = await guard(req, res, ['arbiter']);
  if (!ord) return;
  const toSeller = !!req.body?.release_to_seller;
  if (ord.state !== 'disputed') return res.status(409).json({ error: 'not disputed' });
  if (toSeller) { await settleRelease(ord); }
  else { await q(`UPDATE orders SET state='refunded' WHERE id=$1`, [ord.id]); }
  await q(`UPDATE disputes SET state=$2, resolved_at=now(), resolved_by=$3 WHERE order_id=$1`,
    [ord.id, toSeller ? 'resolved_release' : 'resolved_refund', req.wallet]);
  res.json({ state: (await getOrder(ord.id)).state });
});

// --- list the signed-in wallet's orders --------------------------------------
payments.get('/', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT o.*, l.title, l.handle FROM orders o
       JOIN listings l ON l.id = o.listing_id
      WHERE lower(o.buyer_wallet) = $1 OR lower(o.seller_wallet) = $1
      ORDER BY o.created_at DESC LIMIT 100`, [req.wallet]);
  res.json({ orders: rows });
});

// --- gated deliverable (digital) --------------------------------------------
// Buyer addresses are public on-chain, so this MUST use the session, not a param.
payments.get('/:id/deliverable', requireAuth, async (req, res) => {
  const { rows } = await q(
    `SELECT o.state, o.buyer_wallet, o.listing_id, l.kind
       FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1`, [req.params.id]);
  const o = rows[0];
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.kind !== 'digital') return res.status(400).json({ error: 'not a digital order' });
  if (lc(o.buyer_wallet) !== req.wallet) return res.status(403).json({ error: 'not the buyer' });
  if (o.state !== 'released') return res.status(403).json({ error: 'payment not confirmed' });
  const delivery = await unsealForOrder(o.listing_id);
  res.json({ delivery });
});
