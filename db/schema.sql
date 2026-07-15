-- World Swap — Postgres schema (Neon-compatible)
-- USDC amounts are numeric(18,6). Wallet addresses are checksummed hex strings.
-- Run with: psql "$DATABASE_URL" -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Waitlist (landing page signups)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  source      text,                          -- 'landing', 'referral', etc.
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_uidx ON waitlist (lower(email));

-- ---------------------------------------------------------------------------
-- Users (identified by wallet; email/handle optional)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet        varchar(42) NOT NULL,        -- 0x + 40 hex
  handle        text,
  email         text,
  rep_score     integer NOT NULL DEFAULT 0,  -- reputation, for arbitration weighting later
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_uidx ON users (lower(wallet));

-- Profile fields + sign-in nonces (added with SIWE auth).
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_uidx ON users (lower(handle)) WHERE handle IS NOT NULL;

-- One-time nonces for Sign-In With Ethereum. Rows are deleted on use.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonces_created_idx ON auth_nonces (created_at);

-- ---------------------------------------------------------------------------
-- Listings (a product OR a service offer)
--   kind: 'digital'  -> instant delivery, has a sealed digital_asset
--         'physical' -> ships, escrow until received
--         'service'  -> work-for-hire, escrow until approved
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  seller_wallet varchar(42) NOT NULL,        -- denormalized for payout target
  handle        text,                        -- seller display name
  kind          text NOT NULL CHECK (kind IN ('digital','physical','service')),
  category      text NOT NULL,
  title         text NOT NULL,
  description   text NOT NULL,
  price_usdc    numeric(18,6) NOT NULL CHECK (price_usdc > 0),
  delivery_days integer,                     -- null for digital
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft','active','paused','removed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listings_browse_idx ON listings (status, kind, category, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_seller_idx ON listings (seller_wallet);

-- ---------------------------------------------------------------------------
-- Digital assets — the sealed payload for a digital listing.
-- The payload itself NEVER lives in the listing row and is never returned by
-- public reads. Stored encrypted; released only after an order is 'released'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS digital_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  asset_type    text NOT NULL CHECK (asset_type IN ('key','link','text','file')),
  -- For 'file': storage_key points to encrypted object storage (S3/R2).
  -- For key/link/text: secret_ciphertext holds the encrypted value.
  storage_key       text,
  secret_ciphertext text,
  content_type      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS digital_assets_listing_idx ON digital_assets (listing_id);

-- ---------------------------------------------------------------------------
-- Orders — one per purchase/hire. Drives the escrow state machine.
--   onchain_order_id: bytes32 used as the escrow key on-chain (keccak of id).
--   state lifecycle:
--     created  -> funded -> shipped/in_progress/submitted -> released
--                                     \-> disputed -> released | refunded
--     digital instant: created -> released (in one settle tx)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onchain_order_id varchar(66) NOT NULL,     -- 0x + 64 hex (bytes32)
  listing_id       uuid NOT NULL REFERENCES listings(id),
  kind             text NOT NULL,            -- snapshot of listing.kind
  buyer_wallet     varchar(42) NOT NULL,
  seller_wallet    varchar(42) NOT NULL,
  handle           text,
  amount_usdc      numeric(18,6) NOT NULL,
  fee_usdc         numeric(18,6) NOT NULL,   -- 0.5% of amount
  state            text NOT NULL DEFAULT 'created'
                     CHECK (state IN ('created','funded','shipped','in_progress',
                                      'submitted','released','disputed','refunded','cancelled')),
  tx_fund          varchar(66),
  tx_release       varchar(66),
  tracking         text,                     -- physical: carrier/tracking
  deliverable_ref  text,                     -- service: link/note to work
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  funded_at        timestamptz,
  released_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_onchain_uidx ON orders (onchain_order_id);
CREATE INDEX IF NOT EXISTS orders_buyer_idx  ON orders (buyer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_seller_idx ON orders (seller_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_state_idx  ON orders (state);

-- ---------------------------------------------------------------------------
-- Messages — per-order threads between buyer and seller.
-- Only the two parties to an order can read or write. This is where shipping
-- questions, revisions and "where is it?" happen, before anyone opens a dispute.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender      varchar(42) NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS messages_order_idx ON messages (order_id, created_at);

-- Physical delivery: the buyer's address is encrypted at rest (AES-256-GCM) and
-- only ever decrypted for the seller of that order. Tracking is structured so we
-- can build a carrier link instead of showing raw text.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_sealed  text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number  text;

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by    varchar(42) NOT NULL,         -- wallet of buyer or seller
  reason       text,
  state        text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','resolved_release','resolved_refund')),
  resolved_by  varchar(42),                  -- arbiter/multisig address
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS disputes_order_idx ON disputes (order_id);

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS listings_touch ON listings;
CREATE TRIGGER listings_touch BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
