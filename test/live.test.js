// Live integration tests against the LOCAL signet stack (read-only).
// Run with: LIVE=1 node --test test/
//
// NOTE: full end-to-end settlement (real unwrap -> payout) is PENDING the
// local metashrew index reaching the signet tip — see README "Testing".

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Metashrew } from '../src/metashrew.js';
import { Bitcoind } from '../src/bitcoind.js';

const LIVE = process.env.LIVE === '1';

test('live: metashrew reachable and unwrap view decodes', { skip: !LIVE }, async () => {
  const cfg = loadConfig();
  const ms = new Metashrew(cfg);
  const height = await ms.height();
  assert.ok(height > 0);
  const pending = await ms.pendingUnwraps(height);
  assert.ok(Array.isArray(pending));
  for (const p of pending) {
    assert.match(p.receiptTxid, /^[0-9a-f]{64}$/);
    assert.ok(p.amountSats > 0n);
  }
  console.log(`  metashrew height ${height}, ${pending.length} pending unwraps (as indexed)`);
});

test('live: frBTC get_signer via simulate view', { skip: !LIVE }, async () => {
  const cfg = loadConfig();
  const ms = new Metashrew(cfg);
  const signer = await ms.getSignerPubkey(await ms.height());
  assert.match(signer, /^[0-9a-f]{64}$/);
  console.log(`  signer pubkey: ${signer}`);
});

test('live: bitcoind is signet and reachable', { skip: !LIVE }, async () => {
  const cfg = loadConfig();
  const bd = new Bitcoind(cfg);
  const info = await bd.assertSignet();
  assert.equal(info.chain, 'signet');
});

test('live: index lag is reported', { skip: !LIVE }, async () => {
  const cfg = loadConfig();
  const [btcHeight, msHeight] = await Promise.all([
    new Bitcoind(cfg).call('getblockcount'),
    new Metashrew(cfg).height(),
  ]);
  console.log(`  bitcoind ${btcHeight}, metashrew ${msHeight}, lag ${btcHeight - msHeight}`);
  assert.ok(msHeight <= btcHeight);
});

// ---------------------------------------------------------------------------
// PENDING TIP-SYNC: real end-to-end settlement test.
// Once the metashrew index reaches the signet tip:
//   1. fund the monolith wallet (node src/index.js address)
//   2. perform a real frBTC unwrap (opcode 78 burn) from the app wallet
//   3. wait MIN_CONFIRMATIONS blocks
//   4. node src/index.js once  -> expect "1 paid"
//   5. verify payout tx on mempool.space/signet and settle store state
// ---------------------------------------------------------------------------
test.todo('e2e: settle a real signet unwrap (blocked: metashrew index behind tip)');
