import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStructure, checkReceiptOnChain, checkDeepVerify, validatePayment, Outcome } from '../src/validate.js';
import { Store } from '../src/store.js';
import { P2TR_SCRIPT, TXID_A } from './helpers.js';

const CFG = {
  minConfirmations: 2,
  maxPayoutSats: 10_000_000n,
  requireSignerMatch: false,
  deepVerify: true,
  esploraUrl: 'https://example.invalid/api',
};

function payment(overrides = {}) {
  return {
    receiptTxid: TXID_A,
    receiptVout: 1,
    amountSats: 50_000n,
    destScript: P2TR_SCRIPT,
    fulfilled: false,
    ...overrides,
  };
}

const SIGNER_SCRIPT_HEX = '5120' + '07'.repeat(32);

function mockBitcoind(utxo) {
  return { getTxOut: async () => utxo };
}

test('structure: valid payment passes', () => {
  assert.equal(checkStructure(payment(), CFG).outcome, Outcome.PAY);
});

test('structure: dust payout is rejected permanently', () => {
  const res = checkStructure(payment({ amountSats: 100n }), CFG);
  assert.equal(res.outcome, Outcome.REJECT);
  assert.match(res.reason, /dust/);
});

test('structure: nonstandard destination is rejected', () => {
  const res = checkStructure(payment({ destScript: Uint8Array.from([0x6a, 0x01, 0x00]) }), CFG);
  assert.equal(res.outcome, Outcome.REJECT);
  assert.match(res.reason, /nonstandard/);
});

test('structure: over-cap payout defers (operator can raise cap)', () => {
  const res = checkStructure(payment({ amountSats: 20_000_000n }), CFG);
  assert.equal(res.outcome, Outcome.DEFER);
  assert.match(res.reason, /MAX_PAYOUT_SATS/);
});

test('receipt: missing from UTXO set defers (never pays)', async () => {
  const res = await checkReceiptOnChain(payment(), {
    bitcoind: mockBitcoind(null), cfg: CFG, signerScriptHex: SIGNER_SCRIPT_HEX,
  });
  assert.equal(res.outcome, Outcome.DEFER);
});

test('receipt: shallow confirmation defers', async () => {
  const res = await checkReceiptOnChain(payment(), {
    bitcoind: mockBitcoind({ confirmations: 1, scriptPubKey: { hex: SIGNER_SCRIPT_HEX } }),
    cfg: CFG, signerScriptHex: SIGNER_SCRIPT_HEX,
  });
  assert.equal(res.outcome, Outcome.DEFER);
  assert.match(res.reason, /confirmations/);
});

test('receipt: bitcoind unreachable defers', async () => {
  const res = await checkReceiptOnChain(payment(), {
    bitcoind: { getTxOut: async () => { throw new Error('ECONNREFUSED'); } },
    cfg: CFG, signerScriptHex: SIGNER_SCRIPT_HEX,
  });
  assert.equal(res.outcome, Outcome.DEFER);
});

test('receipt: signer mismatch warns by default, defers when hardened', async () => {
  const utxo = { confirmations: 5, scriptPubKey: { hex: '5120' + '99'.repeat(32) } };
  const soft = await checkReceiptOnChain(payment(), {
    bitcoind: mockBitcoind(utxo), cfg: CFG, signerScriptHex: SIGNER_SCRIPT_HEX,
  });
  assert.equal(soft.outcome, Outcome.PAY);
  assert.match(soft.warning, /signer mismatch/);

  const hard = await checkReceiptOnChain(payment(), {
    bitcoind: mockBitcoind(utxo),
    cfg: { ...CFG, requireSignerMatch: true },
    signerScriptHex: SIGNER_SCRIPT_HEX,
  });
  assert.equal(hard.outcome, Outcome.DEFER);
});

test('deep verify: esplora down defers; structural mismatch rejects; match pays', async () => {
  const p = payment();
  const destHex = Buffer.from(P2TR_SCRIPT).toString('hex');

  const down = await checkDeepVerify(p, {
    cfg: CFG, fetchJson: async () => { throw new Error('timeout'); },
  });
  assert.equal(down.outcome, Outcome.DEFER);

  const noRunestone = await checkDeepVerify(p, {
    cfg: CFG,
    fetchJson: async () => ({ vout: [{ scriptpubkey: destHex }, { scriptpubkey: SIGNER_SCRIPT_HEX }] }),
  });
  assert.equal(noRunestone.outcome, Outcome.REJECT);

  // signer script here must differ from the dest script or the check would
  // legitimately pass (dest present as an output)
  const destNotOurs = await checkDeepVerify(p, {
    cfg: CFG,
    fetchJson: async () => ({
      vout: [
        { scriptpubkey: '5120' + '55'.repeat(32) },
        { scriptpubkey: '5120' + '99'.repeat(32) },
        { scriptpubkey: '6a5dff' },
      ],
    }),
  });
  assert.equal(destNotOurs.outcome, Outcome.REJECT);

  const good = await checkDeepVerify(p, {
    cfg: CFG,
    fetchJson: async () => ({
      vout: [
        { scriptpubkey: destHex },
        { scriptpubkey: SIGNER_SCRIPT_HEX },
        { scriptpubkey: '6a5dff' },
      ],
    }),
  });
  assert.equal(good.outcome, Outcome.PAY);

  const disabled = await checkDeepVerify(p, {
    cfg: { ...CFG, deepVerify: false },
    fetchJson: async () => { throw new Error('must not be called'); },
  });
  assert.equal(disabled.outcome, Outcome.PAY);
});

test('validatePayment: full pipeline pays a good payment and skips settled ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-val-'));
  const store = new Store(dir);
  const ctx = {
    cfg: CFG,
    store,
    bitcoind: mockBitcoind({ confirmations: 5, scriptPubKey: { hex: SIGNER_SCRIPT_HEX } }),
    signerScriptHex: SIGNER_SCRIPT_HEX,
    fetchJson: async () => ({
      vout: [
        { scriptpubkey: Buffer.from(P2TR_SCRIPT).toString('hex') },
        { scriptpubkey: SIGNER_SCRIPT_HEX },
        { scriptpubkey: '6a5dff' },
      ],
    }),
  };
  const p = payment();
  assert.equal((await validatePayment(p, ctx)).outcome, Outcome.PAY);

  store.recordIntent(`${p.receiptTxid}:${p.receiptVout}`, {
    payoutTxid: 'ee'.repeat(32), rawTx: '00', amountSats: p.amountSats,
    destAddress: 'x', destScriptHex: '51',
  });
  assert.equal((await validatePayment(p, ctx)).outcome, 'already-settled');
});
