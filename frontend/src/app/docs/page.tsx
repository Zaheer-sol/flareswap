"use client";

import {useAppConfig} from "@/lib/hooks";
import {AddressChip, ExternalLink, PageHeader, Section} from "@/components/ui";
import {DEFAULT_CHAIN_ID, LINKS, chainInfo, explorerAddressUrl} from "@/lib/constants";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

export default function DocsPage() {
  const {data: config} = useAppConfig();
  const chain = chainInfo(DEFAULT_CHAIN_ID);

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <PageHeader
        eyebrow="Technical"
        title="How FlareSwap works"
        description="The full path a swap takes, and exactly which Flare protocol is responsible for each step."
      />

      {/* ------------------------------ overview ----------------------------- */}
      <Section title="Architecture">
        <div className="card p-5 sm:p-6">
          <pre className="mono overflow-x-auto whitespace-pre text-[11px] leading-relaxed text-slate-400">
{`  User (XRPL wallet)
        │  1. Payment: amount + destination tag + 32-byte memo = intentId
        ▼
   ┌──────────┐      2. relayer requests attestation
   │   XRPL   │ ───────────────────────────────────────────┐
   └──────────┘                                            ▼
                                                    ┌─────────────┐
                                                    │  Flare FDC  │  validators attest
                                                    └──────┬──────┘
                                                           │ Merkle proof
   ┌──────────────┐   0. createIntent                      ▼
   │ IntentManager│◀────────────── User (Flare wallet)  ┌───────────────┐
   └──────┬───────┘                                     │ IntentSettler │
          │  terms: minOut, deadline, slippage          └───┬───────────┘
          │                                                 │ verifyPayment ✓
          └────────────────── lock / settle ────────────────┤
                                                            │ 3. mint FXRP  (FAssets)
                                                            │ 4. quote      (FTSOv2)
                                                            │ 5. swap       (LiquidityPool)
                                                            ▼
                                                    User receives USDC`}
          </pre>
        </div>
      </Section>

      {/* --------------------------- Flare protocols -------------------------- */}
      <Section title="Flare integration" description="Three protocols, three distinct jobs">
        <div className="space-y-4">
          <ProtocolCard
            name="FDC — Flare Data Connector"
            role="Proves the XRPL deposit happened"
            href={LINKS.fdcDocs}
            points={[
              "The relayer submits a Payment attestation request for the XRPL transaction to FdcHub.",
              "Flare's validators independently verify it and commit a Merkle root for that voting round.",
              "IntentSettler calls FdcVerification.verifyPayment(proof) and only proceeds if it returns true.",
              "Without FDC this would need a trusted oracle to confirm deposits. With it, a compromised relayer still cannot invent a deposit.",
            ]}
            code={`// resolved live from the Flare registry
IFdcVerification fdc = fdcVerification();
if (!fdc.verifyPayment(proof)) revert InvalidProof(intentId);

// then bind the proof to this specific intent
if (body.standardPaymentReference != intent.intentId) revert PaymentReferenceMismatch(...);
if (body.receivingAddressHash != source.depositAddressHash) revert WrongReceivingAddress(...);
if (body.receivedAmount < int256(intent.sourceAmount)) revert DepositTooSmall(...);
if (settledByTx[txId] != bytes32(0)) revert ProofAlreadyUsed(...);  // one payment, one intent`}
          />

          <ProtocolCard
            name="FTSOv2 — Time Series Oracle"
            role="Prices every quote and bounds every fill"
            href={LINKS.ftsoDocs}
            points={[
              "Block-latency feeds (~1.8s) for XRP/USD and USDC/USD, read through the canonical contract registry.",
              "PriceOracle rejects any value older than 300 seconds, so a dead feed stops settlement instead of mis-pricing it.",
              "IntentSettler computes the oracle fair value and enforces a floor at the user's slippage tolerance — the AMM output must clear it.",
              "The rate shown on the swap screen is the same number the contract will use.",
            ]}
            code={`// feed id = 0x01 (crypto) + ASCII name, right-padded to 21 bytes
bytes21 constant XRP_USD = 0x015852502f55534400000000000000000000000000;

uint256 expected = priceOracle.getQuote(
    source.feedId, destination.feedId, swapAmount, fAssetDecimals, destination.decimals
);
uint256 floor = priceOracle.slippageFloor(expected, intent.maxSlippageBps);
uint256 minOut = Math.max(intent.minOutputAmount, floor);   // the stricter of the two binds`}
          />

          <ProtocolCard
            name="FAssets — FXRP"
            role="Turns proven XRP into an ERC-20 on Flare"
            href={LINKS.fassetsDocs}
            points={[
              "The settler talks to an IFxrpMinter interface, not to FAssets directly.",
              "FAssetsMinter is the production path: it reserves agent collateral ahead of the deposit, then calls AssetManager.executeMinting with the same proof the settler just verified.",
              "PooledFxrpMinter is the testnet path: it releases pre-minted FXRP from a reserve, keeping the demo independent of third-party agent availability.",
              "Both measure the balance delta rather than assuming 1:1, so an agent's minting fee is accounted for correctly.",
            ]}
            code={`interface IFxrpMinter {
    function fAsset() external view returns (address);
    function previewMint(uint256 underlyingAmount) external view returns (uint256);
    function mint(uint256 underlyingAmount, address recipient, IPayment.Proof calldata proof)
        external returns (uint256 minted);
}
// swapping the implementation changes nothing upstream in IntentSettler`}
          />
        </div>
      </Section>

      {/* ------------------------------ contracts ---------------------------- */}
      <Section title="Deployed contracts" description={chain.name}>
        {config ? (
          <div className="card divide-y divide-white/5">
            {(
              [
                ["IntentManager", config.contracts.intentManager, "Stores intents and their lifecycle"],
                ["IntentSettler", config.contracts.intentSettler, "Verifies FDC proofs, mints, swaps, delivers"],
                ["PriceOracle", config.contracts.priceOracle, "FTSOv2 wrapper with staleness guards"],
                ["Minter", config.contracts.minter, config.usesFAssets ? "FAssetsMinter" : "PooledFxrpMinter"],
                ...config.tokens.map(
                  (token) =>
                    [
                      token.symbol,
                      token.address,
                      token.isFAsset ? "FAsset ERC-20, delivered without a swap" : `Destination token (${token.decimals} dp)`,
                    ] as const,
                ),
                ...config.tokens
                  .filter((token) => token.pool)
                  .map(
                    (token) =>
                      [`FXRP/${token.symbol} pool`, token.pool!, "Constant-product AMM"] as const,
                  ),
              ] as const
            ).map(([name, address, description]) => (
              <div key={name} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{name}</p>
                  <p className="text-[11px] text-slate-600">{description}</p>
                </div>
                <AddressChip address={address} href={explorerAddressUrl(DEFAULT_CHAIN_ID, address) ?? undefined} />
              </div>
            ))}

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-200">FlareContractRegistry</p>
                <p className="text-[11px] text-slate-600">
                  Canonical — identical on Flare, Songbird, Coston and Coston2
                </p>
              </div>
              <AddressChip address={REGISTRY} href={explorerAddressUrl(DEFAULT_CHAIN_ID, REGISTRY) ?? undefined} />
            </div>

            {config.xrpl.depositAddress ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">XRPL deposit address</p>
                  <p className="text-[11px] text-slate-600">
                    Source id <span className="mono">{config.xrpl.sourceId}</span> ·{" "}
                    {config.xrpl.network}
                  </p>
                </div>
                <AddressChip
                  address={config.xrpl.depositAddress}
                  href={
                    config.xrpl.network === "mainnet"
                      ? `https://livenet.xrpl.org/accounts/${config.xrpl.depositAddress}`
                      : `https://testnet.xrpl.org/accounts/${config.xrpl.depositAddress}`
                  }
                />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="card p-6 text-sm text-slate-500">
            Contracts are not deployed on this network yet, or the backend is unreachable.
          </div>
        )}
      </Section>

      {/* --------------------------------- FAQ -------------------------------- */}
      <Section title="FAQ">
        <div className="space-y-3">
          <Faq question="What stops the relayer from stealing my deposit?">
            Nothing it could do would help. <span className="text-slate-300">IntentSettler</span>{" "}
            derives everything from the FDC proof: the output always goes to{" "}
            <code className="mono text-flare-300">intent.user</code>, the amount is bounded by the
            terms you signed, and the payment reference must equal your intent id. The relayer only
            chooses <em>when</em> to submit — and since{" "}
            <code className="mono text-flare-300">settleIntent</code> is permissionless, anyone can
            do that if it stops.
          </Faq>

          <Faq question="Why does the memo matter so much?">
            The FDC reports the XRPL memo as{" "}
            <code className="mono text-flare-300">standardPaymentReference</code>, and the settler
            requires it to equal your intent id. That is the cryptographic link between a payment on
            one chain and terms committed on another. A deposit without the memo is a real payment
            with no provable owner, and can only be refunded manually.
          </Faq>

          <Faq question="What happens if the price moves while my deposit is in flight?">
            Your slippage tolerance is checked against FTSO <em>at settlement time</em>, so it
            tracks the market rather than a stale quote. The absolute minimum written into the
            intent is deliberately set well below that, as a disaster backstop — otherwise an
            ordinary 2% move would strand a perfectly fair swap.
          </Faq>

          <Faq question="Can one XRPL payment settle two intents?">
            No. The settler records{" "}
            <code className="mono text-flare-300">settledByTx[transactionId]</code> before any value
            moves, so a second attempt with the same transaction reverts with{" "}
            <code className="mono text-flare-300">ProofAlreadyUsed</code>. Without that guard, one
            real deposit could drain the FXRP reserve across many intents.
          </Faq>

          <Faq question="What are the fees?">
            0.30% protocol fee, taken from the minted FXRP before the swap, plus the pool&rsquo;s
            0.30% swap fee which goes to liquidity providers. Both are shown in the quote before you
            commit. You also pay gas on Flare for the intent transaction, and the XRPL network fee
            (~12 drops) on your deposit.
          </Faq>

          <Faq question="Is this audited?">
            No. This is hackathon software on Coston2 testnet. The contracts have a 138-test Foundry
            suite including fuzz tests for the AMM invariant and the replay guard, but that is not a
            substitute for an audit. Do not put real value into it.
          </Faq>
        </div>
      </Section>

      <Section title="Further reading">
        <div className="card flex flex-wrap gap-x-6 gap-y-2 p-5 text-sm">
          <ExternalLink href={LINKS.flareDevHub}>Flare Developer Hub</ExternalLink>
          <ExternalLink href={LINKS.fdcDocs}>FDC documentation</ExternalLink>
          <ExternalLink href={LINKS.ftsoDocs}>FTSOv2 documentation</ExternalLink>
          <ExternalLink href={LINKS.fassetsDocs}>FAssets / FXRP</ExternalLink>
          <ExternalLink href={LINKS.github}>Source code</ExternalLink>
        </div>
      </Section>
    </div>
  );
}

