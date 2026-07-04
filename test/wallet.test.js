import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { Wallet, generatePrivKeyHex } from '../src/wallet.js';
import { settlementMarkerScript } from '../src/btcodec.js';
import { P2TR_SCRIPT, TXID_A, TXID_B } from './helpers.js';

test('generatePrivKeyHex yields valid distinct keys', () => {
  const a = generatePrivKeyHex();
  const b = generatePrivKeyHex();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  new Wallet(a); // must not throw
});

test('deterministic key -> deterministic signet P2TR address', () => {
  const w = new Wallet('79'.repeat(32));
  assert.equal(w.address, 'tb1pnqrhsj9qvwgc4urnqjprv29upyhxt6nm7s7n4mhthfswzzk6g8yq9ulp4z');
  assert.match(w.address, /^tb1p/);
});

test('buildSettlement: payout + marker + change, decodable, fee sane', () => {
  const w = new Wallet('79'.repeat(32));
  const feeRate = 2;
  const { txid, hex, fee, vsize } = w.buildSettlement({
    inputs: [{ txid: TXID_A, vout: 0, amountSats: 1_000_000n }],
    outputs: [
      { script: P2TR_SCRIPT, amountSats: 250_000n },
      { script: settlementMarkerScript(TXID_B, 1), amountSats: 0n },
    ],
    feeRateSatVb: feeRate,
  });
  assert.match(txid, /^[0-9a-f]{64}$/);
  const tx = btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });
  assert.equal(tx.inputsLength, 1);
  assert.equal(tx.outputsLength, 3);
  assert.equal(Buffer.from(tx.getOutput(0).script).toString('hex'), Buffer.from(P2TR_SCRIPT).toString('hex'));
  assert.equal(tx.getOutput(0).amount, 250_000n);
  assert.equal(tx.getOutput(1).amount, 0n);
  assert.equal(Buffer.from(tx.getOutput(2).script).toString('hex'), Buffer.from(w.script).toString('hex'));
  assert.equal(1_000_000n - 250_000n - tx.getOutput(2).amount, fee);
  // fee ≈ vsize * rate (estimate may overshoot slightly, never undershoot badly)
  assert.ok(fee >= BigInt(vsize * feeRate) - 5n, `fee ${fee} vs vsize*rate ${vsize * feeRate}`);
  assert.ok(fee <= BigInt(vsize * feeRate) + 20n);
});

test('buildSettlement: sub-dust surplus burned to fee (no change output)', () => {
  const w = new Wallet('79'.repeat(32));
  const { hex, fee } = w.buildSettlement({
    inputs: [{ txid: TXID_A, vout: 0, amountSats: 250_500n }],
    outputs: [{ script: P2TR_SCRIPT, amountSats: 250_000n }],
    feeRateSatVb: 2,
  });
  const tx = btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownOutputs: true });
  assert.equal(tx.outputsLength, 1);
  assert.equal(fee, 500n);
});

test('buildSettlement: insufficient funds throws (never underpays)', () => {
  const w = new Wallet('79'.repeat(32));
  assert.throws(
    () =>
      w.buildSettlement({
        inputs: [{ txid: TXID_A, vout: 0, amountSats: 100_000n }],
        outputs: [{ script: P2TR_SCRIPT, amountSats: 100_000n }],
        feeRateSatVb: 2,
      }),
    /insufficient input value/,
  );
});
