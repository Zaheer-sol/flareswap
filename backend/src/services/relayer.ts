import {config, canRelay, requireDeployment} from "../config.js";
import {intentSettler, intentManager, explorerTxUrl, xrplExplorerTxUrl, getWallet} from "../lib/flare.js";
import {standardAddressHash, type ObservedDeposit} from "../lib/xrplUtils.js";
import {bus} from "../lib/bus.js";
import {createLogger, describeError} from "../lib/logger.js";
import * as store from "../db/index.js";
import type {IntentRecord, IntentStatus} from "../types.js";
import {
  prepareRequest,
  submitAttestationRequest,
  isRoundFinalized,
  retrieveProof,
  toContractProof,
  checkProofAgainstIntent,
} from "./fdcClient.js";
import {xrplWatcher} from "./xrplWatcher.js";

const log = createLogger("relayer");

/** Give up on an intent after this many failed settlement attempts. */
const MAX_ATTEMPTS = 8;

/**
 * The Intent Relayer: the only stateful component in FlareSwap.
 *
 * It advances every intent through a small state machine, one step per tick, and each step is
 * idempotent so a crash between any two of them is recoverable by simply running again:
 *
 *   PENDING ──deposit seen──▶ DEPOSITED ──FdcHub──▶ ATTESTATION_REQUESTED
 *      │                                                     │
 *      │                                            round finalised
 *      ▼                                                     ▼
 *   EXPIRED ◀──deadline──────────────────────────── ATTESTATION_READY
 *                                                            │
 *                                                     settleIntent
 *                                                            ▼
 *                                                        SETTLED
 *
 * The relayer is deliberately *unprivileged*. It cannot redirect an output, alter terms or
 * settle an intent that was not paid for — `IntentSettler` re-derives all of that from the FDC
 * proof. The worst a compromised relayer key can do is stop relaying, which anyone else can
 * then do instead, because `settleIntent` is permissionless.
 */
class Relayer {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private depositAddressHash = "";

