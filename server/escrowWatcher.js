// server/escrowWatcher.js — chain is the source of truth for escrow state.
// Run as a separate Render worker: `node server/escrowWatcher.js`
import { JsonRpcProvider, Contract } from 'ethers';
import { q, config } from './config.js';

const ABI = [
  // These signatures MUST match SwapEscrow.sol byte for byte. A changed
  // signature is a changed topic hash, and the listener just silently never
  // fires again — no error, no log, the DB simply stops tracking reality.
  'event Funded(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 deliverBy)',
  'event Delivered(bytes32 indexed orderId, uint64 claimAfter)',
  'event Released(bytes32 indexed orderId, uint256 toSeller, uint256 fee)',
  'event Refunded(bytes32 indexed orderId, uint256 amount)',
  'event Disputed(bytes32 indexed orderId, address by)',
];

const provider = new JsonRpcProvider(config.chain.rpcUrl);
const escrow   = new Contract(config.chain.escrow, ABI, provider);

async function setStateByOnchainId(onchainId, state, patch = {}) {
  const cols = ['state = $2'], params = [onchainId, state];
  for (const [k, v] of Object.entries(patch)) { params.push(v); cols.push(`${k} = $${params.length}`); }
  await q(`UPDATE orders SET ${cols.join(', ')} WHERE onchain_order_id = $1`, params);
}

escrow.on('Funded', async (orderId) => {
  await setStateByOnchainId(orderId, 'funded', { funded_at: new Date() });
  console.log('funded', orderId);
});

escrow.on('Delivered', async (orderId) => {
  // The seller staked their delivery claim on-chain. The app normally writes
  // this itself right after the tx, but if that write failed the chain still
  // moved — this heals the DB. Only advance from 'funded' so we never drag an
  // order backwards from a later state.
  await q(
    `UPDATE orders
        SET state = CASE WHEN kind = 'service' THEN 'submitted' ELSE 'shipped' END
      WHERE onchain_order_id = $1 AND state = 'funded'`, [orderId]);
  console.log('delivered', orderId);
});

escrow.on('Released', async (orderId, toSeller, fee, ev) => {
  // On release, digital orders become deliverable (payments route checks state='released').
  await setStateByOnchainId(orderId, 'released', {
    released_at: new Date(),
    tx_release: ev?.log?.transactionHash || null,
  });
  console.log('released', orderId);
});

escrow.on('Refunded', async (orderId) => {
  await setStateByOnchainId(orderId, 'refunded');
  console.log('refunded', orderId);
});

escrow.on('Disputed', async (orderId) => {
  await setStateByOnchainId(orderId, 'disputed');
  console.log('disputed', orderId);
});

console.log(`escrowWatcher listening on ${config.chain.name} @ ${config.chain.escrow}`);
