import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import {
  decodeTxOut,
  classifyScript,
  dustThreshold,
  isStandardPayable,
  p2trOutputKeyScript,
  settlementMarkerScript,
  outpointKey,
} from '../src/btcodec.js';
import { encodeTxOut, P2TR_SCRIPT, P2WPKH_SCRIPT, TXID_A } from './helpers.js';

test('decodeTxOut: value + script', () => {
  const { value, script } = decodeTxOut(encodeTxOut(123_456_789, P2TR_SCRIPT));
  assert.equal(value, 123_456_789n);
  assert.deepEqual([...script], [...P2TR_SCRIPT]);
});

test('decodeTxOut rejects trailing bytes', () => {
  const buf = Uint8Array.from([...encodeTxOut(1000, P2TR_SCRIPT), 0x00]);
  assert.throws(() => decodeTxOut(buf));
});

test('classifyScript: p2tr address on signet is tb1p...', () => {
  const { type, address } = classifyScript(P2TR_SCRIPT);
  assert.equal(type, 'tr');
  assert.match(address, /^tb1p/);
});

test('standard payable + dust thresholds', () => {
  assert.equal(isStandardPayable(P2TR_SCRIPT), true);
  assert.equal(isStandardPayable(Uint8Array.from([0x6a, 0x01, 0x00])), false);
  assert.equal(dustThreshold(P2TR_SCRIPT), 330n);
  assert.equal(dustThreshold(P2WPKH_SCRIPT), 294n);
});

test('p2trOutputKeyScript tweaks the internal key to the BIP341 output key', () => {
  const internal = '07'.repeat(32);
  const script = p2trOutputKeyScript(internal);
  // Structurally OP_1 <32-byte output key>.
  assert.equal(script[0], 0x51);
  assert.equal(script[1], 0x20);
  assert.equal(script.length, 34);
  // Regression guard: must NOT emit the RAW internal key (the old bug that made
  // the signer-match check mismatch every legitimate receipt).
  assert.notDeepEqual([...script.subarray(2)], [...Buffer.from(internal, 'hex')]);
  // It must be the taproot-tweaked output key — same derivation as Wallet.
  const expected = btc.p2tr(Buffer.from(internal, 'hex'), undefined, btc.TEST_NETWORK).script;
  assert.deepEqual([...script], [...expected]);
});

test('settlement marker: OP_RETURN SFM1 + internal txid + vout', () => {
  const script = settlementMarkerScript(TXID_A, 7);
  assert.equal(script[0], 0x6a);
  assert.equal(script[1], 40);
  const payload = Buffer.from(script.subarray(2));
  assert.equal(payload.subarray(0, 4).toString('ascii'), 'SFM1');
  assert.equal(payload.subarray(4, 36).toString('hex'), 'aa'.repeat(32));
  assert.equal(payload.readUInt32LE(36), 7);
});

test('outpointKey format', () => {
  assert.equal(outpointKey(TXID_A, 3), `${TXID_A}:3`);
});
