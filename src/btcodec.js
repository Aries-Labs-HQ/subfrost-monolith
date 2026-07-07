// Bitcoin consensus decoding + script utilities for the pieces we need.

import * as btc from '@scure/btc-signer';

// Signet uses testnet address encoding (tb1..., m/n/2 prefixes).
export const SIGNET_NETWORK = btc.TEST_NETWORK;

function readCompactSize(buf, pos) {
  const first = buf[pos];
  if (first === undefined) throw new Error('truncated compact size');
  if (first < 0xfd) return [BigInt(first), pos + 1];
  if (first === 0xfd) {
    return [BigInt(buf[pos + 1] | (buf[pos + 2] << 8)), pos + 3];
  }
  if (first === 0xfe) {
    let v = 0n;
    for (let i = 0; i < 4; i++) v |= BigInt(buf[pos + 1 + i]) << BigInt(8 * i);
    return [v, pos + 5];
  }
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(buf[pos + 1 + i]) << BigInt(8 * i);
  return [v, pos + 9];
}

/**
 * Decode a consensus-encoded TxOut (8-byte LE value + compact-size script len
 * + scriptPubKey) — the `output` field of an unwrap Payment.
 */
export function decodeTxOut(buf) {
  if (buf.length < 9) throw new Error('TxOut too short');
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(buf[i]) << BigInt(8 * i);
  const [scriptLen, scriptStart] = readCompactSize(buf, 8);
  const end = scriptStart + Number(scriptLen);
  if (end !== buf.length) throw new Error('TxOut has trailing/missing bytes');
  return { value, script: buf.subarray(scriptStart, end) };
}

/** Classify a scriptPubKey; returns { type, address } or { type: 'unknown', address: null }. */
export function classifyScript(script) {
  try {
    const decoded = btc.OutScript.decode(script);
    let address = null;
    try {
      address = btc.Address(SIGNET_NETWORK).encode(decoded);
    } catch {
      // some decodable scripts (e.g. op_return) have no address form
    }
    return { type: decoded.type, address };
  } catch {
    return { type: 'unknown', address: null };
  }
}

const PAYABLE_TYPES = new Set(['tr', 'wpkh', 'wsh', 'pkh', 'sh']);

export function isStandardPayable(script) {
  return PAYABLE_TYPES.has(classifyScript(script).type);
}

/** Bitcoin Core standardness dust threshold for an output paying `script`. */
export function dustThreshold(script) {
  const { type } = classifyScript(script);
  if (type === 'tr' || type === 'wsh') return 330n;
  if (type === 'wpkh') return 294n;
  return 546n;
}

/** P2TR output script for an x-only pubkey used AS the output key (OP_1 <32B>). */
export function p2trOutputKeyScript(xonlyPubkeyHex) {
  const key = Buffer.from(xonlyPubkeyHex, 'hex');
  if (key.length !== 32) throw new Error('x-only pubkey must be 32 bytes');
  // BIP341: the on-chain P2TR *output key* is the INTERNAL x-only key TWEAKED
  // (key-path spend, empty script tree) — NOT the raw internal key. frBTC's
  // get_signer(103) returns the INTERNAL key, and its receipt output is a
  // key-path P2TR (tap_tweak with no merkle root), so we must apply the same
  // tweak to reproduce the receipt's real scriptPubKey `OP_1 <tweaked key>`.
  // Emitting `OP_1 <raw key>` here made the signer-match check mismatch on every
  // legitimate receipt — harmless while warn-only, but REQUIRE_SIGNER_MATCH=true
  // would then DEFER every receipt forever. btc.p2tr does the BIP341 tweak (same
  // derivation as Wallet in wallet.js); the script is network-independent.
  return btc.p2tr(key, undefined, SIGNET_NETWORK).script;
}

/** OP_RETURN audit marker: "SFM1" + receipt txid (internal order) + vout LE32. */
export function settlementMarkerScript(receiptTxidDisplay, receiptVout) {
  const txidInternal = Buffer.from(receiptTxidDisplay, 'hex').reverse();
  if (txidInternal.length !== 32) throw new Error('bad receipt txid');
  const voutLe = Buffer.alloc(4);
  voutLe.writeUInt32LE(receiptVout);
  const payload = Buffer.concat([Buffer.from('SFM1', 'ascii'), txidInternal, voutLe]);
  return Uint8Array.from([0x6a, payload.length, ...payload]);
}

export function outpointKey(txidDisplay, vout) {
  return `${txidDisplay}:${vout}`;
}
