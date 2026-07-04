// The SETTLE step: coin-select from our own P2TR wallet, build/sign a payout
// transaction (payout + OP_RETURN receipt marker + change), write-ahead the
// signed tx, broadcast, and recover cleanly across restarts.

import { classifyScript, outpointKey, settlementMarkerScript } from './btcodec.js';

/**
 * Pick our UTXOs to cover `targetSats` plus fees. Unconfirmed UTXOs are only
 * trusted when they are change from our OWN prior settlements.
 */
export function selectCoins(utxos, targetSats, feeRateSatVb, ownTxids) {
  const spendable = utxos
    .filter((u) => u.confirmations > 0 || ownTxids.has(u.txid))
    .map((u) => ({ txid: u.txid, vout: u.vout, amountSats: BigInt(Math.round(u.amount * 1e8)) }))
    .sort((a, b) => (b.amountSats > a.amountSats ? 1 : b.amountSats < a.amountSats ? -1 : 0));

  const picked = [];
  let total = 0n;
  for (const u of spendable) {
    picked.push(u);
    total += u.amountSats;
    // conservative fee bound: current inputs + 3 outputs (payout/opreturn/change)
    const feeBound = BigInt(Math.ceil(10.5 + picked.length * 57.5 + 3 * 52) * feeRateSatVb);
    if (total >= targetSats + feeBound) return { inputs: picked, total };
  }
  return null;
}

export async function settleOne(payment, { wallet, bitcoind, store, cfg, log }) {
  const key = outpointKey(payment.receiptTxid, payment.receiptVout);
  const { address: destAddress } = classifyScript(payment.destScript);

  const feeRate = await bitcoind.feeRateSatVb();
  const utxos = await bitcoind.listUnspent();
  const selection = selectCoins(utxos, payment.amountSats, feeRate, store.ownPayoutTxids());
  if (!selection) {
    store.audit('settle.deferred', {
      receipt: key,
      reason: 'insufficient wallet funds',
      neededSats: payment.amountSats.toString(),
    });
    log(`DEFER ${key}: insufficient funds for ${payment.amountSats} sats — fund ${wallet.address}`);
    return { status: 'deferred', reason: 'insufficient-funds' };
  }

  const { txid, hex, fee, vsize } = wallet.buildSettlement({
    inputs: selection.inputs,
    outputs: [
      { script: payment.destScript, amountSats: payment.amountSats },
      { script: settlementMarkerScript(payment.receiptTxid, payment.receiptVout), amountSats: 0n },
    ],
    feeRateSatVb: feeRate,
  });

  // WRITE-AHEAD: persist the signed tx before broadcasting. A crash after
  // this point re-broadcasts this exact tx (same txid); it can never pay twice.
  store.recordIntent(key, {
    payoutTxid: txid,
    rawTx: hex,
    amountSats: payment.amountSats,
    destAddress,
    destScriptHex: Buffer.from(payment.destScript).toString('hex'),
  });

  await bitcoind.broadcast(hex);
  store.markBroadcast(key);
  log(
    `SETTLED ${key} -> ${destAddress} ${payment.amountSats} sats ` +
      `(payout tx ${txid}, fee ${fee} sats, ${vsize} vB)`,
  );
  return { status: 'broadcast', payoutTxid: txid };
}

/**
 * Startup / per-cycle recovery:
 *  - 'broadcast-pending' records (crash between write-ahead and broadcast)
 *    are rebroadcast from the stored signed tx.
 *  - 'broadcast' records are checked for confirmations and promoted.
 */
export async function reconcileSettlements({ bitcoind, store, cfg, log }) {
  for (const [key, rec] of store.unconfirmedSettlements()) {
    const walletTx = await bitcoind.getWalletTx(rec.payoutTxid);
    if (walletTx && walletTx.confirmations >= cfg.minConfirmations) {
      store.markConfirmed(key, walletTx.confirmations);
      log(`CONFIRMED ${key} (payout tx ${rec.payoutTxid}, ${walletTx.confirmations} conf)`);
      continue;
    }
    if (walletTx && walletTx.confirmations >= 0) continue; // in mempool or shallow; wait

    // Unknown to the wallet, or conflicted (confirmations < 0): rebroadcast
    // the exact stored transaction. Same txid — idempotent.
    if (!rec.rawTx) {
      log(`WARN ${key}: settlement ${rec.payoutTxid} missing rawTx and not in wallet; manual review`);
      store.audit('settle.recovery-missing-rawtx', { receipt: key, payoutTxid: rec.payoutTxid });
      continue;
    }
    try {
      await bitcoind.broadcast(rec.rawTx);
      store.markBroadcast(key);
      log(`REBROADCAST ${key} (payout tx ${rec.payoutTxid})`);
    } catch (err) {
      // e.g. missing inputs after a conflicting spend — needs the operator.
      store.audit('settle.recovery-failed', {
        receipt: key,
        payoutTxid: rec.payoutTxid,
        error: err.message,
      });
      log(`WARN ${key}: rebroadcast failed: ${err.message}`);
    }
  }
}
