// The MATCH step — the security boundary.
//
// A pending payment from the unwrap view is only paid when every check
// passes. Checks that can't currently be evaluated (endpoint down, receipt
// not deep enough yet) DEFER the payment — it stays queued and is retried
// next cycle. Structurally-broken payments are REJECTED permanently.
//
// What ties a payout to a real, confirmed frBTC burn:
//   1. The payment came from the metashrew `unwrap` view — the indexer only
//      queues a Payment when it has indexed an actual opcode-78 burn, and it
//      records the burn tx's receipt outpoint ("spendable") alongside the
//      exact payout TxOut. This is Flex's "match the receipt outpoints to an
//      unwrap" — the view IS the rollup of receipts to unwraps.
//   2. We then independently confirm the receipt outpoint on bitcoind
//      (gettxout): it must exist, be unspent, and be >= MIN_CONFIRMATIONS
//      deep. This anchors the indexer's claim to the actual signet chain.
//   3. Optionally (DEEP_VERIFY) we fetch the unwrap transaction from esplora
//      and check its structure: it carries a runestone OP_RETURN and the
//      payout destination script is one of its own outputs (the unwrap
//      pointer output), and the receipt vout matches what gettxout returned.
//   4. The receipt outpoint's scriptPubKey should pay the frBTC signer key
//      (OP_1 <get_signer x-only>). Warn-only by default (REQUIRE_SIGNER_MATCH
//      hardens it) because signer rotation would strand old receipts.

import { classifyScript, dustThreshold, isStandardPayable, outpointKey } from './btcodec.js';

export const Outcome = Object.freeze({ PAY: 'pay', DEFER: 'defer', REJECT: 'reject' });

export function checkStructure(payment, cfg) {
  if (!/^[0-9a-f]{64}$/.test(payment.receiptTxid)) {
    return { outcome: Outcome.REJECT, reason: 'malformed receipt txid' };
  }
  if (!Number.isInteger(payment.receiptVout) || payment.receiptVout < 0) {
    return { outcome: Outcome.REJECT, reason: 'malformed receipt vout' };
  }
  if (payment.amountSats <= 0n) {
    return { outcome: Outcome.REJECT, reason: 'non-positive payout amount' };
  }
  if (!isStandardPayable(payment.destScript)) {
    return {
      outcome: Outcome.REJECT,
      reason: `nonstandard destination script (${classifyScript(payment.destScript).type})`,
    };
  }
  if (payment.amountSats < dustThreshold(payment.destScript)) {
    return {
      outcome: Outcome.REJECT,
      reason: `payout ${payment.amountSats} below dust threshold ${dustThreshold(payment.destScript)}`,
    };
  }
  if (payment.amountSats > cfg.maxPayoutSats) {
    // operator may raise the cap, so this defers instead of rejecting
    return {
      outcome: Outcome.DEFER,
      reason: `payout ${payment.amountSats} exceeds MAX_PAYOUT_SATS ${cfg.maxPayoutSats}`,
    };
  }
  return { outcome: Outcome.PAY };
}

export async function checkReceiptOnChain(payment, { bitcoind, cfg, signerScriptHex }) {
  let utxo;
  try {
    utxo = await bitcoind.getTxOut(payment.receiptTxid, payment.receiptVout);
  } catch (err) {
    return { outcome: Outcome.DEFER, reason: `bitcoind unreachable: ${err.message}` };
  }
  if (utxo === null) {
    // Receipt not in the confirmed UTXO set: unconfirmed, spent, or the
    // indexer and node disagree. Either way: do not pay, wait.
    return { outcome: Outcome.DEFER, reason: 'receipt outpoint not found unspent in UTXO set' };
  }
  if (utxo.confirmations < cfg.minConfirmations) {
    return {
      outcome: Outcome.DEFER,
      reason: `receipt has ${utxo.confirmations} confirmations, need ${cfg.minConfirmations}`,
    };
  }
  const receiptScriptHex = utxo.scriptPubKey?.hex ?? null;
  if (signerScriptHex && receiptScriptHex !== signerScriptHex) {
    const detail = `receipt script ${receiptScriptHex} != signer script ${signerScriptHex}`;
    if (cfg.requireSignerMatch) {
      return { outcome: Outcome.DEFER, reason: `signer mismatch (REQUIRE_SIGNER_MATCH): ${detail}` };
    }
    return { outcome: Outcome.PAY, warning: `signer mismatch (soft): ${detail}`, receiptScriptHex };
  }
  return { outcome: Outcome.PAY, receiptScriptHex };
}

export async function checkDeepVerify(payment, { cfg, fetchJson }) {
  if (!cfg.deepVerify) return { outcome: Outcome.PAY, skipped: true };
  let tx;
  try {
    tx = await fetchJson(`${cfg.esploraUrl}/tx/${payment.receiptTxid}`);
  } catch (err) {
    // fail-safe: deep verification is enabled but unavailable -> wait
    return { outcome: Outcome.DEFER, reason: `esplora unreachable: ${err.message}` };
  }
  const vouts = tx?.vout;
  if (!Array.isArray(vouts) || vouts.length <= payment.receiptVout) {
    return { outcome: Outcome.REJECT, reason: 'unwrap tx has no output at receipt vout' };
  }
  const hasRunestone = vouts.some((o) => (o.scriptpubkey ?? '').startsWith('6a5d'));
  if (!hasRunestone) {
    return { outcome: Outcome.REJECT, reason: 'unwrap tx carries no runestone OP_RETURN (6a5d)' };
  }
  const destHex = Buffer.from(payment.destScript).toString('hex');
  const destIsOwnOutput = vouts.some((o) => o.scriptpubkey === destHex);
  if (!destIsOwnOutput) {
    return {
      outcome: Outcome.REJECT,
      reason: 'payout destination script is not an output of the unwrap tx',
    };
  }
  return { outcome: Outcome.PAY };
}

/**
 * Run the full check pipeline for one pending payment.
 * Returns { outcome, reasons: [...], warnings: [...] }.
 */
export async function validatePayment(payment, ctx) {
  const warnings = [];
  const key = outpointKey(payment.receiptTxid, payment.receiptVout);

  if (ctx.store.isSettled(key)) {
    return { outcome: 'already-settled', reasons: [], warnings };
  }
  if (ctx.store.isRejected(key)) {
    return { outcome: 'already-rejected', reasons: [], warnings };
  }

  for (const step of [
    () => checkStructure(payment, ctx.cfg),
    () => checkReceiptOnChain(payment, ctx),
    () => checkDeepVerify(payment, ctx),
  ]) {
    const res = await step();
    if (res.warning) warnings.push(res.warning);
    if (res.outcome !== Outcome.PAY) {
      return { outcome: res.outcome, reasons: [res.reason], warnings };
    }
  }
  return { outcome: Outcome.PAY, reasons: [], warnings };
}
