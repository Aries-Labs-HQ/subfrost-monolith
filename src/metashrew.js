// Reads from the signet rockshrew/metashrew index: heights, the `unwrap`
// pending-payments view, and frBTC get_signer via the `simulate` view.

import { makeClient } from './jsonrpc.js';
import {
  decodePendingUnwraps,
  decodeSimulateResponse,
  encodeSimulateParcel,
  encodeVarintList,
} from './proto.js';
import { decodeTxOut } from './btcodec.js';

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

export class Metashrew {
  constructor(cfg) {
    this.cfg = cfg;
    this.call = makeClient({
      url: cfg.metashrewUrl,
      extraHeaders: cfg.subfrostApiKey ? { 'x-subfrost-api-key': cfg.subfrostApiKey } : {},
    });
  }

  async height() {
    return Number(await this.call('metashrew_height', []));
  }

  /**
   * Pending unwrap payments as of the indexed chain (view name "unwrap").
   * Input is the height as LE u32; the view returns every queued payment whose
   * receipt outpoint is still unspent according to the index.
   */
  async pendingUnwraps(height) {
    const input = Buffer.alloc(4);
    input.writeUInt32LE(height);
    const hex = await this.call('metashrew_view', ['unwrap', '0x' + input.toString('hex'), 'latest']);
    const raw = hexToBytes(hex);
    if (raw.length === 0) return [];
    return decodePendingUnwraps(raw).map((p) => {
      const { value, script } = decodeTxOut(p.outputRaw);
      return {
        receiptTxid: p.txid,
        receiptVout: p.vout,
        amountSats: value,
        destScript: script,
        fulfilled: p.fulfilled,
      };
    });
  }

  /** frBTC get_signer (opcode 103) via the `simulate` view. Returns x-only pubkey hex or null. */
  async getSignerPubkey(height) {
    const calldata = encodeVarintList([this.cfg.frbtc.block, this.cfg.frbtc.tx, this.cfg.opGetSigner]);
    const parcel = encodeSimulateParcel({ height, calldata });
    const hex = await this.call('metashrew_view', ['simulate', '0x' + Buffer.from(parcel).toString('hex'), 'latest']);
    const { data, error } = decodeSimulateResponse(hexToBytes(hex));
    if (error || !data || data.length < 32) return null;
    return Buffer.from(data.subarray(0, 32)).toString('hex');
  }
}
