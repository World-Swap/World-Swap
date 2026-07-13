# TESTNET — test the real escrow function on Base Sepolia

This runs your actual escrow contract holding real (but free) USDC. Same code path
as mainnet, zero financial risk. Do this before ever touching mainnet.

Addresses you'll use:
- **USDC (Base Sepolia):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`  (Circle, 6 decimals)
- **Fee recipient (your Coinbase Wallet):** `0xc0FfB2dada4aC6b99575eE2ecc58F92a31f5c9b1`
- **Chain:** Base Sepolia · chainId 84532 · RPC `https://sepolia.base.org` · explorer `https://sepolia.basescan.org`

---

## 1. Get testnet funds (free)

Into your Coinbase Wallet, on **Base Sepolia**:

1. **Test ETH** (for gas): Coinbase Developer Platform faucet
   (`portal.cdp.coinbase.com` → Faucets → Base Sepolia), or an Alchemy/QuickNode
   Base Sepolia faucet. You need only a little.
2. **Test USDC**: Circle faucet at `faucet.circle.com` → select **Base Sepolia** →
   paste your wallet → receive test USDC. Grab a few hundred so you can test
   several orders.

Confirm both show up in Coinbase Wallet (add the USDC token by its address above if
it doesn't auto-appear). Make sure the wallet is switched to the Base Sepolia network.

## 2. Deploy the escrow contract (Remix — no install needed)

1. Go to **remix.ethereum.org**.
2. Create a file `SwapEscrow.sol` and paste in `contracts/SwapEscrow.sol` from this repo.
3. **Solidity Compiler** tab → compiler `0.8.20+` → **Compile**. (Remix fetches the
   OpenZeppelin imports automatically.)
4. **Deploy & Run** tab:
   - Environment: **Injected Provider — Coinbase Wallet** (approve the connect; make
     sure the wallet is on **Base Sepolia**).
   - Contract: `SwapEscrow`.
   - Next to **Deploy**, expand the constructor and fill the three args:
     - `_token`  = `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
     - `_feeRecipient` = `0xc0FfB2dada4aC6b99575eE2ecc58F92a31f5c9b1`
     - `_arbiter` = `0xc0FfB2dada4aC6b99575eE2ecc58F92a31f5c9b1`  (your wallet, to start)
   - Click **Deploy**, confirm in Coinbase Wallet.
5. Copy the deployed contract address (under "Deployed Contracts"). That's your
   **ESCROW_ADDRESS**.

## 3. Push the updated code

The buy/release flow now does real wallet transactions when test mode is off. In
your local `world-swap` folder:

```bash
git add .
git commit -m "on-chain escrow (Base Sepolia)"
git push
```

Render auto-deploys. (Changed: `public/app.html`, `server/payments.js`,
`server/index.js`.)

## 4. Flip Render to on-chain

Render → your service → **Environment** → set/add:

```
TEST_MODE      = false
CHAIN_NAME     = base-sepolia
RPC_URL        = https://sepolia.base.org
USDC_ADDRESS   = 0x036CbD53842c5426634e7929541eC2318f3dCF7e
ESCROW_ADDRESS = <the address from step 2>
FEE_RECIPIENT  = 0xc0FfB2dada4aC6b99575eE2ecc58F92a31f5c9b1
ARBITER_ADDRESS= 0xc0FfB2dada4aC6b99575eE2ecc58F92a31f5c9b1
```

Save → it redeploys. The app's badge will now read **BASE SEPOLIA** instead of
TEST MODE.

## 5. Test the escrow function

Open `/app`. The listings' `seller_wallet` values are random demo addresses, which
is fine for testing — the seller just won't be a wallet you hold, so test payouts
land somewhere you don't control. To test a payout to a wallet you own, **list your
own item** in Sell/Offer with a second wallet address as the seller.

**Digital (instant):**
1. Buy a digital item → Coinbase Wallet pops: first **Approve** USDC, then
   **Confirm** the `settleInstant` tx.
2. On confirmation the split executes on-chain (seller + 0.5% fee) and the item
   delivers. Check the tx on BaseScan; check the fee wallet received 0.5%.

**Physical / service (escrow hold — the important test):**
1. Buy/hire → Approve → Confirm `fundEscrow`. Your USDC leaves your wallet and sits
   **in the contract** (verify: the escrow address's USDC balance went up).
2. In Orders, advance the workflow (ship / submit — these are off-chain status).
3. Click **release** → Confirm the `release` tx. The contract now splits the held
   USDC: 99.5% to seller, 0.5% to your fee wallet. Verify balances moved and the
   escrow's balance returned to zero for that order.

That's the escrow guarantee proven: funds held by the contract from payment until
you release, released only by your signature.

---

## Notes & limits (read before wider testing)

- **Dispute/refund is still off-chain in the UI.** The contract supports
  `raiseDispute` + arbiter `resolve`, but the frontend dispute button currently only
  updates status. Wiring on-chain dispute/refund + arbiter resolution is the next step.
- **No wallet-auth yet.** Anyone can still hit order actions. Fine for you solo;
  add SIWE before outside testers.
- **Mainnet needs an audit.** `SwapEscrow.sol` is unaudited. Testnet is safe (fake
  money); do not move real USDC through it until it's audited.
- **Mobile testers** need Coinbase Wallet's in-app browser (or add WalletConnect
  later). Desktop Coinbase Wallet extension works now.
