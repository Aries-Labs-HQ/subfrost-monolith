// Minimal protobuf wire-format codec — just enough for the alkanes views we use.
//
// Schemas (from alkanes-rs crates/alkanes-support/proto/alkanes.proto):
//   message Outpoint               { bytes txid = 1; uint32 vout = 2; }
//   message Payment                { Outpoint spendable = 1; bytes output = 2; bool fulfilled = 3; }
//   message PendingUnwrapsResponse { repeated Payment payments = 1; }
//   message MessageContextParcel   { ... uint64 height = 4; bytes calldata = 5; ... }
//   message KeyValuePair           { bytes key = 1; bytes value = 2; }
//   message ExtendedCallResponse   { repeated AlkaneTransfer alkanes = 1; repeated KeyValuePair storage = 2; bytes data = 3; }
//   message SimulateResponse       { ExtendedCallResponse execution = 1; uint64 gas_used = 2; string error = 3; }

export function writeVarint(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error('varint must be non-negative');
  const out = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return Uint8Array.from(out);
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function fieldBytes(num, payload) {
  return concat(writeVarint((num << 3) | 2), writeVarint(payload.length), payload);
}

function fieldVarint(num, value) {
  return concat(writeVarint(num << 3), writeVarint(value));
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get done() { return this.pos >= this.buf.length; }
  varint() {
    let shift = 0n, result = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }
  bytes() {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.length) throw new Error('truncated bytes field');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  // Iterate (fieldNumber, wireType) and dispatch; unknown fields are skipped.
  fields(handlers) {
    while (!this.done) {
      const tag = Number(this.varint());
      const num = tag >> 3, wire = tag & 7;
      const handler = handlers[num];
      if (wire === 2) {
        const payload = this.bytes();
        if (handler) handler(payload);
      } else if (wire === 0) {
        const v = this.varint();
        if (handler) handler(v);
      } else if (wire === 5) {
        this.pos += 4;
      } else if (wire === 1) {
        this.pos += 8;
      } else {
        throw new Error(`unsupported wire type ${wire}`);
      }
    }
  }
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function reverseHex(bytes) {
  return Buffer.from(bytes).reverse().toString('hex');
}

/**
 * Decode PendingUnwrapsResponse.
 * Returns [{ txid, vout, outputRaw, fulfilled }] where:
 *   - txid is DISPLAY order (as used by bitcoind RPC / explorers); the proto
 *     carries internal byte order, so we reverse it here.
 *   - outputRaw is the consensus-encoded TxOut (value + scriptPubKey) still
 *     to be decoded by btcodec.decodeTxOut.
 */
export function decodePendingUnwraps(buf) {
  const payments = [];
  new Reader(buf).fields({
    1: (paymentBytes) => {
      let txidInternal = null, vout = 0, outputRaw = null, fulfilled = false;
      new Reader(paymentBytes).fields({
        1: (outpointBytes) => {
          new Reader(outpointBytes).fields({
            1: (txidBytes) => { txidInternal = txidBytes; },
            2: (v) => { vout = Number(v); },
          });
        },
        2: (outBytes) => { outputRaw = outBytes; },
        3: (v) => { fulfilled = v !== 0n; },
      });
      if (txidInternal === null || txidInternal.length !== 32 || outputRaw === null) {
        throw new Error('malformed Payment in PendingUnwrapsResponse');
      }
      payments.push({ txid: reverseHex(txidInternal), vout, outputRaw, fulfilled });
    },
  });
  return payments;
}

/** LEB128 varint list — the alkanes Cellpack::encipher() encoding. */
export function encodeVarintList(values) {
  return concat(...values.map((v) => writeVarint(v)));
}

/**
 * Encode a minimal MessageContextParcel for the `simulate` metashrew view.
 * The deployed signet WASM takes the raw protobuf (no height prefix); empty
 * block/transaction fields are filled with defaults inside the view.
 */
export function encodeSimulateParcel({ height, calldata }) {
  return concat(fieldVarint(4, height), fieldBytes(5, calldata));
}

/** Decode SimulateResponse → { data: Uint8Array|null, gasUsed: bigint, error: string|null }. */
export function decodeSimulateResponse(buf) {
  let data = null, gasUsed = 0n, error = null;
  new Reader(buf).fields({
    1: (execBytes) => {
      new Reader(execBytes).fields({
        3: (d) => { data = d; },
      });
    },
    2: (v) => { gasUsed = v; },
    3: (e) => { error = Buffer.from(e).toString('utf8'); },
  });
  return { data, gasUsed, error };
}

export { toHex };
