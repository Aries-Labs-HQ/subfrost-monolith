# SIGNET frBTC SETTLEMENT TEST — RESULT

**Date:** 2026-07-07 (signet)
**Verdict:** **FEDERATION = OFF** → **KEEP the monolith** as the signet frBTC unwrap-settlement path.

The definitive question this test answers: *after a real frBTC unwrap, does sBTC settle on
its own (federation signing LIVE) or only when the monolith runs (federation OFF)?*
**It settled only when the monolith ran. The federation did nothing.**

---

## One-line evidence

- Receipt outpoint `9f2bb52e…:2` (pays the frBTC signer) stayed **UNSPENT** for the full
  watch window (6 blocks / 60 min, monolith never running) and the unwrap view stayed
  `pending=1, fulfilled=false` — no unprompted settlement.
- The monolith then settled it in exactly **1 payout** of **49,950 sats** from its own
  wallet, tx `3de529a3…86b4`, without ever spending the signer's outpoint.

---

## Amounts

| Leg | Amount |
|---|---|
| Wrapped (BTC → frBTC) | 50,000 sats → **49,950 frBTC** credited (0.1% taken at wrap; the "no fee on wrap" note in the prompt is slightly off — reality is a 0.1% deduction) |
| Unwrapped (frBTC burn, opcode 78) | 49,950 frBTC |
| Unwrap view payout (`Payment.output.value`) | **49,950 sats** → burn dest `tb1pw3n…` |
| Monolith payout | **49,950 sats** (fee 615, 205 vB) |

## On-chain trail (signet)

| Step | TXID | Block | Key outputs |
|---|---|---|---|
| WRAP | `5e3e37f48ede07dab87c16e5a1166f3e586697c30a7916b27a9ec057fa2edf35` | 312058 | v0 50,000→signer `tb1p5lush…`; **v1 25,000→test wallet, carries 49,950 frBTC** |
| UNWRAP(78) | `9f2bb52ecadb244d2e8e786877d1a767baff930144dfe9ebb50361796ed8ee7b` | 312067 | v1 payout→test wallet; **v2 546→signer `tb1p5lush…` = receipt outpoint**; v4 OP_RETURN runestone `[32,0,78,2,49950]` |
| MONOLITH PAYOUT | `3de529a39b65539edbe12fb3c2147d8d9d25bf5aeb1b5cd596282e6b0b9f86b4` | **312074** (backfilled 2026-08-08, CAP1: confirmed, dual-source — our electrs AND Flex esplora agree on block `000000069d17cc31…5a23e8`; store `settle.confirmed` 2026-07-17 at 1481 confs) | v0 **49,950→`tb1pw3n…`**; v1 OP_RETURN `SFM1`+receipt; v2 949,435 change→`tb1pet2…` |

- frBTC signer (live, `get_signer(103)` = x-only `7940ef3b…629dc`) P2TR = `tb1p5lush…`.
- SFM1 marker (payout v1): `6a28 53464d31 7beed86e…2b9f 02000000` = "SFM1" + receipt txid
  (internal byte order) + vout 2 — attributes the payout to receipt `9f2bb52e…:2`.

## Watch window (the actual test) — no monolith ran

Unwrap block 312067 → tip 312073 (6 blocks), 60 minutes, 25 per-block polls. Every poll:
`receipt=unspent | sBTC_landed=no | view pending=1 fulfilled=false`. Receipt confirmed
UNSPENT on **local bitcoind (at tip, authoritative)** throughout and at 7 confirmations at
window end. → federation is not signing; the receipt outpoint is never consumed.

## Monolith settlement (Phase 6)

`node src/index.js once` → `1 pending, 1 paid, 0 deferred, 0 rejected, 0 already handled`.
- Pays `Payment.output.value` (49,950) from single-key P2TR wallet `tb1pet2…` to the burn
  destination `tb1pw3n…`.
- **Write-ahead persistence**: `data/state.json` records the receipt with status `broadcast`
  and the pre-signed `rawTx` written *before* broadcast (`createdAt` < `broadcastAt`).
- **Audit** (`data/audit.jsonl`): `settle.intent` → `settle.broadcast` → `cycle.complete{paid:1}`.

### Safety invariant — VERIFIED
The signer receipt outpoint `9f2bb52e…:2` **remains UNSPENT** after settlement. The monolith
settles from its own wallet + SFM1 marker; it cannot and does not spend the signer's outpoint
(not its key). The view keeps listing the payment as pending — the persistent settled-store,
not on-chain receipt-spend, is what prevents re-payment.

### Idempotency / crash-safety — VERIFIED
A second `node src/index.js once` → `1 pending, 0 paid, 0 deferred, 0 rejected, **1 already
handled**`. Still-pending receipt recognized as settled from the write-ahead store → **no
double-pay** (exactly one `settle.broadcast` event; one payout tx).

---

## Caveats / findings

1. **Soft signer-match check misfires (cosmetic here, latent bug).** The cycle logged
   `signer mismatch (soft): receipt script 5120a7f90b… != signer script 51207940ef3b…`.
   The monolith builds the "signer script" as `OP_1 <raw x-only get_signer pubkey>`
   (`7940ef3b…`) but the real receipt pays the **BIP341-tweaked** output key (`a7f90b…`).
   It should tweak the internal key before comparing. Harmless now (`REQUIRE_SIGNER_MATCH`
   defaults false → soft warning only), but **if `REQUIRE_SIGNER_MATCH=true` were set it
   would wrongly DEFER every legitimate receipt.** Fix before hardening that knob.

2. **Flex `l.subfrost` view stalls intermittently.** It froze at 312055 for ~30 min after
   the wrap and later sat at 312068 during the window while bitcoind advanced. The test was
   robust because receipt-spentness is checked on **local bitcoind at tip** (authoritative);
   the view is only a secondary/pending signal. Any tip-sensitive logic must not trust the
   hosted view's height blindly.

3. **CLI unwrap needed a read-side workaround.** `alkanes-cli execute` could not discover the
   frBTC to burn: its fast path only scans dust (≤1000-sat) UTXOs (wrap-btc placed the frBTC
   on a 25k output), and Flex's espo returns empty-but-ok, short-circuiting the cascade before
   the working `protorunesbyaddress` view. `--espo-rpc-url` is parsed but never wired into the
   config (dead flag). Worked around with a local read proxy that fails the `/espo` path,
   forcing fallthrough. The unwrap tx itself was built entirely by the canonical CLI executor
   (reads only through the proxy; broadcast via local bitcoind).

## Decision

**KEEP the monolith.** On signet the frBTC federation does not release BTC at redemption
(deterministic-credit-only), so unwraps do not settle without it. The monolith settles them
correctly, idempotently, and without touching federation key material. Retiring it would
strand every signet unwrap as an unspent receipt.