function ProtocolCard({
  name,
  role,
  points,
  code,
  href,
}: {
  name: string;
  role: string;
  points: string[];
  code: string;
  href: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/5 px-5 py-4">
        <div>
          <h3 className="text-sm font-bold text-flare-300">{name}</h3>
          <p className="mt-0.5 text-xs text-slate-400">{role}</p>
        </div>
        <ExternalLink href={href} className="text-[11px]">
          docs
        </ExternalLink>
      </div>

      <ul className="space-y-2 px-5 py-4">
        {points.map((point) => (
          <li key={point} className="flex gap-2.5 text-xs leading-relaxed text-slate-400">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-flare-500/60" />
            {point}
          </li>
        ))}
      </ul>

      <pre className="mono overflow-x-auto border-t border-white/5 bg-ink-950/70 px-5 py-4 text-[11px] leading-relaxed text-slate-400">
        {code}
      </pre>
    </div>
  );
}

function Faq({question, children}: {question: string; children: React.ReactNode}) {
  return (
    <details className="card group px-5 py-4">
      <summary className="cursor-pointer list-none text-sm font-medium text-slate-200 marker:content-none">
        <span className="flex items-center justify-between gap-4">
          {question}
          <span className="shrink-0 text-slate-600 transition-transform group-open:rotate-45" aria-hidden>
            +
          </span>
        </span>
      </summary>
      <div className="mt-3 text-xs leading-relaxed text-slate-400">{children}</div>
    </details>
  );
}
