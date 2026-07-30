# FlareSwap

**Cross-chain intent-based DEX.** Tell it what you want — *"500 XRP for USDC"* — send one payment
on the XRP Ledger, and the output token lands in your Flare wallet. No bridge UI, no manual
wrapping, no gas token on two chains.

Built for the **Flare Summer Signal Hackathon**, Track 1: Interoperable Asset Products.

| | |
|---|---|
| **Flare tech** | FTSOv2 (pricing) · FDC (deposit verification) · FAssets (FXRP minting) |
| **Target user** | XRP holders who want DeFi on Flare without bridging complexity |
| **Networks** | Coston2 testnet (114) · local Anvil devnet (31337) · Flare mainnet-ready (14) |
| **Contracts** | Solidity 0.8.25, Foundry, 138 tests |
| **Backend** | Node 20+ / TypeScript — relayer, indexer, price API, 24 tests |
| **Frontend** | Next.js 16 (App Router), React 19, Tailwind, ethers v6 |
| **Destinations** | USDC · USDT · WFLR · FXRP |

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [The security model](#3-the-security-model)
4. [Quick start — local devnet](#4-quick-start--local-devnet)
5. [Deploying to Coston2](#5-deploying-to-coston2)
6. [Repository layout](#6-repository-layout)
7. [Contracts in detail](#7-contracts-in-detail)
8. [Backend services in detail](#8-backend-services-in-detail)
9. [Frontend](#9-frontend)
10. [HTTP + WebSocket API](#10-http--websocket-api)
11. [Design decisions](#11-design-decisions)
12. [Testing](#12-testing)
13. [Adding a destination token](#13-adding-a-destination-token)
14. [Configuration reference](#14-configuration-reference)
15. [Troubleshooting](#15-troubleshooting)
16. [Current status and known limits](#16-current-status-and-known-limits)
17. [Roadmap](#17-roadmap)

---

## 1. What it does

### The problem

An XRP holder who wants USDC on Flare today does five things across three interfaces: find a
bridge they trust, wrap XRP into FXRP by hand, navigate to a DEX on Flare, swap, and keep a gas
token on both chains. Price moves under them between every step. Most give up.

### The solution

The user signs exactly two things:

1. **An intent on Flare** — amount, destination token, minimum output, deadline, slippage
   tolerance. Committed on-chain *before* any money moves.
2. **One payment on XRPL** — to a known address, carrying the intent id as a 32-byte memo.

Everything after that is permissionless. The Flare Data Connector attests to the payment, FTSOv2
prices it, FAssets mints FXRP, the AMM swaps it, and the output is delivered to the address that
created the intent.

### The user journey

```
① /swap            enter 500 XRP → USDC, see the live FTSO rate and the minimum you'll accept
② sign on Flare    createIntent commits your terms; costs one transaction
③ deposit          send one XRPL payment with the destination tag and 32-byte memo shown
④ /intent/[id]     watch it progress: deposited → FDC verified → minted → swapped → delivered
⑤ /dashboard       the output token is in your wallet
```

---

## 2. Architecture

```
User (XRPL wallet)
      │  ① one Payment: amount + destination tag + 32-byte memo = intentId
      ▼
 ┌──────────┐   ② relayer requests a Payment attestation from FdcHub
 │   XRPL   │ ──────────────────────────────────────────┐
 └──────────┘                                           ▼
                                                 ┌─────────────┐
                                                 │  Flare FDC  │  validators attest,
                                                 └──────┬──────┘  Merkle root committed on-chain
 ┌──────────────┐  ⓪ createIntent                       │ proof
 │ IntentManager│◀───────────── User (Flare wallet)     ▼
 └──────┬───────┘                                 ┌───────────────┐
        │ terms: minOut, deadline, slippage       │ IntentSettler │
        └──────────── lock / settle ──────────────┤ verifyPayment ✓
                                                  │ ③ mint FXRP     (FAssets)
                                                  │ ④ fair value    (FTSOv2)
                                                  │ ⑤ swap          (LiquidityPool)
                                                  ▼
                                          User receives USDC / USDT / WFLR / FXRP
```

### Component map

| Layer | Component | Responsibility |
|---|---|---|
| Blockchain | `IntentManager.sol` | Accepts intents, owns their lifecycle. Never moves value. |
| Blockchain | `IntentSettler.sol` | Verifies FDC proofs, mints, swaps, delivers. The trust boundary. |
| Blockchain | `PriceOracle.sol` | FTSOv2 wrapper with staleness guards and decimal normalisation. |
| Blockchain | `LiquidityPool.sol` | Constant-product AMM, one per FXRP/destination pair. |
| Blockchain | `FAssetsMinter` / `PooledFxrpMinter` | Two implementations of `IFxrpMinter`; hot-swappable. |
| Backend | Intent Relayer | XRPL watcher → FDC attestation → `settleIntent`. |
| Backend | Indexer | Mirrors on-chain intent state into SQLite. |
| Backend | Price API | Polls FTSOv2, caches, serves quotes and a WebSocket feed. |
| Frontend | Next.js app | 7 pages, live WebSocket updates, wallet via EIP-6963. |
| External | Flare FDC | Proves the XRPL payment happened. |
| External | Flare FTSOv2 | Block-latency price feeds. |
| External | FAssets | Mints FXRP from attested XRP. |

### Data flow, precisely

```
User → IntentManager.createIntent(...)            → IntentCreated event, intentId returned
Indexer picks up IntentCreated                    → row in SQLite, WebSocket push
User → XRPL Payment(vault, amount, tag, memo)     → validated on XRPL
XrplWatcher sees it (subscription or backfill)    → matches memo → intentId → status DEPOSITED
Relayer → verifier.prepareRequest(txId)           → ABI-encoded attestation request
Relayer → FdcHub.requestAttestation(request)      → lands in voting round N
Relayer polls Relay.isFinalized(200, N)           → true after ~90s
Relayer → DA layer proof-by-request-round-raw     → Merkle proof + ABI-encoded response
Relayer → IntentSettler.settleIntent(id, proof)   → one transaction does everything below
    ├─ FdcVerification.verifyPayment(proof)       → must be true
    ├─ seven binding checks (see §3)
    ├─ IntentManager.lockForSettlement(id)        → status Settling; per-intent reentrancy lock
    ├─ minter.mint(amount, this, proof)           → FXRP arrives
    ├─ protocol fee → feeRecipient
    ├─ PriceOracle.getQuote(...)                  → FTSO fair value
    ├─ pool.swap(fxrp, amount, minOut, user)      → output goes straight to the user
    └─ IntentManager.markSettled(id, out)         → status Settled, IntentSettled event
Indexer picks up IntentSettled                    → row updated, WebSocket push
```

---

## 3. The security model

`IntentSettler` is the trust boundary. It trusts exactly one thing: an FDC proof that Flare's
validator set attested to. Before any value moves, `settleIntent` enforces these in order:

| # | Check | Prevents |
|---|---|---|
| 1 | `FdcVerification.verifyPayment(proof)` | Forged or unattested payments |
| 2 | `attestationType == "Payment"` | Replaying a different attestation type |
| 3 | `sourceId == config.sourceId` | A payment on a different chain settling this intent |
| 4 | `responseBody.status == 0` | Settling on a failed XRPL payment |
| 5 | `standardPaymentReference == intentId` | Someone else's deposit settling your intent |
| 6 | `receivingAddressHash == depositAddressHash` | A payment to an attacker's own address |
| 7 | `receivedAmount >= sourceAmount` | Underpayment |
| 8 | `settledByTx[transactionId] == 0` | **One XRPL payment funding many intents** |

Only then does value move — and the output can *only* go to `intent.user`, bounded by **both**
the absolute `minOutputAmount` committed at creation and an FTSO-derived slippage floor computed
live at settlement.

### What the relayer can and cannot do

The relayer holds **no privilege**. It cannot redirect an output, alter terms, or invent a
deposit — every one of those is derived from the proof, not from the caller. The worst a
compromised relayer key can do is *stop relaying*, and because `settleIntent` is permissionless
by default, anyone else can then settle instead.

There is a `permissionless` flag to fall back to a whitelisted relay if griefing ever appears,
and a `Pausable` guard for emergencies. Neither can move user funds.

### Reentrancy

Two independent layers. `nonReentrant` on `settleIntent` guards the contract globally.
Separately, `lockForSettlement` flips the intent to a `Settling` status that **no other
transition accepts as an input state**, which makes it a per-intent lock — a malicious token or
pool that calls back for the same id fails on status, not on a shared mutex.

---

## 4. Quick start — local devnet

The fastest way to see the whole system work. Deploys the real contracts against mocked
FTSOv2/FDC/registry, so nothing external is needed — no API keys, no faucet, no XRPL account.

**Prerequisites:** Node ≥ 20, [Foundry](https://book.getfoundry.sh/getting-started/installation),
`jq`.

```bash
git clone <this repo> && cd flareswap

# ── 1. contracts ──────────────────────────────────────────────────────────
cd contracts
forge install                       # forge-std + OpenZeppelin v5.1.0
forge test                          # 138 tests

anvil &                             # local chain on :8545
forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url http://127.0.0.1:8545 --broadcast --slow

cd .. && ./contracts/script/export-abis.sh   # ABIs + addresses → backend & frontend
./scripts/use-network.sh local               # point both apps at chain 31337

# ── 2. backend ────────────────────────────────────────────────────────────
cd backend && npm install && npm run dev     # :4000

# ── 3. frontend (new terminal) ────────────────────────────────────────────
cd frontend && npm install && npm run dev    # :3000
```

Open <http://localhost:3000>.

> **`--slow` is not optional.** Without it, `forge script` estimates gas for the whole batch up
> front and the pool-seeding transaction can land under-provisioned. `--slow` waits for each
> receipt before sending the next. This cost me a silent 33-of-34 deploy the first time.

### Connecting a wallet to the devnet

Add the network in MetaMask:

| Field | Value |
|---|---|
| Network name | FlareSwap Local Devnet |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | `C2FLR` |

Import an Anvil account to get pre-funded gas — **first key**:
`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

⚠️ **That key is public.** It is in every Foundry tutorial. Use it on a throwaway local chain
only, and delete the account afterwards. Anything sent to `0xf39Fd6e5…b92266` on a real network
is swept by bots within seconds.

### Seeding demo activity

`DeployLocal` seeds all three pools and the minter reserve. To create and settle a few intents so
the explorer and dashboard have data, see the settlement walkthrough in
[§15 Troubleshooting](#15-troubleshooting).

---

## 5. Deploying to Coston2

```bash
cd contracts

export PRIVATE_KEY=0x...              # a FRESH account, not one holding real funds
export XRPL_DEPOSIT_ADDRESS=r...      # the XRPL address users pay into
export XRPL_SOURCE_ID=testXRP         # "XRP" on mainnet

forge script script/Deploy.s.sol:Deploy --rpc-url coston2 --broadcast --slow -vvv
forge script script/Seed.s.sol:Seed   --rpc-url coston2 --broadcast --slow -vvv

cd .. && ./contracts/script/export-abis.sh
./scripts/use-network.sh coston2
```

Then restart both dev servers — **frontend env vars are inlined at build time**, so a hot reload
will not pick up a chain change.

**Gas:** C2FLR from [faucet.flare.network/coston2](https://faucet.flare.network/coston2). The
operator wallet needs enough for deployment *and* for ongoing FDC attestation request fees.

**To run the relayer** you additionally need, in `backend/.env`:

```bash
RELAYER_PRIVATE_KEY=0x...             # operator key, funded with C2FLR
```

That is the only secret required. Flare publishes a **public verifier API key**
(`00000000-0000-0000-0000-000000000000`, see
[API resources](https://dev.flare.network/network/overview#api-resources)) which is the built-in
default, and the DA layer needs no key at all — both were verified against live Coston2. Request a
dedicated key only if you need higher rate limits.

Without `RELAYER_PRIVATE_KEY` the backend runs **read-only**: prices, quotes, indexing and the
whole UI work, but nothing settles.

**To use real FAssets** instead of the pre-minted FXRP reserve, set `ASSET_MANAGER_ADDRESS` before
deploying. The script wires `FAssetsMinter` in place of `PooledFxrpMinter`; nothing upstream
changes because `IntentSettler` only ever talks to the `IFxrpMinter` interface.

---

## 6. Repository layout

```
contracts/                      Foundry project
  foundry.toml                  solc 0.8.25, via-IR, optimizer on
  src/
    IntentManager.sol           intents + lifecycle, the on-chain order book
    IntentSettler.sol           the trust boundary: proof → mint → swap → deliver
    PriceOracle.sol             FTSOv2 wrapper, staleness guards, decimal normalisation
    LiquidityPool.sol           constant-product AMM with ERC-20 LP shares
    adapters/
      FAssetsMinter.sol         production: reserveCollateral → executeMinting
      PooledFxrpMinter.sol      testnet: releases pre-minted FXRP from a reserve
    interfaces/                 hand-written Flare interfaces — no external dependency
      IFlareContractRegistry.sol  IFtsoV2.sol  IPayment.sol
      IFdcVerification.sol        IAssetManager.sol
      IIntentManager.sol          IFxrpMinter.sol
    libraries/
      FeedIds.sol               FTSO feed id constants + runtime builder
      FtsoV2Reader.sol          staticcall wrapper so price getters stay `view`
    mocks/                      FTSOv2, FDC (real Merkle verification), AssetManager, ERC-20
  test/                         138 tests, incl. fuzz
  script/
    Deploy.s.sol                Coston2 / mainnet
    DeployLocal.s.sol           Anvil + mocked Flare protocols
    Seed.s.sol                  seeds every pool at the live FTSO rate
    TokenSet.sol                the destination-token menu, shared by both deploy scripts
    export-abis.sh              ABIs + address book → backend and frontend
  deployments/<chainId>.json    written by the deploy scripts, consumed by both apps

backend/                        Node + TypeScript; three services in one process
  src/
    index.ts                    boots price service, indexer, relayer, API
    config.ts                   env + deployment file, zipped into a token list
    services/
      relayer.ts                the state machine; XRPL deposit → settlement
      fdcClient.ts              prepareRequest → FdcHub → round finality → proof retrieval
      xrplWatcher.ts            live subscription + periodic backfill sweep
      priceService.ts           FTSOv2 poller and in-memory cache
      indexer.ts                replays chain logs into SQLite
    api/server.ts               REST + WebSocket
    db/index.ts                 SQLite schema and queries
    lib/                        flare.ts · xrplUtils.ts · logger.ts · bus.ts
  test/units.test.ts            24 tests on the cross-chain encoding boundary

frontend/                       Next.js 16 App Router
  src/
    app/                        / /swap /intent/[id] /dashboard /pool /explorer /docs
    components/                 Navbar, Footer, Toast, ProgressStepper, DepositInstructions,
                                IntentTable, PriceTicker, StatusBadge, ui primitives
    lib/                        api · wallet (EIP-6963) · contracts · hooks · format · constants
    abis/                       GENERATED — do not edit

scripts/use-network.sh          flips backend + frontend to the same chain, atomically
docs/DEMO.md                    timed demo runbook with a failure-mode table
docs/SUBMISSION.md              hackathon submission checklist and copy
```

---

## 7. Contracts in detail

### `IntentManager.sol`

The entry point and canonical record of intent. **It never moves value.**

```solidity
function createIntent(
    uint8   sourceChain,        // 0 = XRPL
    uint256 sourceAmount,       // drops
    address destinationToken,
    uint256 minOutputAmount,    // absolute floor
    uint256 deadline,
    uint16  maxSlippageBps
) external returns (bytes32 intentId, string memory depositAddress, uint32 destinationTag);
```

**Why intents live on-chain at all:**

- The `intentId` doubles as the XRPL payment reference, so the deposit is cryptographically bound
  to the terms the user signed for.
- `minOutputAmount` / `deadline` / `maxSlippageBps` are committed *before* the deposit, so a
  relayer cannot settle on worse terms than the user accepted.
- Anyone can audit the full order book without trusting our backend.

`intentId = keccak256(abi.encode(chainid, address(this), user, nonce))` — domain-separated so an
id can never be replayed on another chain or deployment.

**Lifecycle:** `None → Pending → Deposited → Settling → Settled`, with `Expired` and `Cancelled`
as terminal branches. Cancellation is only allowed while `Pending`: once a deposit is observed the
funds are in flight on XRPL, so cancelling would strand them.

**Guards:** min/max deposit per source chain, `MAX_SLIPPAGE_BPS = 5000`, deadline window of
5 minutes to 7 days, `Ownable2Step`, `Pausable`.

### `IntentSettler.sol`

Covered in [§3](#3-the-security-model). Two entry points:

- `settleIntent(intentId, proof)` — reverts with a decodable custom error on failure.
- `trySettleIntent(intentId, proof)` — wraps the above in try/catch and emits
  `SettlementFailed(intentId, reason)` instead of reverting, giving the relayer an on-chain audit
  trail. A failed attempt is fully atomic, so the intent is left exactly as it was.

`quote(sourceChain, sourceAmount, destinationToken, maxSlippageBps)` is a view function returning
`(expectedOutput, ammOutput, minimumOutput, protocolFeeAmount, priceImpactBps)`. **The frontend
uses this rather than recomputing** — what the UI shows and what the contract will enforce cannot
drift apart.

### `PriceOracle.sol`

A thin wrapper over FTSOv2 that adds three things:

1. **Address resolution** through the canonical `FlareContractRegistry`
   (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`, identical on Flare, Songbird, Coston, Coston2).
2. **A staleness guard** — a value older than `maxPriceAge` (default 300s) reverts rather than
   silently pricing a swap off a dead feed. *This means a dead feed halts settlement; it does not
   mis-price it.*
3. **Decimal normalisation** to 18 dp, handling FTSO's signed `int8` decimals including negative
   values.

Everything is `view`, which is why `FtsoV2Reader` exists: the production
`FtsoV2Interface.getFeedById` is declared `payable` so a per-feed fee could be charged in future.
It writes no storage when the fee is zero — the case for every standard feed — so FlareSwap reads
it through `staticcall`. If Flare ever prices a feed we use, the staticcall reverts loudly rather
than returning a stale number.

**Feed ids** are 21 bytes: `0x01` (crypto category) + the ASCII name, right-padded to 20.

```
FLR/USD   0x01464c522f55534400000000000000000000000000
XRP/USD   0x015852502f55534400000000000000000000000000
USDC/USD  0x01555344432f555344000000000000000000000000
```

`FeedIds.t.sol` re-derives every constant from its human-readable name and cross-checks FLR/USD
against Flare's published value — the cheapest high-value test in the suite, because a wrong feed
id would silently price swaps off the wrong asset.

### `LiquidityPool.sol`

Constant-product (x·y=k) AMM with ERC-20 LP shares. One pool per FXRP/destination pair. Three
deliberate differences from a stock Uniswap-V2 fork:

- **Reserves are explicit, not balance-derived.** `reserve0`/`reserve1` are updated from measured
  transfer deltas, so a direct token donation cannot move the price — it accumulates as an
  untracked surplus for `skim()`. This closes the first-depositor inflation vector and keeps the
  settler's FTSO-based slippage bound meaningful.
- **Transfer deltas, not requested amounts.** Every pull measures `balanceOf` before and after, so
  a fee-on-transfer or rebasing token cannot over-credit a swapper.
- **`MINIMUM_LIQUIDITY` burned** on the first deposit so `totalSupply` can never return to zero
  while reserves are non-zero.

Swap fee is 30 bps by default, capped at 100 bps. Also exposes `previewAddLiquidity`,
`previewRemoveLiquidity`, `getAmountIn`, `priceImpactBps` and `spotPrice0In1` for the UI.

### Minter adapters

`IntentSettler` only ever talks to `IFxrpMinter`:

```solidity
interface IFxrpMinter {
    function fAsset() external view returns (address);
    function previewMint(uint256 underlyingAmount) external view returns (uint256);
    function mint(uint256 underlyingAmount, address recipient, IPayment.Proof calldata proof)
        external returns (uint256 minted);
}
```

**`FAssetsMinter`** — production. FAssets minting is two-phase and this contract owns both halves:
an operator calls `reserveCollateral` before the user pays (making this contract the minter of
record and locking an agent's collateral, filed under the intent's payment reference); then
`mint` looks up that reservation and calls `AssetManager.executeMinting` with the same proof the
settler just verified. It measures the FXRP **balance delta** rather than trusting a return value,
so the agent's minting fee is accounted for correctly.

**`PooledFxrpMinter`** — testnet/demo. Releases pre-minted FXRP from a reserve. **Identical trust
boundary** — only reachable after a verified FDC proof — but it sources the FXRP from a reserve
the operator topped up in advance, so a scripted demo does not depend on third-party agent
availability. Rescales if the FAsset and underlying disagree on decimals.

---

## 8. Backend services in detail

Three services in one process, independent by design. Running without `RELAYER_PRIVATE_KEY` gives
a **read-only** instance that still serves the entire frontend — which is what you want for a
public deployment where only one node should be relaying.

### Intent Relayer (`services/relayer.ts`)

A state machine, one step per tick, every step idempotent so a crash between any two is
recoverable by simply running again:

```
PENDING ──deposit seen──▶ DEPOSITED ──FdcHub──▶ ATTESTATION_REQUESTED
   │                                                    │
   │                                           round finalised
   ▼                                                    ▼
EXPIRED ◀──deadline───────────────────────────  ATTESTATION_READY
                                                        │
                                                 settleIntent
                                                        ▼
                                                    SETTLED
```

**On boot it refuses to start if its deposit address does not match the on-chain configuration.**
Getting this wrong produces a confusing failure much later — every settlement reverting with
`WrongReceivingAddress` *after* users have already parted with real XRP.

**Before spending gas** it `staticCall`s `settleIntent`. A revert there costs nothing and gives a
decodable custom error, whereas a failed transaction costs gas and reports only
"execution reverted".

**Matching a deposit to an intent** is by memo, which is authoritative — it is what the FDC will
report as `standardPaymentReference`. The destination tag is a fallback for wallets that drop
memos; it lets the UI *show* the deposit was seen even though settlement will fail without the
memo.

### FDC client (`services/fdcClient.ts`)

```
1. verifier.prepareRequest(txId)     → canonical ABI-encoded request (embeds a message
                                       integrity code we cannot compute ourselves)
2. FdcHub.requestAttestation(req)    → paid with getRequestFee(); lands in a voting round
3. Relay.isFinalized(200, round)     → poll until the round's Merkle root is committed
4. DA layer proof-by-request-round-raw → Merkle proof + ABI-encoded response
```

Steps 1 and 4 are off-chain conveniences; **the security comes from step 3**, and nothing this
client returns is trusted — `IntentSettler` re-verifies against the on-chain root.

The voting round is derived from the **mined block's timestamp**, not `Date.now()`: a request
submitted near a round boundary would otherwise be looked up in the wrong round and the proof
would never be found.

The `-raw` endpoint is used deliberately. The Merkle leaf is `keccak256(abi.encode(response))`, so
re-encoding from a decoded JSON variant risks a field-ordering or numeric-width mismatch that
would produce a proof the settler rejects. Decoding the exact bytes the DA layer served cannot
drift.

### XRPL watcher (`services/xrplWatcher.ts`)

Two paths feed the same handler:

- a **live subscription**, which notices deposits within a ledger close (~4s);
- a **backfill sweep** over `account_tx` on connect and on a 60s timer, recovering anything that
  arrived while the process was down or reconnecting.

The handler is idempotent because it keys off the XRPL transaction hash, which has a unique index
in the database.

It uses `delivered_amount` from the metadata rather than the transaction's `Amount` field: partial
payments can deliver less than `Amount` says, and the FDC correctly attests to what was actually
delivered. Trusting `Amount` would make the relayer request attestations that then fail the
settler's `DepositTooSmall` check.

### Indexer (`services/indexer.ts`)

Replays `IntentCreated`, `IntentCancelled`, `IntentSettled` and `IntentExpired` into SQLite, in
2000-block chunks (comfortably under every public RPC's `eth_getLogs` cap), with a persisted
cursor.

The relayer could work purely from its own bookkeeping, but then an intent created while the
backend was down would be invisible forever. Replaying from the chain makes the database a
**derived cache that any restart can rebuild**.

### Price service (`services/priceService.ts`)

Polls FTSOv2 through `PriceOracle` every 2s and serves the last good value from memory. Caching is
safe because it is only ever used for *display* and for sizing an intent — the binding price check
happens inside `IntentSettler`, reading FTSO directly at settlement time.

A single missing feed is normal on testnets, so it keeps serving the last good value and only logs
loudly when *every* feed fails.

---

## 9. Frontend

Seven pages plus a shared layout.

| Route | Purpose |
|---|---|
| `/` | Landing — hero, problem/solution, the three Flare protocols, live stats, live FTSO ticker |
| `/swap` | The core product: amount, destination picker, live quote, slippage/deadline, create intent, then deposit instructions |
| `/intent/[id]` | Six-step progress stepper, terms, event timeline, explorer links on both chains, cancel/retry |
| `/dashboard` | Portfolio valued via FTSO, intent history with status filters |
| `/pool` | Per-pair pool selector, reserves, TVL, volume, add/remove liquidity |
| `/explorer` | Public anonymised intent feed, aggregate stats, live oracle-feed health table |
| `/docs` | Architecture, per-protocol explanation with code, live contract addresses, FAQ |

**Everything is driven by `/api/config`** — the UI hard-codes no contract address, so a redeploy is
picked up by a refresh.

**Wallet connection uses EIP-6963.** `window.ethereum` is a single global slot that every wallet
extension races to claim; with more than one installed the winner is arbitrary, and some inject a
proxy that throws opaque errors when it does not own the slot. EIP-6963 sidesteps the fight
entirely — wallets announce themselves and the app picks one deliberately, preferring MetaMask,
then any announced wallet, then the legacy global. Detection is asynchronous (extensions inject
after mount), and connection failures are rendered as a dismissible banner with a
"Technical details" disclosure rather than failing silently.

**Live updates** come from one shared WebSocket with refcounted subscribers and exponential
backoff reconnection — a socket per hook would multiply connections by the number of mounted
components.

---

## 10. HTTP + WebSocket API

Base URL: `http://localhost:4000`.

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness, chain id, deployment presence, price health, relayer status |
| `GET /api/config` | Addresses, destination token list, XRPL deposit address, explorer links |
| `GET /api/prices` | All cached FTSOv2 feeds |
| `GET /api/prices/:symbol` | One feed |
| `GET /api/quote` | `?amount=<drops>&to=<address>&slippageBps=<n>` — read from `IntentSettler.quote` |
| `GET /api/intents` | `?user=&status=&limit=&offset=` — comma-separated statuses |
| `GET /api/intents/:id` | Intent, event log, explorer links, and the exact XRPL payment to sign |
| `POST /api/intents/:id/retry` | Push one intent through the relayer immediately |
| `GET /api/pool` | `?token=<address>` — one pool; defaults to the first configured |
| `GET /api/pools` | Every pool |
| `GET /api/stats` | Volume, counts, average settlement time, success rate |
| `WS /ws` | `{type: "prices" \| "intent" \| "intent:event" \| "stats" \| "hello"}` |

Example:

```bash
curl "localhost:4000/api/quote?amount=500000000&to=0x3228...&slippageBps=100"
```
```json
{
  "sourceAmount": "500000000", "sourceSymbol": "XRP",
  "destinationSymbol": "USDC",
  "expectedOutput": "311462800",   // FTSO fair value, net of protocol fee
  "ammOutput":      "310143055",   // what the pool would actually pay
  "minimumOutput":  "308348172",   // the floor the settler will enforce
  "protocolFee":    "1500000",
  "priceImpactBps": 42,
  "rate": "0.62028611"
}
```

---

## 11. Design decisions

**Two different slippage protections, deliberately separated.** `maxSlippageBps` is checked
against FTSO *at settlement time*, so it tracks the market while the deposit is in flight.
`minOutputAmount` is an absolute number fixed at creation. The UI sets the absolute floor **5%
below** the relative one on purpose: setting it to the quote-time floor would mean an ordinary 2%
price move permanently strands a swap that was perfectly fair in relative terms, requiring a
manual refund. Conflating these two is the classic way intent systems produce stuck deposits.

**The database is a cache, never the source of truth.** Every row is rebuildable from chain logs.
It exists so the frontend can filter and paginate without hammering an RPC node, and so the
relayer remembers where each deposit sits inside the FDC pipeline — the one piece of state the
chain genuinely does not have.

**`settleIntent` is permissionless by default.** The proof authorises settlement, not the caller,
and the output can only go to `intent.user`.

**The XRPL memo is load-bearing.** A 32-byte `MemoData` carrying the `intentId`, which the FDC
reports as `standardPaymentReference`. `standardAddressHash` is `keccak256(bytes(address))` — the
deploy script, the relayer and the contracts all compute it identically, and the relayer refuses
to start if its deposit address does not match the on-chain one.

**Explicit reserve accounting over balance-derived.** See
[`LiquidityPool`](#liquiditypoolsol) above.

**ABIs are generated as TypeScript, not JSON.** A JSON import needs a `with { type: "json" }`
attribute under NodeNext ESM, and bundlers disagree about it. A plain `export const` works
identically in the Node backend and in Next.js with zero config. The two consumers get different
relative-import extensions (`.js` for NodeNext, bare for Next's bundler) because there is no
spelling that satisfies both.

**Next.js 16, not 14.** The build guide specified Next 14, but it ships with unpatched critical
advisories and npm's fix path resolves to exactly 16.2.12. App Router code is compatible. Three
`high` transitive advisories remain (postcss nested inside next, and sharp) with no fix short of
downgrading to next@9 — image optimization is disabled, so sharp is unused.

---

## 12. Testing

```bash
cd contracts && forge test -vv     # 138 passing
cd backend   && npm test           # 24 passing
```

### Contracts (138)

| Suite | Covers |
|---|---|
| `IntentSettler.t.sol` (43) | Each of the seven proof checks failing independently; replay across intents; deadline; slippage vs a diverged pool; stale oracle; permissionless toggle; pause; try/catch; fuzz |
| `IntentManager.t.sol` (30) | Creation guards, cancellation rules, lifecycle transitions, authorisation, two-step ownership |
| `LiquidityPool.t.sol` (21) | Add/remove/swap, fee, donation resistance, price impact, previews, fuzz on the k-invariant |
| `PriceOracle.t.sol` (21) | Quotes across decimals, negative feed decimals, staleness, slippage maths, fuzz |
| `FAssetsMinter.t.sol` (14) | Reserve→execute, agent fee accounting, replay, authorisation, decimal rescaling |
| `FeedIds.t.sol` (9) | Every feed id re-derived and cross-checked against Flare's published value |

**The FDC mock performs real Merkle verification** rather than returning `true`. It reproduces the
production algorithm — leaf is `keccak256(abi.encode(response))`, verified against the round's
committed root — so a tampered amount, a swapped payment reference or a forged receiving address
fails in the test suite exactly as it would on mainnet.

Notable fuzz properties: a swap never decreases `k`; reserves always equal balances absent
donations; add-then-remove liquidity is never profitable; settlement never pays below the oracle
floor and the settler never retains any token; one source transaction settles at most once.

### Backend (24)

Pins the encoding boundary — address hashing, memo encode/decode, drops conversion, feed ids,
attestation ids, `Response` ABI round-tripping, and XRPL payment parsing including partial
payments and issued-currency rejection. A silent divergence here surfaces as a settlement that
reverts *after* a user has already sent real XRP.

### End-to-end verification

Verified on a local node: intent created on-chain → indexer picked it up → FDC proof verified →
FXRP minted → swapped → **500 XRP settled to 310.374154 USDC**, matching the API quote exactly.
All four destinations quote correctly, including WFLR at 18 decimals across the decimal boundary.

---

## 13. Adding a destination token

Adding a token is **one entry in `contracts/script/TokenSet.sol`** plus liquidity. No contract
change, because `configureToken` and `setPool` are already per-token.

```solidity
specs[4] = Spec({
    symbol:   "WETH",
    name:     "Wrapped Ether",
    decimals: 18,
    feedId:   FeedIds.ETH_USD,   // must exist — the settler prices against it
    seedFxrp: 100_000e6,
    isFAsset: false
});
```

Then redeploy (or call `configureToken` + `setPool` on the live contracts), run
`./contracts/script/export-abis.sh`, and the UI picks it up from `/api/config` on the next
refresh — the frontend has no token list of its own.

**A token without an FTSO feed cannot be listed.** `IntentSettler` prices every swap against one
and enforces the slippage floor from it.

---

## 14. Configuration reference

### `backend/.env`

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | `114` | Selects `contracts/deployments/<id>.json` |
| `FLARE_RPC_URL` | Coston2 public RPC | |
| `RELAYER_PRIVATE_KEY` | — | Absent ⇒ read-only instance |
| `XRPL_WS_URL` | `wss://s.altnet.rippletest.net:51233` | |
| `XRPL_DEPOSIT_ADDRESS` | from deployment file | Deployment file wins, keeping it in lockstep |
| `XRPL_SOURCE_ID` | `testXRP` | `XRP` on mainnet |
| `FDC_VERIFIER_URL` / `_API_KEY` | testnet verifier | Required to request attestations |
| `FDC_DA_LAYER_URL` / `_API_KEY` | Coston2 DA layer | Required to retrieve proofs |
| `FDC_PROTOCOL_ID` | `200` | FDC's protocol id on `Relay` |
| `PORT` / `CORS_ORIGIN` | `4000` / `http://localhost:3000` | |
| `DATABASE_PATH` | `./data/flareswap.db` | |
| `PRICE_POLL_INTERVAL_MS` | `2000` | FTSO updates at ~1.8s; faster just wastes RPC |
| `RELAYER_TICK_INTERVAL_MS` | `5000` | |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | |
| `INDEXER_START_BLOCK` | deployment block | |

### `frontend/.env.local`

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend origin; the WebSocket URL is derived from it |
| `NEXT_PUBLIC_CHAIN_ID` | **Inlined at build time** — restart `next dev` after changing |

### Deploy-script environment

`PRIVATE_KEY` · `XRPL_DEPOSIT_ADDRESS` · `XRPL_SOURCE_ID` · `FXRP_ADDRESS` ·
`<SYMBOL>_ADDRESS` (e.g. `USDC_ADDRESS`, to use an existing token) · `ASSET_MANAGER_ADDRESS` ·
`RELAYER_ADDRESS` · `FEE_RECIPIENT` · `SEED_POOLS` · `MIN_DEPOSIT_DROPS` · `MAX_DEPOSIT_DROPS`

Use `./scripts/use-network.sh {local|coston2|flare}` to switch both apps atomically — it rewrites
only the network keys and preserves any secrets already in the files.

---

## 15. Troubleshooting

**"Backend not reachable" in the UI** — the backend isn't running, or there is no deployment for
the configured chain. Check `curl localhost:4000/health`; `deployed: false` means the
`deployments/<chainId>.json` file is missing.

**Deploy lands N-1 of N transactions** — you omitted `--slow`.

**Wallet button does nothing** — open the wallet extension directly from the toolbar. Error
`-32002` means a connection request is already queued and the popup did not come to the front;
clicking again queues more rejections. The app now surfaces this as a banner. If the banner shows
something else, the console has the serialised error and the list of announced providers.

**Every settlement reverts with `WrongReceivingAddress`** — the relayer's `XRPL_DEPOSIT_ADDRESS`
does not match what `IntentManager` was configured with. The relayer logs this on boot; re-run the
deploy or fix the env var.

**Settlement reverts on slippage** — the pool has drifted from the FTSO rate. Re-run
`Seed.s.sol`, or widen slippage. *This is the protection working, not a bug.*

**`PriceStale`** — an FTSO feed is older than 300s. On a local devnet this happens when Anvil
sits idle; mine a block or re-run the price seeding.

**Frontend ignores a chain change** — `NEXT_PUBLIC_*` are inlined at build time. Restart
`next dev`.

**Settling manually on the local devnet** (the mock FDC accepts any root you publish):

```bash
RPC=http://127.0.0.1:8545; D=contracts/deployments/31337.json
FDC=$(jq -r '.transactions[]|select(.contractName=="MockFdcVerification")|.contractAddress' \
      contracts/broadcast/DeployLocal.s.sol/31337/run-latest.json)
# build the Response tuple, compute the leaf with FDC.leafFor(), setMerkleRoot, then settleIntent
```

A complete working script is reproduced in the transcript of this project's development; the short
version is: `leafFor(response)` → `setMerkleRoot(round, leaf)` → `settleIntent(id, ([], response))`.

---

## 16. Current status and known limits

Being explicit about what is proven and what is not.

### Verified working

- Intent creation, indexing, cancellation, expiry
- FTSOv2 pricing through `PriceOracle`, including the 300s staleness guard
- Quotes from `IntentSettler.quote`, matching settlement output exactly
- **Full on-chain settlement**: proof verification → mint → fee → swap → delivery
- All four destinations, including 18-decimal WFLR
- Three AMM pools, add/remove liquidity, donation resistance
- The complete frontend against live backend data

### Not yet exercised

- **The relayer has never run end to end.** `xrplWatcher.ts` has never connected to a live XRP
  Ledger, and `fdcClient.ts` has never executed — not one line, in any run. The local settlements
  above were driven by publishing a Merkle root directly to the mock verifier, which **bypasses
  the entire relayer pipeline**.
- Closing this needs a Coston2 deployment, an FDC verifier API key, a funded operator wallet and
  a real XRPL testnet payment. `fdcClient.ts` is where I would expect the first bug: endpoint
  shapes, API-key headers and DA-layer response field names are the only things I could not test.

### Known limits

- **Unaudited testnet software.** Do not put real value into it.
- A deposit sent **without the memo** cannot be settled on-chain and needs a manual refund. The UI
  warns prominently; a production version would use a per-intent deposit address to make the
  mistake impossible.
- If an intent expires with a deposit in flight, refunding is an off-chain operator action. The
  contracts deliberately have **no owner-controlled escape hatch** that could move user funds.
- `PooledFxrpMinter` is the testnet default — same trust boundary, but a pre-minted reserve rather
  than a live collateral reservation.
- BTC is configured as source chain 1 but not enabled; adding it is a config call plus an FBTC
  pool, not a code change.
- The protocol fee and pool fee are both fixed at 30 bps; no fee tiers.

---

## 17. Roadmap

- **Solver network** — competitive fills instead of a single AMM route
- **FBTC and FDOGE** as source assets, reusing the same settler
- **Route through an existing Flare DEX** (SparkDEX, BlazeSwap) rather than our own pool
- **Per-intent deposit addresses**, removing the memo failure mode entirely
- **Partial fills** for large intents
- Mainnet launch

---

## Licence and credits

MIT. Built for the [Flare Summer Signal Hackathon](https://dorahacks.io/hackathon/flaresummersignal).

Flare protocol documentation: [dev.flare.network](https://dev.flare.network) ·
[FDC](https://dev.flare.network/fdc/overview) ·
[FTSOv2](https://dev.flare.network/ftso/overview) ·
[FAssets](https://dev.flare.network/fxrp/overview)

`FlareContractRegistry` — `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same on all Flare networks)

Further reading: [`docs/DEMO.md`](docs/DEMO.md) · [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