  async start(): Promise<void> {
    if (!canRelay()) {
      log.warn(
        "relayer disabled — needs RELAYER_PRIVATE_KEY, a deployment file and XRPL_DEPOSIT_ADDRESS",
      );
      return;
    }

    this.depositAddressHash = standardAddressHash(config.xrpl.depositAddress);
    const wallet = getWallet();
    log.info(`operator ${wallet?.address}`);
    log.info(`deposit address ${config.xrpl.depositAddress}`);
    log.info(`deposit address hash ${this.depositAddressHash}`);

    await this.assertConfigMatchesChain();

    xrplWatcher.onDeposit((deposit) => this.onDeposit(deposit));
    await xrplWatcher.start();

    this.timer = setInterval(() => {
      void this.tick();
    }, config.intervals.relayer);
    log.info(`ticking every ${config.intervals.relayer}ms`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await xrplWatcher.stop();
  }

  /**
   * Fails fast if the relayer is watching a different address than the settler will accept.
   *
   * Getting this wrong produces a confusing failure much later — every settlement reverting with
   * `WrongReceivingAddress` after a user has already parted with real XRP. Better to refuse to
   * start.
   */
  private async assertConfigMatchesChain(): Promise<void> {
    try {
      const onChain = await intentManager().getSourceChainConfig(0);
      const expected: string = onChain.depositAddressHash;
      if (expected.toLowerCase() !== this.depositAddressHash.toLowerCase()) {
        throw new Error(
          `deposit address mismatch: IntentManager expects hash ${expected} but this relayer ` +
            `watches ${config.xrpl.depositAddress} (hash ${this.depositAddressHash}). ` +
            `Re-run the deploy script or fix XRPL_DEPOSIT_ADDRESS.`,
        );
      }
      log.info("deposit address matches on-chain configuration");
    } catch (error) {
      if (describeError(error).includes("deposit address mismatch")) throw error;
      log.warn("could not verify deposit address against chain", describeError(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /*                          deposit ingestion                          */
  /* ------------------------------------------------------------------ */

  /**
   * Matches an observed XRPL payment to an intent.
   *
   * The memo is authoritative — it is what the FDC will report as `standardPaymentReference`
   * and what the settler checks. The destination tag is a fallback for wallets that drop memos;
   * it lets us at least *show* the user their deposit was seen, even though settlement will
   * fail without the memo.
   */
  private async onDeposit(deposit: ObservedDeposit): Promise<void> {
    const existing = store.getIntentByXrplTx(deposit.txHash);
    if (existing) return; // already ingested

    let intent: IntentRecord | null = null;
    let matchedBy = "memo";

    if (deposit.intentId) {
      intent = store.getIntent(deposit.intentId);
    }
    if (!intent && deposit.destinationTag !== null) {
      intent = store.getIntentByDestinationTag(deposit.destinationTag);
      matchedBy = "destination tag";
    }

    if (!intent) {
      log.warn(
        `unmatched deposit ${deposit.txHash} (${deposit.amountDrops} drops) — ` +
          `no intent for memo ${deposit.intentId ?? "none"} / tag ${deposit.destinationTag ?? "none"}`,
      );
      return;
    }

    if (intent.status !== "PENDING") {
      log.debug(`deposit ${deposit.txHash} matched ${intent.intentId} which is ${intent.status}`);
      return;
    }

    if (!deposit.intentId) {
      // Seen, but unsettleable: the FDC needs the 32-byte memo to produce a payment reference.
      store.addEvent(
        intent.intentId,
        "deposit:no-memo",
        `Deposit ${deposit.txHash} arrived without a 32-byte memo, so the FDC cannot bind it ` +
          `to this intent. Manual refund required.`,
        deposit.txHash,
        xrplExplorerTxUrl(deposit.txHash),
      );
      return;
    }

    const record = store.updateIntent(intent.intentId, {
      status: "DEPOSITED",
      xrplTxHash: deposit.txHash,
      error: null,
    });
    const event = store.addEvent(
      intent.intentId,
      "deposited",
      `Received ${deposit.amountDrops} drops on XRPL (matched by ${matchedBy})`,
      deposit.txHash,
      xrplExplorerTxUrl(deposit.txHash),
    );
    log.info(`deposit ${deposit.txHash} -> intent ${intent.intentId}`);

    if (record) bus.publish({type: "intent", data: record});
    bus.publish({type: "intent:event", data: event});

    // Report the deposit on-chain so the frontend's stepper advances without waiting for the
    // full FDC round. Best-effort: the settlement path does not depend on it.
    void this.markDepositedOnChain(intent.intentId, deposit.txHash);
  }

  private async markDepositedOnChain(intentId: string, txHash: string): Promise<void> {
    try {
      const manager = intentManager(true);
      const tx = await manager.markDeposited(intentId, `0x${txHash.toLowerCase()}`.slice(0, 66));
      await tx.wait();
    } catch (error) {
      log.debug(`markDeposited for ${intentId} failed (non-fatal)`, describeError(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /*                             the tick                                */
  /* ------------------------------------------------------------------ */

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const intent of store.listActionable()) {
        try {
          await this.advance(intent);
        } catch (error) {
          this.recordFailure(intent, describeError(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(intent: IntentRecord): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Expire first: an intent past its deadline can never settle, so there is no point
    // spending FDC fees or gas on it.
    if (nowSeconds > intent.deadline && intent.status !== "SETTLED") {
      await this.expire(intent);
      return;
    }

    switch (intent.status) {
      case "PENDING":
        return; // waiting on the user; the watcher will move it along
      case "DEPOSITED":
        await this.requestAttestation(intent);
        return;
      case "ATTESTATION_REQUESTED":
        await this.checkAttestation(intent);
        return;
      case "ATTESTATION_READY":
      case "FAILED":
        await this.settle(intent);
        return;
      default:
        return;
    }
  }

  /* ---------------------------- FDC steps --------------------------- */

  private async requestAttestation(intent: IntentRecord): Promise<void> {
    if (!intent.xrplTxHash) return;

    // The verifier rejects transactions it has not yet indexed; that is a normal retry.
    const abiEncodedRequest = await prepareRequest(intent.xrplTxHash);
    const submitted = await submitAttestationRequest(abiEncodedRequest);

    const record = store.updateIntent(intent.intentId, {
      status: "ATTESTATION_REQUESTED",
      attestationRequest: submitted.abiEncodedRequest,
      votingRound: submitted.votingRound,
      error: null,
    });
    const event = store.addEvent(
      intent.intentId,
      "fdc:requested",
      `FDC attestation requested in voting round ${submitted.votingRound}`,
      submitted.txHash,
      explorerTxUrl(submitted.txHash),
    );
    if (record) bus.publish({type: "intent", data: record});
    bus.publish({type: "intent:event", data: event});
  }

  private async checkAttestation(intent: IntentRecord): Promise<void> {
    if (intent.votingRound === null || !intent.attestationRequest) return;

    if (!(await isRoundFinalized(intent.votingRound))) {
      log.debug(`round ${intent.votingRound} not finalised yet`);
      return;
    }

    const proof = await retrieveProof(intent.attestationRequest, intent.votingRound);
    if (!proof) {
      log.debug(`proof for round ${intent.votingRound} not served yet`);
      return;
    }

    const problem = checkProofAgainstIntent(proof, {
      intentId: intent.intentId,
      depositAddressHash: this.depositAddressHash,
      minAmountDrops: BigInt(intent.sourceAmount),
    });
    if (problem) {
      // The chain would reject this too. Stop here so we do not burn gas on a certain revert.
      this.recordFailure(intent, `proof rejected locally: ${problem}`);
      return;
    }

    const record = store.updateIntent(intent.intentId, {status: "ATTESTATION_READY", error: null});
    const event = store.addEvent(
      intent.intentId,
      "fdc:verified",
      `Merkle proof retrieved and validated for round ${intent.votingRound}`,
    );
    if (record) bus.publish({type: "intent", data: record});
    bus.publish({type: "intent:event", data: event});

    // The proof is in hand; settle on this same tick rather than waiting for the next.
    if (record) await this.settle(record);
  }

  /* --------------------------- settlement --------------------------- */

  private async settle(intent: IntentRecord): Promise<void> {
    if (intent.votingRound === null || !intent.attestationRequest) return;
    if (intent.attempts >= MAX_ATTEMPTS) {
      log.warn(`${intent.intentId} exhausted ${MAX_ATTEMPTS} attempts — leaving for manual review`);
      return;
    }

    const proof = await retrieveProof(intent.attestationRequest, intent.votingRound);
    if (!proof) return;

    store.updateIntent(intent.intentId, {status: "SETTLING", incrementAttempts: true});

    const settler = intentSettler(true);
    const contractProof = toContractProof(proof);

    // Simulate first. A revert here costs nothing and gives a decodable custom error, whereas a
    // failed transaction costs gas and reports only "execution reverted".
    try {
      await settler.settleIntent.staticCall(intent.intentId, contractProof);
    } catch (error) {
      this.recordFailure(intent, `settlement would revert: ${describeError(error)}`);
      return;
    }

    const gasLimit = await settler.settleIntent
      .estimateGas(intent.intentId, contractProof)
      .then((estimate: bigint) => (estimate * 130n) / 100n)
      .catch(() => 3_000_000n);

    const tx = await settler.settleIntent(intent.intentId, contractProof, {gasLimit});
    log.info(`settling ${intent.intentId} in ${tx.hash}`);

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      this.recordFailure(intent, `settlement transaction ${tx.hash} reverted`);
      return;
    }

    // The indexer will pick up IntentSettled and fill in the output amount; write what we know
    // now so the UI updates immediately rather than on the next indexer tick.
    const record = store.updateIntent(intent.intentId, {
      status: "SETTLED",
      flareTxHash: receipt.hash,
      settledAt: Math.floor(Date.now() / 1000),
      error: null,
    });
    const event = store.addEvent(
      intent.intentId,
      "settled",
      "Swap executed and output delivered on Flare",
      receipt.hash,
      explorerTxUrl(receipt.hash),
    );
    if (record) bus.publish({type: "intent", data: record});
    bus.publish({type: "intent:event", data: event});
    log.info(`settled ${intent.intentId}`);
  }

  private async expire(intent: IntentRecord): Promise<void> {
    if (intent.status === "EXPIRED" || intent.status === "CANCELLED") return;

    try {
      const settler = intentSettler(true);
      const tx = await settler.expireIntent(intent.intentId);
      await tx.wait();
      store.addEvent(intent.intentId, "expired", "Deadline passed; intent marked expired on-chain", tx.hash);
    } catch (error) {
      // Losing the race to expire is fine — someone else did it, or it is already terminal.
      log.debug(`expireIntent(${intent.intentId}) failed`, describeError(error));
      store.addEvent(intent.intentId, "expired", "Deadline passed");
    }

    const record = store.updateIntent(intent.intentId, {status: "EXPIRED"});
    if (record) bus.publish({type: "intent", data: record});
  }

  private recordFailure(intent: IntentRecord, message: string): void {
    log.error(`${intent.intentId}: ${message}`);
    const status: IntentStatus = intent.attempts + 1 >= MAX_ATTEMPTS ? "FAILED" : "ATTESTATION_READY";
    const record = store.updateIntent(intent.intentId, {
      status: intent.status === "PENDING" ? "PENDING" : status,
      error: message.slice(0, 500),
      incrementAttempts: true,
    });
    const event = store.addEvent(intent.intentId, "error", message.slice(0, 500));
    if (record) bus.publish({type: "intent", data: record});
    bus.publish({type: "intent:event", data: event});
  }

  /* ------------------------------------------------------------------ */

  get status(): {enabled: boolean; operator: string | null; xrplConnected: boolean; depositAddress: string} {
    return {
      enabled: canRelay(),
      operator: getWallet()?.address ?? null,
      xrplConnected: xrplWatcher.connected,
      depositAddress: config.xrpl.depositAddress,
    };
  }

  /** Forces one intent through the pipeline immediately — used by `POST /api/intents/:id/retry`. */
  async retry(intentId: string): Promise<IntentRecord | null> {
    const intent = store.getIntent(intentId);
    if (!intent) return null;
    requireDeployment();
    await this.advance(intent);
    return store.getIntent(intentId);
  }
}

export const relayer = new Relayer();
