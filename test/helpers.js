// Test helpers: hand-encode protobuf fixtures matching alkanes.proto.

import { writeVarint } from '../src/proto.js';

export function concatBytes(...arrs) {
  return Uint8Array.from(arrs.flatMap((a) => [...a]));
}

export function pbBytes(num, payload) {
  return concatBytes(writeVarint((num << 3) | 2), writeVarint(payload.length), payload);
}

export function pbVarint(num, value) {
  return concatBytes(writeVarint(num << 3), writeVarint(value));
}

/** Consensus-encode a TxOut: 8-byte LE value + compactsize len + script. */
export function encodeTxOut(valueSats, script) {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(valueSats));
  if (script.length >= 0xfd) throw new Error('test helper: script too long');
  return concatBytes(value, Uint8Array.from([script.length]), script);
}

/**
 * Build a PendingUnwrapsResponse protobuf.
 * payments: [{ txidDisplay, vout, valueSats, script, fulfilled }]
 */
export function encodePendingUnwraps(payments) {
  return concatBytes(
    ...payments.map((p) => {
      const txidInternal = Buffer.from(p.txidDisplay, 'hex').reverse();
      const outpoint = concatBytes(
        pbBytes(1, txidInternal),
        ...(p.vout ? [pbVarint(2, p.vout)] : []),
      );
      const payment = concatBytes(
        pbBytes(1, outpoint),
        pbBytes(2, encodeTxOut(p.valueSats, p.script)),
        ...(p.fulfilled ? [pbVarint(3, 1)] : []),
      );
      return pbBytes(1, payment);
    }),
  );
}

export const P2TR_SCRIPT = Uint8Array.from([0x51, 0x20, ...Buffer.alloc(32, 7)]);
export const P2WPKH_SCRIPT = Uint8Array.from([0x00, 0x14, ...Buffer.alloc(20, 9)]);
export const TXID_A = 'aa'.repeat(32);
export const TXID_B = 'ab'.repeat(31) + 'cd';
