import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-store-'));
  return { store: new Store(dir), dir };
}

test('settlement lifecycle: intent -> broadcast -> confirmed, persisted', () => {
  const { store, dir } = tmpStore();
  const key = 'aa'.repeat(32) + ':1';
  store.recordIntent(key, {
    payoutTxid: 'bb'.repeat(32),
    rawTx: 'deadbeef',
    amountSats: 12345n,
    destAddress: 'tb1p...x',
    destScriptHex: '5120' + '07'.repeat(32),
  });
  assert.equal(store.isSettled(key), true);
  store.markBroadcast(key);
  store.markConfirmed(key, 3);

  // reload from disk
  const reloaded = new Store(dir);
  const rec = reloaded.getSettled(key);
  assert.equal(rec.status, 'confirmed');
  assert.equal(rec.rawTx, undefined); // dropped after confirmation
  assert.equal(rec.amountSats, '12345');
  assert.equal(reloaded.summary().confirmed, 1);
});

test('idempotency: cannot record a second intent for a settled receipt', () => {
  const { store } = tmpStore();
  const key = 'aa'.repeat(32) + ':0';
  const intent = {
    payoutTxid: 'bb'.repeat(32),
    rawTx: '00',
    amountSats: 1n,
    destAddress: 'x',
    destScriptHex: '51',
  };
  store.recordIntent(key, intent);
  assert.throws(() => store.recordIntent(key, intent), /already settled/);
});

test('reject / unreject and settled-vs-rejected exclusivity', () => {
  const { store } = tmpStore();
  const key = 'cc'.repeat(32) + ':2';
  store.reject(key, 'dust');
  assert.equal(store.isRejected(key), true);
  assert.equal(store.unreject(key), true);
  assert.equal(store.isRejected(key), false);

  store.recordIntent(key, {
    payoutTxid: 'dd'.repeat(32),
    rawTx: '00',
    amountSats: 1000n,
    destAddress: 'x',
    destScriptHex: '51',
  });
  assert.throws(() => store.reject(key, 'nope'), /already settled/);
});

test('unconfirmedSettlements + ownPayoutTxids', () => {
  const { store } = tmpStore();
  store.recordIntent('aa'.repeat(32) + ':0', {
    payoutTxid: '11'.repeat(32), rawTx: '00', amountSats: 1n, destAddress: 'x', destScriptHex: '51',
  });
  store.recordIntent('bb'.repeat(32) + ':0', {
    payoutTxid: '22'.repeat(32), rawTx: '00', amountSats: 1n, destAddress: 'x', destScriptHex: '51',
  });
  store.markBroadcast('bb'.repeat(32) + ':0');
  store.markConfirmed('bb'.repeat(32) + ':0', 5);
  const unconfirmed = store.unconfirmedSettlements();
  assert.equal(unconfirmed.length, 1);
  assert.equal(unconfirmed[0][0], 'aa'.repeat(32) + ':0');
  assert.deepEqual([...store.ownPayoutTxids()].sort(), ['11'.repeat(32), '22'.repeat(32)]);
});

test('audit log is appended JSONL', () => {
  const { store, dir } = tmpStore();
  store.audit('test.event', { a: 1 });
  store.audit('test.event2', { b: 2 });
  const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event, 'test.event');
  assert.ok(JSON.parse(lines[1]).ts);
});

test('lock refuses second live-pid holder, replaces stale', () => {
  const { store, dir } = tmpStore();
  const release = store.acquireLock();
  const second = new Store(dir);
  assert.throws(() => second.acquireLock(), /another instance/);
  release();
  // stale lock (dead pid)
  fs.writeFileSync(path.join(dir, 'monolith.lock'), '999999999');
  const third = new Store(dir);
  const rel3 = third.acquireLock();
  rel3();
});
