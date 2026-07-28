# Demo runbook

Target: **4 minutes**. The single thing judges must remember is that a *real* XRPL payment was
verified *trustlessly* by Flare's validator set and turned into USDC in one user action.

---

## Before you present

Ten minutes ahead, not two:

- [ ] Contracts deployed to Coston2, `deployments/114.json` present, `./script/export-abis.sh` run.
- [ ] Pool seeded **at the current FTSO rate** (`Seed.s.sol` does this). A pool seeded off-market
      makes every settlement revert on the slippage floor — this is the number one way the demo
      dies.
- [ ] Minter reserve funded (`PooledFxrpMinter.reserveBalance()` well above the demo amount).
- [ ] Relayer running, and its log line **"deposit address matches on-chain configuration"** seen.
      If it warns instead, stop and fix it — every settlement will fail `WrongReceivingAddress`.
- [ ] Operator wallet holds C2FLR for gas *and* FDC request fees.
- [ ] XRPL testnet wallet funded with more XRP than you plan to send.
- [ ] Frontend deployed and loaded; `/docs` shows live contract addresses.
- [ ] **Backup video recorded.** Testnets are testnets.

Dry-run the whole flow once end to end. Note the actual settlement time — FDC rounds take ~90
seconds, so plan your narration to cover it rather than watching a spinner in silence.

---

## Script

### 0:00 – 0:30 · The problem

> "An XRP holder who wants USDC on Flare today does five things across three interfaces: find a
> bridge, wrap XRP into FXRP by hand, go to a DEX, swap, and keep gas on both chains. Price moves
> under them at every step. Most people just don't."

Have the old flow on screen as a list. Then:

> "What if it were one step?"

### 0:30 – 1:30 · Create the intent

Open `/swap`. Wallet already connected — do not spend demo time on a MetaMask popup.

- Type **500** XRP, destination **USDC**.
- Point at the rate as it updates: *"that price is coming from FTSOv2, Flare's native oracle,
  block-latency — about 1.8 seconds."*
- Open the quote panel: oracle fair value, price impact, protocol fee, minimum received.
  *"The minimum is enforced by the contract against FTSO at settlement time, not against this
  quote — so it tracks the market while my deposit is in flight."*
- Click **Create intent**, sign.

> "That transaction committed my terms — minimum output, deadline, slippage — on-chain, *before*
> I send any money. Nobody can settle me on worse terms than these."

### 1:30 – 2:45 · Deposit and settle — the moment

The deposit screen appears. Point at the memo:

> "This 32-byte memo is my intent id. It's what cryptographically binds a payment on the XRP
> Ledger to terms committed on Flare."

Send the XRPL payment (pre-staged in your wallet — paste and sign, don't type an address live).

Switch to `/intent/[id]` and narrate the stepper as it advances:

1. **XRP Deposited** — *"the relayer saw it on XRPL within a ledger close."*
2. **FDC Verified** — *"now Flare's validators independently verify that payment and commit a
   Merkle root on-chain. This is the part that matters: no centralised oracle told the contract
   this happened."*
3. **FXRP Minted → Swapped → Delivered** — *"one transaction: verify the proof, mint FXRP,
   swap it, deliver the USDC."*

Cut to the wallet balance. **This is the wow moment — let it land before speaking again.**

### 2:45 – 3:30 · Under the hood

Open `/docs`.

> "Three Flare protocols, three distinct jobs. FDC proved the deposit — the settler calls
> `verifyPayment` and then checks the payment reference equals the intent id, the funds went to
> our address, the amount isn't short, and that transaction has never settled anything before.
> FTSO priced it and bounds the fill. FAssets turned proven XRP into a real ERC-20."

Scroll to the contract addresses and click one through to the explorer. **Judges verify
deployments — make it one click.**

If asked *"what can the relayer do?"*:

> "Nothing. It can't redirect the output, change the terms, or invent a deposit — all of that comes
> from the proof. And `settleIntent` is permissionless, so if our relayer goes down anyone can
> settle."

### 3:30 – 4:00 · Traction and roadmap

Open `/explorer`: live intents, settlement times, success rate, live FTSO feed table with ages.

> "Target user is XRP's holder base — millions of wallets, almost none of them touching DeFi.
> Next: a solver network for competitive fills, FBTC as a source asset, and mainnet."

---

## If something goes wrong

| Symptom | Cause | Say this, then cut to the video |
|---|---|---|
| Stuck on "FDC attesting" | Round not finalised yet (~90s) | *"FDC rounds take about ninety seconds — that's the validator set voting."* Keep talking; do not stare. |
| Settlement reverts | Pool drifted off the FTSO rate | *"The contract just refused a fill worse than my slippage tolerance — that's the protection working."* Genuinely true, and a good look. |
| Prices show "—" | Backend down or RPC rate-limited | Switch to the recorded run. |
| Deposit not detected | Memo missing or malformed | Do not debug live. Cut to the video. |

Never debug on stage. The backup video exists for exactly this.

---

## Talking points that land

- *"Intent-based trading is what UniswapX, Across and CoW Protocol are all converging on. This is
  that model, but the intent crosses a chain boundary that isn't EVM."*
- *"Three protocols, none of them decorative: remove FDC and you need a trusted oracle; remove
  FTSO and you can't bound the fill; remove FAssets and there's nothing to swap."*
- *"The database is a cache. Every row can be rebuilt from chain logs."*
- *"138 contract tests. The FDC mock does real Merkle verification, so a tampered amount fails in
  the test suite exactly the way it would on mainnet."*
