# World Swap — structure

A non-custodial marketplace for goods and services, settled in USDC. This repo is
the skeleton: a clear product landing page, the structure for adding products, and
the crypto/escrow payment structure.

```
world-swap/
  landing.html               product landing page + waitlist
  db/schema.sql              Postgres (Neon) schema
  contracts/SwapEscrow.sol   non-custodial escrow contract (USDC)
  server/
    index.js                 Express entry
    config.js                env + pg pool + chain config
    listings.js              add / browse products  (+ waitlist route)
    payments.js              orders, escrow lifecycle, gated delivery
    crypto.js                seals digital payloads until release
    escrowWatcher.js         syncs order state from on-chain events
```

## The three listing kinds

| kind       | settlement        | funds held?        | delivery                         |
|------------|-------------------|--------------------|----------------------------------|
| `digital`  | `settleInstant`   | no (atomic)        | payload unlocked on release      |
| `physical` | `fundEscrow`      | yes, until receipt | buyer confirms delivery          |
| `service`  | `fundEscrow`      | yes, until approve | buyer approves the deliverable   |

## Adding a product (data + API)

`POST /api/listings` writes a `listings` row. For `digital`, the secret payload is
**never** stored on the listing — it goes to `digital_assets`, encrypted at rest
(`crypto.js`), and is only ever returned by `GET /api/orders/:id/deliverable` after
the order reaches `released`. Browse (`GET /api/listings`) filters by kind, category,
and search, and never returns payloads.

## Crypto / payment flow

The server never touches funds. It hands the buyer's wallet the parameters; the
wallet executes the contract; the chain is the source of truth.

```
buyer                     API                     SwapEscrow (chain)        watcher
  |  POST /api/orders  ---> create order (created) |                          |
  |  <-- {mode, escrow, token, amount, seller} ----|                          |
  |  approve(USDC) + fundEscrow()/settleInstant() ------------------------->   |
  |                                                 |  emit Funded ----------> | -> state=funded
  |            ... seller ships / does work ...      |                          |
  |  escrow.release(orderId)  ------------------------------------------->     |
  |                                                 |  emit Released --------> | -> state=released
  |  GET /deliverable (digital) --> unlocked        |                          |
```

- **Fee:** 0.5% (50 bps) split inside `_settle` — 99.5% to seller, 0.5% to
  `feeRecipient`, in the same transaction. No separate collection step.
- **Instant (digital):** `settleInstant` funds + releases atomically — no hold.
- **Escrow (physical/service):** funds sit in the contract until the buyer calls
  `release`. World Swap operators cannot move them.
- **Disputes:** either party calls `raiseDispute` → funds freeze → only the
  `arbiter` (a multisig) can `resolve` to release or refund. **World Swap alone
  cannot move escrowed funds** — this is what keeps the model non-custodial and
  out of money-transmitter territory. Start the arbiter as your own multisig;
  evolve toward staked/decentralized arbitration (e.g. Kleros) as volume grows.

## Chain choice

Recommended: **USDC on Base** — cheap gas, deep USDC liquidity, easy on-ramps.
All chain params live in `config.js` / env, so switching L2s is a config change.

## Setup

```bash
# 1. database
psql "$DATABASE_URL" -f db/schema.sql

# 2. env
DATABASE_URL=...            # Neon
RPC_URL=https://mainnet.base.org
USDC_ADDRESS=0x...          # USDC on Base
ESCROW_ADDRESS=0x...        # deployed SwapEscrow
FEE_RECIPIENT=0x...         # World Swap fee wallet
ARBITER_ADDRESS=0x...       # dispute multisig
ASSET_ENCRYPTION_KEY=...    # 32+ random chars, sealed payloads

# 3. contract
#   forge install OpenZeppelin/openzeppelin-contracts
#   deploy SwapEscrow(usdc, feeRecipient, arbiter); set ESCROW_ADDRESS

# 4. run (two Render services)
node server/index.js          # API (web service)
node server/escrowWatcher.js  # events -> DB (worker)
```

## Before mainnet

- **Audit `SwapEscrow.sol`.** It's a reference; real funds need a professional audit.
- **Wallet auth (SIWE):** gate all write routes on a signed message from the wallet.
- **Verify funding on-chain** in `confirm-fund` (or rely solely on the watcher).
- **Regulatory review:** the non-custodial + arbiter-multisig design is what keeps
  you off the money-transmitter path — have counsel confirm your specific setup,
  especially given California DFAL exposure.
