#!/usr/bin/env node
// subfrost-monolith — SIGNET-ONLY unwrap-settlement signer (single-key
// simplified replica of the Subfrost federation's unwrap behavior).

import fs from 'node:fs';
import { loadConfig, ENV_PATH, parseEnvFile } from './config.js';
import { Store } from './store.js';
import { Wallet, generatePrivKeyHex } from './wallet.js';
import { Bitcoind } from './bitcoind.js';
import { Metashrew } from './metashrew.js';
import { Service } from './service.js';

const USAGE = `subfrost-monolith — SIGNET-ONLY frBTC unwrap settler (NOT FROST, NOT mainnet-safe)

Usage:
  node src/index.js init             generate signing key (.env, chmod 600) + print funding address
  node src/index.js address          print the settlement wallet address
  node src/index.js status           show heights, balances, pending unwraps, store summary
  node src/index.js once             run a single watch->match->settle cycle
  node src/index.js run              run the settle loop (POLL_INTERVAL_SEC)
  node src/index.js retry <txid:vout>  clear a rejected receipt so it is re-evaluated
`;

function initKey() {
  const existing = fs.existsSync(ENV_PATH) ? parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8')) : null;
  if (existing?.MONOLITH_PRIVKEY_HEX) {
    console.log('.env already holds a signing key; refusing to overwrite.');
    return existing.MONOLITH_PRIVKEY_HEX;
  }
  const key = generatePrivKeyHex();
  const lines = [
    '# subfrost-monolith secrets — NEVER commit this file (gitignored).',
    '# SIGNET-ONLY single-key settlement wallet.',
    `MONOLITH_PRIVKEY_HEX=${key}`,
    '',
  ];
  if (existing) {
    const prior = fs.readFileSync(ENV_PATH, 'utf8');
    fs.writeFileSync(ENV_PATH, prior.trimEnd() + '\n' + lines.join('\n'), { mode: 0o600 });
  } else {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  }
  fs.chmodSync(ENV_PATH, 0o600);
  console.log(`generated new signing key -> ${ENV_PATH} (mode 600)`);
  return key;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'init') {
    const key = initKey();
    const wallet = new Wallet(key);
    console.log('');
    console.log(`settlement wallet address (fund with signet BTC): ${wallet.address}`);
    console.log('key is stored only in .env; it is never printed or logged.');
    return;
  }

  const cfg = loadConfig();
  const wallet = new Wallet(cfg.privKeyHex);

  if (cmd === 'address') {
    console.log(wallet.address);
    return;
  }

  const store = new Store(cfg.dataDir);
  const bitcoind = new Bitcoind(cfg);
  const metashrew = new Metashrew(cfg);

  if (cmd === 'retry') {
    const key = process.argv[3];
    if (!/^[0-9a-f]{64}:\d+$/.test(key ?? '')) {
      console.error('usage: retry <txid:vout>');
      process.exit(1);
    }
    console.log(store.unreject(key) ? `cleared rejection for ${key}` : `${key} was not rejected`);
    return;
  }

  if (cmd === 'status') {
    const chainInfo = await bitcoind.assertSignet();
    const indexHeight = await metashrew.height();
    let balance = null;
    try {
      await bitcoind.ensureWatchWallet(wallet.internalPubkeyHex);
      const b = await bitcoind.walletCall('getbalances');
      balance = b.watchonly ?? b.mine;
    } catch (err) {
      console.log(`(watch wallet unavailable: ${err.message})`);
    }
    const pending = await metashrew.pendingUnwraps(indexHeight);
    console.log(`chain:            signet (bitcoind ${chainInfo.blocks}, metashrew ${indexHeight}, lag ${chainInfo.blocks - indexHeight})`);
    console.log(`wallet:           ${wallet.address}`);
    if (balance) {
      console.log(`balance:          ${balance.trusted} BTC trusted, ${balance.untrusted_pending} pending`);
    }
    console.log(`pending unwraps:  ${pending.length} (as indexed; on-chain-unsettled)`);
    console.log(`store:            ${JSON.stringify(store.summary())}`);
    if (chainInfo.blocks - indexHeight > 10) {
      console.log('NOTE: metashrew index is behind the signet tip; recent unwraps are not visible yet.');
    }
    return;
  }

  if (cmd === 'once' || cmd === 'run') {
    const release = store.acquireLock();
    try {
      const service = new Service({ cfg, store, wallet, bitcoind, metashrew });
      await service.setup();
      if (cmd === 'once') {
        const s = await service.cycle();
        console.log(
          `cycle: ${s.seen} pending, ${s.paid} paid, ${s.deferred} deferred, ` +
            `${s.rejected} rejected, ${s.skipped} already handled`,
        );
      } else {
        await service.runForever();
      }
    } finally {
      release();
    }
    return;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.log(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
