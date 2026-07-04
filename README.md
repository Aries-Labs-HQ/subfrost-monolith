# subfrost-monolith

**SIGNET-ONLY** unwrap-settlement signer for Subfrost frBTC — a deliberately
**simplified, single-key replica** of the unwrap behavior of the Subfrost
federation (design source: Flex's `subzero-rs`). It exists so that frBTC
unwraps settle on signet, where the real FROST federation is not running and
signet frBTC is deterministic-credit-only (mints credit, but nothing releases
BTC at redemption).

> ## ⚠️ Not FROST. Not mainnet-safe. Signet/testnet only.
>
> The real Subfrost releases BTC via distributed threshold (FROST) signing —
> no single party can move funds. This monolith replaces that with **one
> P2TR key on one machine**: a single point of custody and failure. That is
> an acceptable trade-off for a signet demo and categorically unacceptable
> for mainnet or any L0/real-value assets. The code hard-refuses to operate
> when bitcoind reports any chain other than `signet`.

Per Flex (Subfrost author): *"watch the metashrew_view unwrap function, match
the receipt outpoints to an unwrap when you build the rollups... for a signet
build it's fine."*

## How it works

```
┌─────────┐   metashrew_view "unwrap"    ┌─────────┐   gettxout / esplora   ┌─────────┐
│  WATCH  │ ───────────────────────────► │  MATCH  │ ─────────────────────► │ SETTLE  │
│ pending │  Payment{spendable, output}  │ receipt │   all checks passed    │ P2TR tx │
│ unwraps │                              │ checks  │                        │ payout  │
└─────────┘                              └─────────┘                        └─────────┘
```

1. **WATCH** — polls the signet metashrew/rockshrew index. An frBTC unwrap is
   an opcode-78 burn (`calldata [32, 0, 78, vout, amount]`); the indexer
   queues a `Payment { spendable, output, fulfilled }` for each one, where:
   - `spendable` — the **receipt outpoint**: the unwrap transaction's output
     at `vout`, which pays the frBTC signer. In real Subfrost the federation
     spends it when fulfilling; that spend is what marks the payment
     fulfilled on-chain.
   - `output` — the exact payout: consensus-encoded `TxOut` with the
     destination scriptPubKey (the unwrap tx's pointer output, i.e. the
     burner's address) and the burned amount in sats.

   The monolith reads these via the `unwrap` metashrew view (protobuf
   `PendingUnwrapsResponse`), which returns every queued payment whose
   receipt is still unspent per the index.

2. **MATCH** — the security boundary. A payment is paid only if **all** hold:
   - it came from the `unwrap` view (the indexer only queues payments for
     real, indexed opcode-78 burns — this *is* the receipt↔unwrap rollup);
   - its receipt outpoint is found **unspent** in bitcoind's UTXO set
     (`gettxout`) with ≥ `MIN_CONFIRMATIONS` — anchoring the indexer's claim
     to the actual chain;
   - (default on, `DEEP_VERIFY`) the unwrap tx fetched from esplora is
     structurally an unwrap: carries a runestone OP_RETURN (`6a5d…`) and the
     payout destination script is one of its own outputs;
   - the destination script is standard, the amount is above dust and below
     `MAX_PAYOUT_SATS`, and a per-cycle budget (`MAX_SATS_PER_CYCLE`) holds;
   - it is not already settled/rejected in the persistent store;
   - soft check (hardenable via `REQUIRE_SIGNER_MATCH`): the receipt's
     scriptPubKey equals `OP_1 <get_signer pubkey>` (frBTC opcode 103).

   Anything ambiguous — index/node/esplora unreachable, receipt too shallow
   or missing — **defers**: the payment stays queued and nothing is paid.
   Only structurally-broken payments (dust, nonstandard destination, failed
   deep verification) are rejected, permanently and auditable
   (`retry <txid:vout>` re-opens one).

3. **SETTLE** — pays `output.value` sats to `output.script_pubkey` from the
   monolith's own single-key P2TR wallet, in a transaction that also carries
   an `OP_RETURN "SFM1" <receipt txid> <vout>` marker referencing the matched
   receipt. Note the monolith **cannot spend the receipt outpoint itself**
   (it pays the federation signer key, which we don't hold), so on-chain the
   receipt stays unspent and the view keeps listing it — the persistent
   settled-receipt store is what prevents re-payment, and the OP_RETURN
   marker makes each payout attributable to its receipt.

4. **SAFETY**
   - **Idempotency**: settled receipts are persisted (`data/state.json`,
     atomic tmp+rename+fsync writes). The signed settlement tx is written
     **before** broadcast (write-ahead); crash recovery rebroadcasts that
     exact tx — same txid, so a receipt can never be paid twice.
   - **Fail-safe**: any error in a cycle aborts the cycle without paying.
   - **Confirmation depth** before paying; **dust** and **standardness**
     validation of destinations; **caps** per payout and per cycle.
   - **Audit log**: every decision (pay/defer/reject/broadcast/confirm) is
     appended to `data/audit.jsonl`.
   - **Signet guard**: refuses to run against any other chain.
   - **Single instance**: pid lockfile.
   - Key material lives only in `.env` (gitignored, chmod 600), never
     printed or logged.

## Setup

Requires Node ≥ 20, a signet bitcoind (RPC on `127.0.0.1:38332`) and a signet
metashrew/rockshrew index (`127.0.0.1:8080`). Defaults match that stack; see
`.env.example` for every knob.

```bash
npm install
node src/index.js init      # generates the signing key into .env (chmod 600)
                            # and prints the settlement address
# fund the printed tb1p... address with signet BTC — this is the pool
# that unwraps are paid from (plus network fees)
node src/index.js status    # heights, lag, balance, pending unwraps, store
node src/index.js once      # single watch->match->settle cycle
node src/index.js run       # settle loop (POLL_INTERVAL_SEC, default 30s)
```

The service auto-creates a **watch-only** descriptor wallet in bitcoind
(`subfrost-monolith-watch`) to track the settlement address; private keys
never leave `.env`.

## Testing

```bash
node --test          # 40 unit tests (protobuf codec, TxOut decode, wallet
                     # signing, validation pipeline, store idempotency,
                     # settle/recovery logic) — all hermetic
LIVE=1 node --test   # + read-only integration tests against the local
                     # signet stack (unwrap view, get_signer, signet guard)
```

**Proven now** (against the live local stack): the `unwrap` view call +
decode, `get_signer` via the `simulate` view (signer pubkey
`7940ef3b659179a1371dec05793cb027cde47806fb66ce1e3d1b69d56de629dc`), signet
guard, wallet derivation/signing, full cycle execution with 0 pending.

**Pending metashrew tip-sync** (local index is ~51k blocks behind signet tip
at time of writing): the full end-to-end settlement of a *real* unwrap — the
burn only becomes visible to the view once the index reaches it. The recipe
is written up as a `test.todo` in `test/live.test.js`: fund the wallet, do an
opcode-78 unwrap from the app, wait `MIN_CONFIRMATIONS`, run `once`, expect
`1 paid`.

## Protocol reference (as verified against alkanes-rs source + live signet)

| Fact | Value |
|---|---|
| frBTC alkane | `32:0` |
| Wrap / unwrap opcodes | `77` / `78` (`unwrap(vout, amount)`) |
| Pending payments | metashrew view `unwrap`, input = LE u32 height, output = protobuf `PendingUnwrapsResponse` |
| `get_signer` | opcode `103` via metashrew view `simulate` (raw protobuf `MessageContextParcel`, **no** height prefix on the deployed signet WASM; calldata = LEB128 `[32,0,103]`) |
| Receipt semantics | `Payment.spendable` = unwrap tx output at `vout`, pays the signer; spent-by-signer ⇒ fulfilled |
| Payout semantics | `Payment.output` = TxOut{ burned sats, unwrap tx pointer-output script } |
| Proto `txid` byte order | internal (reversed vs. RPC display order) |
