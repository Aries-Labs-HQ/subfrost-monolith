// Signet bitcoind access: chain guard, receipt lookups (gettxout), a
// watch-only descriptor wallet for our P2TR address, and broadcasting.

import { makeClient, RpcError } from './jsonrpc.js';

export class Bitcoind {
  constructor(cfg) {
    this.cfg = cfg;
    this.call = makeClient({
      url: cfg.bitcoindUrl,
      user: cfg.bitcoindUser,
      pass: cfg.bitcoindPass,
    });
    this.wallet = cfg.watchWallet;
  }

  walletCall(method, params = []) {
    return this.call(method, params, { walletPath: this.wallet });
  }

  /** HARD signet guard — refuse to do anything against another chain. */
  async assertSignet() {
    const info = await this.call('getblockchaininfo');
    if (info.chain !== 'signet') {
      throw new Error(
        `bitcoind chain is '${info.chain}' but this tool is SIGNET-ONLY; refusing to operate`,
      );
    }
    return info;
  }

  /** UTXO-set lookup of an unspent outpoint (confirmed view; no mempool). */
  async getTxOut(txid, vout) {
    return this.call('gettxout', [txid, vout, false]);
  }

  async ensureWatchWallet(descriptorPubkeyHex) {
    const loaded = await this.call('listwallets');
    if (!loaded.includes(this.wallet)) {
      try {
        // wallet_name, disable_private_keys, blank, passphrase, avoid_reuse,
        // descriptors, load_on_startup
        await this.call('createwallet', [this.wallet, true, true, '', false, true, true]);
      } catch (err) {
        // -4: already exists on disk -> load it
        if (err instanceof RpcError && err.code === -4) {
          await this.call('loadwallet', [this.wallet, true]);
        } else {
          throw err;
        }
      }
    }
    const desc = `tr(${descriptorPubkeyHex})`;
    const { descriptors } = await this.walletCall('listdescriptors');
    const withChecksum = (await this.call('getdescriptorinfo', [desc])).descriptor;
    if (!descriptors.some((d) => d.desc === withChecksum)) {
      const res = await this.walletCall('importdescriptors', [
        [{ desc: withChecksum, timestamp: 'now', label: 'subfrost-monolith' }],
      ]);
      if (!res[0]?.success) {
        throw new Error(`importdescriptors failed: ${JSON.stringify(res[0]?.error ?? res)}`);
      }
    }
    return withChecksum;
  }

  /** Spendable UTXOs on our address, including our own unconfirmed change. */
  async listUnspent() {
    return this.walletCall('listunspent', [0, 9999999, [], true]);
  }

  async getWalletTx(txid) {
    try {
      return await this.walletCall('gettransaction', [txid]);
    } catch (err) {
      if (err instanceof RpcError && !err.transport) return null; // unknown tx
      throw err;
    }
  }

  /**
   * Broadcast; treats "already in mempool / already known / already confirmed"
   * as success so recovery can blindly rebroadcast stored transactions.
   */
  async broadcast(rawTxHex) {
    try {
      return { txid: await this.call('sendrawtransaction', [rawTxHex]), duplicate: false };
    } catch (err) {
      if (err instanceof RpcError && !err.transport) {
        const msg = err.message.toLowerCase();
        if (
          msg.includes('already in mempool') ||
          msg.includes('txn-already-known') ||
          msg.includes('already known') ||
          msg.includes('txn-already-in-mempool') ||
          msg.includes('transaction already in block chain') ||
          msg.includes('txn-already-in-blockchain')
        ) {
          return { txid: null, duplicate: true };
        }
      }
      throw err;
    }
  }

  async feeRateSatVb() {
    try {
      const est = await this.call('estimatesmartfee', [6]);
      if (est?.feerate) {
        const satVb = Math.ceil((est.feerate * 1e8) / 1000);
        return Math.min(Math.max(satVb, 1), this.cfg.maxFeeRateSatVb);
      }
    } catch {
      // estimator often has no data on signet; fall through to configured rate
    }
    return this.cfg.feeRateSatVb;
  }
}
