// Persistent settlement store — the idempotency backbone.
//
// state.json layout (all receipt keys are "txid:vout" of the unwrap receipt
// outpoint, display txid order):
//   settled:  receipts we have paid. status: 'broadcast' -> 'confirmed'.
//             Holds the SIGNED raw tx so recovery can rebroadcast the exact
//             same transaction (same txid) — idempotent by construction.
//   rejected: receipts we will never pay (dust, nonstandard dest, ...).
//   Every mutation is written atomically (tmp + rename + fsync) BEFORE any
//   dependent external action (write-ahead).
//
// audit.jsonl: append-only log of every decision and action.

import fs from 'node:fs';
import path from 'node:path';

const STATE_VERSION = 1;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.auditPath = path.join(dataDir, 'audit.jsonl');
    this.lockPath = path.join(dataDir, 'monolith.lock');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.statePath)) {
      return { version: STATE_VERSION, settled: {}, rejected: {} };
    }
    const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    if (state.version !== STATE_VERSION) {
      throw new Error(`state.json version ${state.version} unsupported (expected ${STATE_VERSION})`);
    }
    return state;
  }

  #save() {
    const tmp = this.statePath + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.statePath);
    const dirFd = fs.openSync(this.dataDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } catch {
      // fsync on directories can fail on some filesystems; rename is still atomic
    } finally {
      fs.closeSync(dirFd);
    }
  }

  audit(event, detail = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
    fs.appendFileSync(this.auditPath, line + '\n', { mode: 0o600 });
  }

  isSettled(key) { return Object.hasOwn(this.state.settled, key); }
  isRejected(key) { return Object.hasOwn(this.state.rejected, key); }
  getSettled(key) { return this.state.settled[key]; }

  /**
   * Write-ahead record of an imminent broadcast. Called AFTER signing and
   * BEFORE sendrawtransaction, so a crash in between still leaves us with the
   * exact signed tx to recover/rebroadcast — never a double-pay.
   */
  recordIntent(key, { payoutTxid, rawTx, amountSats, destAddress, destScriptHex }) {
    if (this.isSettled(key)) throw new Error(`receipt ${key} already settled`);
    this.state.settled[key] = {
      status: 'broadcast-pending',
      payoutTxid,
      rawTx,
      amountSats: amountSats.toString(),
      destAddress,
      destScriptHex,
      createdAt: new Date().toISOString(),
    };
    this.#save();
    this.audit('settle.intent', { receipt: key, payoutTxid, amountSats: amountSats.toString(), destAddress });
  }

  markBroadcast(key) {
    const rec = this.state.settled[key];
    if (!rec) throw new Error(`no settlement record for ${key}`);
    rec.status = 'broadcast';
    rec.broadcastAt = new Date().toISOString();
    this.#save();
    this.audit('settle.broadcast', { receipt: key, payoutTxid: rec.payoutTxid });
  }

  markConfirmed(key, confirmations) {
    const rec = this.state.settled[key];
    if (!rec) throw new Error(`no settlement record for ${key}`);
    rec.status = 'confirmed';
    rec.confirmations = confirmations;
    rec.confirmedAt = rec.confirmedAt ?? new Date().toISOString();
    delete rec.rawTx; // no longer needed once buried
    this.#save();
    this.audit('settle.confirmed', { receipt: key, payoutTxid: rec.payoutTxid, confirmations });
  }

  reject(key, reason, detail = {}) {
    if (this.isSettled(key)) throw new Error(`receipt ${key} already settled; cannot reject`);
    this.state.rejected[key] = { reason, ...detail, at: new Date().toISOString() };
    this.#save();
    this.audit('payment.rejected', { receipt: key, reason, ...detail });
  }

  unreject(key) {
    if (!this.isRejected(key)) return false;
    delete this.state.rejected[key];
    this.#save();
    this.audit('payment.unrejected', { receipt: key });
    return true;
  }

  /** Settlements broadcast (or pending broadcast) but not yet confirmed. */
  unconfirmedSettlements() {
    return Object.entries(this.state.settled).filter(([, r]) => r.status !== 'confirmed');
  }

  /** Our own payout txids — used to trust unconfirmed change during coin selection. */
  ownPayoutTxids() {
    return new Set(Object.values(this.state.settled).map((r) => r.payoutTxid));
  }

  summary() {
    const settled = Object.values(this.state.settled);
    return {
      settled: settled.length,
      confirmed: settled.filter((r) => r.status === 'confirmed').length,
      unconfirmed: settled.filter((r) => r.status !== 'confirmed').length,
      rejected: Object.keys(this.state.rejected).length,
      totalPaidSats: settled.reduce((n, r) => n + BigInt(r.amountSats), 0n).toString(),
    };
  }

  // -- single-instance lock ------------------------------------------------

  acquireLock() {
    try {
      const fd = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(this.lockPath, 'utf8'));
      if (pid && pidAlive(pid)) {
        throw new Error(`another instance is running (pid ${pid}); refusing to start`);
      }
      fs.writeFileSync(this.lockPath, String(process.pid), { mode: 0o600 });
    }
    const release = () => {
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
    };
    process.on('exit', release);
    return release;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
