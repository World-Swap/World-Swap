// server/crypto.js — keep digital payloads sealed until payment is confirmed.
// The listing row never contains the secret; it lives here, encrypted.
import crypto from 'node:crypto';
import { q } from './config.js';

const KEY = crypto.createHash('sha256')
  .update(process.env.ASSET_ENCRYPTION_KEY || 'dev-only-change-me')
  .digest();                                   // 32-byte AES key

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Same envelope, reused for buyer shipping addresses: encrypted at rest, only
// ever decrypted for the seller of that specific order.
export const sealText   = (s) => encrypt(String(s));
export const unsealText = (b64) => { try { return decrypt(b64); } catch { return null; } };

// Called on listing creation. For key/link/text we encrypt the value; for files
// you'd upload the encrypted blob to object storage and keep the storage_key.
export async function sealSecret(asset) {
  if (asset.asset_type === 'file') {
    // asset.value is a storage_key you already uploaded (encrypted) to S3/R2.
    return { storage_key: asset.value, ciphertext: null };
  }
  return { storage_key: null, ciphertext: encrypt(asset.value) };
}

// Called by the deliverable route ONLY after order.state === 'released'.
export async function unsealForOrder(listingId) {
  const { rows } = await q(
    `SELECT asset_type, storage_key, secret_ciphertext, content_type
       FROM digital_assets WHERE listing_id = $1`,
    [listingId]
  );
  const a = rows[0];
  if (!a) return null;
  if (a.asset_type === 'file') {
    // Issue a short-lived signed download URL from your object store here.
    return { type: 'file', url: signedUrlFor(a.storage_key), content_type: a.content_type };
  }
  return { type: a.asset_type, value: decrypt(a.secret_ciphertext) };
}

// Replace with your S3/R2 signed-URL implementation.
function signedUrlFor(storageKey) {
  return `https://cdn.worldswap.app/${storageKey}?sig=TODO`;
}
