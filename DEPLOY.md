# DEPLOY — get World Swap live for trials

Goal: a working, testable marketplace on your own domain, today. It runs in
**TEST_MODE** (settlement mocked, no wallets/contracts needed) so you can trial
the whole flow. Flipping to real on-chain USDC is one env var later.

One deployable unit: a single Express web service that serves both the API and
the frontend (landing at `/`, marketplace at `/app`).

---

## 1. Push to GitHub (World-Swap org)

```bash
cd world-swap
git init && git add . && git commit -m "World Swap: marketplace + escrow (test mode)"
gh repo create World-Swap/world-swap --private --source=. --push
# or create the repo in the UI and: git remote add origin ... && git push -u origin main
```

## 2. Database (Neon)

1. Create a Neon project → copy the connection string (`DATABASE_URL`).
2. Load the schema and demo listings:

```bash
export DATABASE_URL="postgres://...neon.tech/...?sslmode=require"
npm install
npm run migrate      # runs db/schema.sql
npm run seed         # ~7 demo listings so it isn't empty
```

## 3. Deploy the web service (Render)

Render → **New → Web Service** → connect the repo. Settings:

| Field           | Value                 |
|-----------------|-----------------------|
| Runtime         | Node                  |
| Build command   | `npm install`         |
| Start command   | `npm start`           |
| Instance        | Starter is fine       |

**Environment variables:**

```
DATABASE_URL          = <your Neon string>
TEST_MODE             = true
ASSET_ENCRYPTION_KEY  = <32+ random chars>     # openssl rand -hex 24
```

(`PORT` is provided by Render automatically.) Deploy → you get
`https://world-swap.onrender.com`. Open it: landing at `/`, click **Enter
marketplace** → list, buy, hire, walk the escrow lifecycle. That's your trial.

> Tip: if you'd rather Render read config from the repo, a `render.yaml` blueprint
> is included — **New → Blueprint** and it wires the web service for you.

## 4. Point your domain at it

In the Render service → **Settings → Custom Domains → Add**. Add both:

- `worldswap.app` (apex)
- `www.worldswap.app`

Render shows you the DNS records to create. At your registrar (GoDaddy,
Namecheap, Cloudflare — same idea everywhere):

| Type            | Host / Name | Value                          |
|-----------------|-------------|--------------------------------|
| CNAME           | `www`       | `world-swap.onrender.com`      |
| ALIAS / ANAME*  | `@` (apex)  | `world-swap.onrender.com`      |

\* If your registrar has no ALIAS/ANAME for the apex, use the A record IP Render
displays instead, or point the apex to `www` with a forward. Cloudflare and
Namecheap support ALIAS/ANAME; GoDaddy uses "Forwarding" for the apex.

SSL is automatic — Render provisions a certificate once DNS resolves (minutes to
a couple of hours). Then `https://worldswap.app` serves the site.

No app code changes are needed for the domain: the frontend calls the API on the
same origin, so it follows the domain automatically.

---

## 5. When you're ready for real crypto

Trials done in test mode? Switch to on-chain USDC:

1. **Deploy the contract** to Base Sepolia (testnet first):
   ```bash
   forge install OpenZeppelin/openzeppelin-contracts
   # deploy SwapEscrow(USDC, FEE_RECIPIENT, ARBITER) → note the address
   ```
2. **Add env vars** to the Render service and set `TEST_MODE=false`:
   ```
   CHAIN_NAME=base-sepolia
   RPC_URL=<your RPC>
   USDC_ADDRESS=<testnet USDC>
   ESCROW_ADDRESS=<deployed SwapEscrow>
   FEE_RECIPIENT=<your fee wallet>
   ARBITER_ADDRESS=<your dispute multisig>
   ```
3. **Add the watcher** as a second Render service → **Background Worker**, same
   repo, start command `npm run watcher`. It syncs order state from chain events.
4. **Add wallet connect** to the frontend `pay()` step (the buy modal) so the
   buyer's wallet calls `approve()` + `fundEscrow()`/`settleInstant()`. The API
   response already returns `escrow`, `token`, `seller`, `amount`, and
   `onchain_order_id` for exactly this.
5. Trial on testnet with fake USDC → then repeat on Base mainnet **after an
   audit** of the contract.

---

## What works in TEST_MODE right now

- Browse goods + services, filter, search — real data in Neon, shared across testers.
- List a digital / physical / service item.
- Buy digital → instant delivery (sealed payload unlocked).
- Buy physical / hire service → funds "held in escrow" → advance the lifecycle
  (ship → confirm, or start → submit → approve) → release. Dispute + arbiter
  resolve included.
- Waitlist on the landing page writes to the `waitlist` table.

Each browser gets its own demo wallet (stored locally) so you can act as buyer
and seller across two tabs/devices to test both sides.
