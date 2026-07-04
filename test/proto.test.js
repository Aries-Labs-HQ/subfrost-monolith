import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePendingUnwraps,
  decodeSimulateResponse,
  encodeSimulateParcel,
  encodeVarintList,
  writeVarint,
} from '../src/proto.js';
import { encodePendingUnwraps, P2TR_SCRIPT, TXID_A, TXID_B } from './helpers.js';

test('varint encoding matches LEB128', () => {
  assert.deepEqual([...writeVarint(0)], [0]);
  assert.deepEqual([...writeVarint(127)], [0x7f]);
  assert.deepEqual([...writeVarint(128)], [0x80, 0x01]);
  assert.deepEqual([...writeVarint(300)], [0xac, 0x02]);
  assert.deepEqual([...writeVarint(260679n)], [0xc7, 0xf4, 0x0f]);
});

test('cellpack encipher: [32,0,103] -> 200067', () => {
  const bytes = encodeVarintList([32n, 0n, 103n]);
  assert.equal(Buffer.from(bytes).toString('hex'), '200067');
});

test('PendingUnwrapsResponse roundtrip: txid byte order, vout, TxOut', () => {
  const buf = encodePendingUnwraps([
    { txidDisplay: TXID_A, vout: 1, valueSats: 50_000, script: P2TR_SCRIPT },
    { txidDisplay: TXID_B, vout: 0, valueSats: 546, script: P2TR_SCRIPT, fulfilled: true },
  ]);
  const payments = decodePendingUnwraps(buf);
  assert.equal(payments.length, 2);
  assert.equal(payments[0].txid, TXID_A);
  assert.equal(payments[0].vout, 1);
  assert.equal(payments[0].fulfilled, false);
  assert.equal(payments[1].txid, TXID_B);
  assert.equal(payments[1].vout, 0);
  assert.equal(payments[1].fulfilled, true);
});

test('decodePendingUnwraps rejects malformed payments', () => {
  // Payment with no outpoint
  const bad = Uint8Array.from([0x0a, 0x02, 0x18, 0x01]);
  assert.throws(() => decodePendingUnwraps(bad));
});

test('SimulateResponse decode: live signet get_signer response vector', () => {
  // Captured from the running signet rockshrew: simulate [32,0,103]
  const live = Buffer.from(
    '0a221a207940ef3b659179a1371dec05793cb027cde47806fb66ce1e3d1b69d56de629dc10cbea02',
    'hex',
  );
  const { data, gasUsed, error } = decodeSimulateResponse(live);
  assert.equal(error, null);
  assert.equal(gasUsed, 46411n);
  assert.equal(
    Buffer.from(data).toString('hex'),
    '7940ef3b659179a1371dec05793cb027cde47806fb66ce1e3d1b69d56de629dc',
  );
});

test('SimulateResponse decode: error field', () => {
  const err = Buffer.concat([Buffer.from([0x1a, 0x04]), Buffer.from('boom')]);
  assert.equal(decodeSimulateResponse(err).error, 'boom');
});

test('encodeSimulateParcel encodes height + calldata only', () => {
  const parcel = encodeSimulateParcel({ height: 260679, calldata: encodeVarintList([32n, 0n, 103n]) });
  assert.equal(Buffer.from(parcel).toString('hex'), '20c7f40f2a03200067');
});
