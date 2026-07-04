// Single-key P2TR (BIP86 key-path) wallet — the monolith's settlement funds.
//
// SIGNET ONLY. This is a deliberate single point of custody replacing the
// FROST federation for testing; that trade-off is unacceptable on mainnet.

import crypto from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { SIGNET_NETWORK } from './btcodec.js';

export function generatePrivKeyHex() {
  for (;;) {
    const candidate = crypto.randomBytes(32);
    try {
      schnorr.getPublicKey(candidate); // throws on invalid scalar
      return candidate.toString('hex');
    } catch {
      // astronomically rare; retry
    }
  }
}

export class Wallet {
  constructor(privKeyHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(privKeyHex ?? '')) {
      throw new Error('missing/invalid MONOLITH_PRIVKEY_HEX — run `init` first');
    }
    this.privKey = Uint8Array.from(Buffer.from(privKeyHex, 'hex'));
    this.internalPubkey = schnorr.getPublicKey(this.privKey);
    this.payment = btc.p2tr(this.internalPubkey, undefined, SIGNET_NETWORK);
  }

  get address() { return this.payment.address; }
  get script() { return this.payment.script; }
  get internalPubkeyHex() { return Buffer.from(this.internalPubkey).toString('hex'); }

  /**
   * Build + sign a settlement transaction.
   * inputs:  [{ txid, vout, amountSats }] — must be our own P2TR UTXOs.
   * outputs: [{ script, amountSats }] — payout + OP_RETURN marker.
   * Change to our own address is appended unless below dust (then burned to fee).
   * Returns { txid, hex, fee, vsize }.
   */
  buildSettlement({ inputs, outputs, feeRateSatVb }) {
    if (inputs.length === 0) throw new Error('no inputs');
    const inTotal = inputs.reduce((n, u) => n + u.amountSats, 0n);
    const outTotal = outputs.reduce((n, o) => n + o.amountSats, 0n);

    // vbytes: overhead 10.5, P2TR key-path input 57.5, output 9 + script len
    const sizeWith = (nOuts, extraScriptLen) => {
      const outSizes =
        outputs.reduce((n, o) => n + 9 + o.script.length, 0) +
        (nOuts > outputs.length ? 9 + extraScriptLen : 0);
      return Math.ceil(10.5 + inputs.length * 57.5 + outSizes);
    };

    const feeWithChange = BigInt(sizeWith(outputs.length + 1, this.script.length) * feeRateSatVb);
    let fee, withChange, changeAmount = 0n;
    if (inTotal >= outTotal + feeWithChange + 330n) {
      fee = feeWithChange;
      withChange = true;
      changeAmount = inTotal - outTotal - fee;
    } else {
      fee = BigInt(sizeWith(outputs.length, 0) * feeRateSatVb);
      withChange = false;
      if (inTotal < outTotal + fee) {
        throw new Error(`insufficient input value: have ${inTotal}, need ${outTotal + fee}`);
      }
      // any surplus below dust+change-cost is burned to fee
      fee = inTotal - outTotal;
    }

    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    for (const u of inputs) {
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        witnessUtxo: { script: this.script, amount: u.amountSats },
        tapInternalKey: this.internalPubkey,
      });
    }
    for (const o of outputs) tx.addOutput({ script: o.script, amount: o.amountSats });
    if (withChange) tx.addOutput({ script: this.script, amount: changeAmount });

    tx.sign(this.privKey);
    tx.finalize();
    return { txid: tx.id, hex: tx.hex, fee, vsize: tx.vsize };
  }
}
