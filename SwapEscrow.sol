// server/settlement.js — one switch between test-mode and on-chain settlement.
import { config, q } from './config.js';

// Called when the buyer "pays". In TEST_MODE we settle in the DB directly:
//  - digital  -> released immediately (instant delivery)
//  - physical/service -> funded (enters escrow lifecycle)
// On-chain: the buyer's wallet funds the contract; the watcher flips state.
export async function settleFunding(order) {
  if (config.testMode) {
    if (order.kind === 'digital') {
      await q(`UPDATE orders SET state='released', funded_at=now(), released_at=now(),
                 tx_fund='TEST', tx_release='TEST' WHERE id=$1`, [order.id]);
      return { state: 'released', test: true };
    }
    await q(`UPDATE orders SET state='funded', funded_at=now(), tx_fund='TEST' WHERE id=$1`, [order.id]);
    return { state: 'funded', test: true };
  }
  return { state: 'created', onchain: true, escrow: config.chain.escrow, token: config.chain.usdc };
}

// Called when the buyer confirms delivery / approves work.
export async function settleRelease(order) {
  if (config.testMode) {
    await q(`UPDATE orders SET state='released', released_at=now(), tx_release='TEST'
               WHERE id=$1 AND state IN ('funded','shipped','submitted','in_progress','disputed')`, [order.id]);
    return { state: 'released', test: true };
  }
  return { onchain: true, escrow: config.chain.escrow, onchain_order_id: order.onchain_order_id, call: 'release' };
}
