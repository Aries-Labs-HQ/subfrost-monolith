import test from 'node:test';
import assert from 'node:assert/strict';
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

test('p2trOutputKeyScript builds OP_1 <32B>', () => {
  const script = p2trOutputKeyScript('07'.repeat(32));
  assert.deepEqual([...script], [...P2TR_SCRIPT]);
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
