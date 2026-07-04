// The WATCH -> MATCH -> SETTLE cycle.

import { p2trOutputKeyScript, outpointKey, classifyScript } from './btcodec.js';
import { validatePayment, Outcome } from './validate.js';
import { settleOne, reconcileSettlements } from './settler.js';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export class Service {
  constructor({ cfg, store, wallet, bitcoind, metashrew, log = console.log }) {
    this.cfg = cfg;
    this.store = store;
    this.wallet = wallet;
    this.bitcoind = bitcoind;
    this.metashrew = metashrew;
    this.log = log;
    this.signerScriptHex = null;
  }

  async setup() {
    const chainInfo = await this.bitcoind.assertSignet();
    await this.bitcoind.ensureWatchWallet(this.wallet.internalPubkeyHex);
    const indexHeight = await this.metashrew.height();
    this.log(
      `signet ok: bitcoind height ${chainInfo.blocks}, metashrew height ${indexHeight} ` +
        `(lag ${chainInfo.blocks - indexHeight}), wallet ${this.wallet.address}`,
    );
    try {
      const signer = await this.metashrew.getSignerPubkey(indexHeight);
      if (signer) {
        this.signerScriptHex = Buffer.from(p2trOutputKeyScript(signer)).toString('hex');
        this.log(`frBTC signer pubkey: ${signer}`);
      } else {
        this.log('WARN: get_signer returned nothing; receipt-script check disabled');
      }
    } catch (err) {
      this.log(`WARN: get_signer unavailable (${err.message}); receipt-script check disabled`);
    }
    return chainInfo;
  }

  /** One full pass. Fail-safe: any error aborts the cycle without paying. */
  async cycle() {
    const summary = { seen: 0, paid: 0, deferred: 0, rejected: 0, skipped: 0 };

    // 0. reconcile previous settlements first (rebroadcast / confirm)
    await reconcileSettlements({ bitcoind: this.bitcoind, store: this.store, cfg: this.cfg, log: this.log });

    // 1. WATCH: read pending unwraps from the index
    const indexHeight = await this.metashrew.height();
    const pendingRaw = await this.metashrew.pendingUnwraps(indexHeight);

    // de-duplicate by receipt outpoint (defensive)
    const seen = new Set();
    const pending = pendingRaw.filter((p) => {
      const key = outpointKey(p.receiptTxid, p.receiptVout);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    summary.seen = pending.length;

    // 2/3. MATCH + SETTLE, respecting the per-cycle budget
    let budget = this.cfg.maxSatsPerCycle;
    for (const payment of pending) {
      const key = outpointKey(payment.receiptTxid, payment.receiptVout);
      const verdict = await validatePayment(payment, {
        cfg: this.cfg,
        store: this.store,
        bitcoind: this.bitcoind,
        signerScriptHex: this.signerScriptHex,
        fetchJson,
      });
      for (const w of verdict.warnings) this.log(`WARN ${key}: ${w}`);

      if (verdict.outcome === 'already-settled' || verdict.outcome === 'already-rejected') {
        summary.skipped++;
        continue;
      }
      if (verdict.outcome === Outcome.REJECT) {
        this.store.reject(key, verdict.reasons.join('; '), {
          amountSats: payment.amountSats.toString(),
          dest: classifyScript(payment.destScript).address,
        });
        this.log(`REJECT ${key}: ${verdict.reasons.join('; ')}`);
        summary.rejected++;
        continue;
      }
      if (verdict.outcome === Outcome.DEFER) {
        this.store.audit('payment.deferred', { receipt: key, reasons: verdict.reasons });
        this.log(`DEFER ${key}: ${verdict.reasons.join('; ')}`);
        summary.deferred++;
        continue;
      }

      if (payment.amountSats > budget) {
        this.store.audit('payment.deferred', { receipt: key, reasons: ['per-cycle budget exhausted'] });
        this.log(`DEFER ${key}: per-cycle budget exhausted`);
        summary.deferred++;
        continue;
      }

      const res = await settleOne(payment, {
        wallet: this.wallet,
        bitcoind: this.bitcoind,
        store: this.store,
        cfg: this.cfg,
        log: this.log,
      });
      if (res.status === 'broadcast') {
        budget -= payment.amountSats;
        summary.paid++;
      } else {
        summary.deferred++;
      }
    }

    this.store.audit('cycle.complete', { indexHeight, ...summary });
    return summary;
  }

  async runForever() {
    for (;;) {
      try {
        const s = await this.cycle();
        this.log(
          `cycle: ${s.seen} pending, ${s.paid} paid, ${s.deferred} deferred, ` +
            `${s.rejected} rejected, ${s.skipped} already handled`,
        );
      } catch (err) {
        // fail-safe: log and wait; never pay on a partial view of the world
        this.log(`cycle error (no payouts made this cycle): ${err.message}`);
        this.store.audit('cycle.error', { error: err.message });
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalSec * 1000));
    }
  }
}
