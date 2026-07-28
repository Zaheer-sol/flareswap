# Submission checklist

Hackathon: [dorahacks.io/hackathon/flaresummersignal](https://dorahacks.io/hackathon/flaresummersignal)

---

## Form fields

| Field | Value |
|---|---|
| **Project name** | FlareSwap |
| **Track** | Track 1 — Interoperable Asset Products |
| **Product description** | One-step cross-chain swaps driven by user intents. Deposit XRP on the XRP Ledger, receive USDC (or FXRP) on Flare. Deposits are verified trustlessly by the Flare Data Connector, priced by FTSOv2, and bridged by FAssets. |
| **Target user** | XRP holders who want DeFi access on Flare without bridging, wrapping, or holding gas on two chains |
| **Demo link** | _Vercel URL_ + backup video |
| **GitHub repo** | _public repo_ — contracts, backend, frontend, deploy scripts, tests |
| **Deployment network** | Coston2 (chain 114) |
| **Contract addresses** | fill from `contracts/deployments/114.json`, also rendered live on `/docs` |
| **Roadmap** | Solver network for competitive fills · FBTC/FDOGE source assets · more destination tokens · route through an existing Flare DEX · mainnet |

### Flare integration explanation (paste this)

> FlareSwap uses three Flare protocols, each doing something only it can do.
>
> **FDC** is the trust boundary. When a user deposits XRP, the relayer requests a `Payment`
> attestation from `FdcHub`; Flare's validators independently verify the XRPL transaction and
> commit a Merkle root on-chain. `IntentSettler` calls `FdcVerification.verifyPayment(proof)` and
> then binds the proof to the specific intent — the payment reference must equal the intent id,
> the funds must have reached our configured deposit address, the amount must not be short, and
> the source transaction id must never have settled anything before. Without FDC this would need
> a trusted oracle to confirm deposits; with it, a compromised relayer still cannot invent one.
>
> **FTSOv2** prices everything. `PriceOracle` resolves FTSOv2 through the canonical
> `FlareContractRegistry` and reads XRP/USD and USDC/USD at block latency, rejecting any value
> older than 300 seconds so a dead feed halts settlement rather than mis-pricing it. The settler
> computes the oracle fair value of the trade and refuses any AMM fill below the user's slippage
> tolerance — checked at settlement time, so it tracks the market while the deposit is in flight.
>
> **FAssets** turns the proven XRP into an ERC-20. The settler talks to an `IFxrpMinter`
> interface: `FAssetsMinter` reserves agent collateral and calls `AssetManager.executeMinting`
> with the same proof the settler verified, measuring the balance delta so the agent's minting fee
> is accounted for correctly. `PooledFxrpMinter` is the testnet variant, with the identical trust
> boundary — reachable only after a verified proof — drawing on a pre-minted reserve so the demo
> does not depend on third-party agent availability.

### What was newly built during the hackathon

Everything in the repository: four core contracts plus two minter adapters, hand-written Flare
interfaces, a 138-test Foundry suite, the Node/TypeScript relayer (XRPL watcher, FDC client,
indexer, price service, REST + WebSocket API) with 24 unit tests, and a seven-page Next.js
frontend. No forked contracts. OpenZeppelin is used for ERC-20, Ownable2Step, ReentrancyGuard,
Pausable, SafeERC20, Math and MerkleProof.

---

## Pre-submission checklist

**Contracts**
- [ ] `forge test` green (138 tests)
- [ ] Deployed to Coston2 with `--slow`, `deployments/114.json` committed
- [ ] Pool seeded at the live FTSO rate, minter reserve funded
- [ ] Contracts verified on the Coston2 explorer
- [ ] Ownership on a key you control (`Ownable2Step` — remember `acceptOwnership`)

**Backend**
- [ ] `npm test` green (24 tests), `npm run build` clean
- [ ] Deployed (Railway/Fly/Render) with `RELAYER_PRIVATE_KEY` and `FDC_VERIFIER_API_KEY` set
- [ ] Relayer logged **"deposit address matches on-chain configuration"** on boot
- [ ] Operator wallet funded with C2FLR for gas *and* FDC request fees
- [ ] `/health` returns `ok: true`, `deployed: true`, `prices: true`

**Frontend**
- [ ] `npx next build` clean, all 8 routes
- [ ] Deployed to Vercel with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CHAIN_ID=114`
- [ ] `/docs` renders live contract addresses with working explorer links
- [ ] Full flow exercised on the deployed URL, not just locally

**Demo**
- [ ] End-to-end dry run completed on Coston2 — actual settlement time noted
- [ ] Backup video recorded showing a successful settlement
- [ ] `docs/DEMO.md` rehearsed against a timer

**Repo**
- [ ] README explains the architecture and the security model
- [ ] No secrets committed (`.env` is gitignored; `deployments/*.json` is committed on purpose)
- [ ] Repo is public

---

## Judging-criteria notes

**Flare integration depth.** Three protocols, none decorative. Remove FDC and you need a trusted
oracle; remove FTSO and you cannot bound the fill; remove FAssets and there is nothing to swap.
Point at `IntentSettler._validateProof` — seven distinct checks derived from the attestation — and
at the FDC mock in `test/`, which performs real Merkle verification rather than returning `true`.

**Technical execution.** Own AMM with explicit reserve accounting (donation-resistant), a
per-intent re-entrancy lock implemented as a status transition, single-use proofs keyed by source
transaction id, oracle staleness guards, and a swappable minter interface so the testnet and
production FAssets paths differ in one constructor argument.

**Product thinking.** The two-slippage design is the detail to raise if asked a hard question: the
relative bound is checked live against FTSO so it tracks the market, while the absolute floor sits
deliberately below it so an ordinary price move cannot permanently strand a fair swap. Getting
that wrong is how intent systems produce stuck deposits.

**Honesty.** Known limits are documented in the README rather than hidden — unaudited, memo-less
deposits need manual refunds, expired-with-deposit is an off-chain operator action, and
`PooledFxrpMinter` is the testnet default. Judges find these anyway; naming them first reads as
competence.
