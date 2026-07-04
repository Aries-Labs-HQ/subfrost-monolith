import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectCoins, settleOne, reconcileSettlements } from '../src/settler.js';
import { Store } from '../src/store.js';
import { Wallet } from '../src/wallet.js';
import { P2TR_SCRIPT, TXID_A, TXID_B } from './helpers.js';

function tmpStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-settler-')));
}

test('selectCoins: skips foreign unconfirmed, accumulates to target+fee', () => {
  const utxos = [
    { txid: '11'.repeat(32), vout: 0, amount: 0.001, confirmations: 0 }, // foreign unconfirmed
    { txid: '22'.repeat(32), vout: 1, amount: 0.0005, confirmations: 3 },
    { txid: '33'.repeat(32), vout: 0, amount: 0.0004, confirmations: 9 },
  ];
  const res = selectCoins(utxos, 60_000n, 2, new Set());
  assert.ok(res);
  assert.equal(res.inputs.length, 2);
  assert.equal(res.total, 90_000n);
  assert.ok(!res.inputs.some((u) => u.txid === '11'.repeat(32)));

  // same unconfirmed utxo is trusted when it's our own payout change
  const own = selectCoins(utxos, 140_000n, 2, new Set(['11'.repeat(32)]));
  assert.ok(own);
  assert.equal(own.total, 150_000n);
  assert.ok(own.inputs.some((u) => u.txid === '11'.repeat(32)));

  assert.equal(selectCoins(utxos, 10_000_000n, 2, new Set()), null);
});

function mockBitcoind({ utxos, broadcasts = [], walletTxs = {} }) {
  return {
    feeRateSatVb: async () => 2,
    listUnspent: async () => utxos,
    broadcast: async (hex) => { broadcasts.push(hex); return { txid: 'x', duplicate: false }; },
    getWalletTx: async (txid) => walletTxs[txid] ?? null,
    broadcasts,
  };
}

const PAYMENT = {
  receiptTxid: TXID_B,
  receiptVout: 1,
  amountSats: 50_000n,
  destScript: P2TR_SCRIPT,
};

test('settleOne: happy path writes intent before broadcast and marks broadcast', async () => {
  const store = tmpStore();
  const wallet = new Wallet('79'.repeat(32));
  const bitcoind = mockBitcoind({
    utxos: [{ txid: TXID_A, vout: 0, amount: 0.01, confirmations: 4 }],
  });
  const res = await settleOne(PAYMENT, { wallet, bitcoind, store, cfg: {}, log: () => {} });
  assert.equal(res.status, 'broadcast');
  assert.equal(bitcoind.broadcasts.length, 1);
  const rec = store.getSettled(`${TXID_B}:1`);
  assert.equal(rec.status, 'broadcast');
  assert.equal(rec.payoutTxid, res.payoutTxid);
  assert.equal(rec.rawTx, bitcoind.broadcasts[0]);
  assert.equal(rec.amountSats, '50000');
});

test('settleOne: empty wallet defers with no broadcast and no settled record', async () => {
  const store = tmpStore();
  const wallet = new Wallet('79'.repeat(32));
  const bitcoind = mockBitcoind({ utxos: [] });
  const res = await settleOne(PAYMENT, { wallet, bitcoind, store, cfg: {}, log: () => {} });
  assert.equal(res.status, 'deferred');
  assert.equal(bitcoind.broadcasts.length, 0);
  assert.equal(store.isSettled(`${TXID_B}:1`), false);
});

test('reconcile: rebroadcasts stored rawTx for crashed intents, promotes confirmed', async () => {
  const store = tmpStore();
  const keyA = 'aa'.repeat(32) + ':0';
  const keyB = 'bb'.repeat(32) + ':0';
  store.recordIntent(keyA, {
    payoutTxid: '11'.repeat(32), rawTx: 'aabb', amountSats: 1000n, destAddress: 'x', destScriptHex: '51',
  }); // crash before broadcast
  store.recordIntent(keyB, {
    payoutTxid: '22'.repeat(32), rawTx: 'ccdd', amountSats: 2000n, destAddress: 'x', destScriptHex: '51',
  });
  store.markBroadcast(keyB);

  const bitcoind = mockBitcoind({
    utxos: [],
    walletTxs: { ['22'.repeat(32)]: { confirmations: 3 } },
  });
  await reconcileSettlements({ bitcoind, store, cfg: { minConfirmations: 2 }, log: () => {} });

  assert.deepEqual(bitcoind.broadcasts, ['aabb']); // exact stored tx, nothing else
  assert.equal(store.getSettled(keyA).status, 'broadcast');
  assert.equal(store.getSettled(keyB).status, 'confirmed');
});
