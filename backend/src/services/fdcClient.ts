import {AbiCoder, toUtf8Bytes, hexlify, zeroPadBytes} from "ethers";
import {config} from "../config.js";
import {fdcHub, fdcRequestFeeConfigurations, relay} from "../lib/flare.js";
import {createLogger, describeError} from "../lib/logger.js";

const log = createLogger("fdc");

/**
 * Drives one Payment attestation through the Flare Data Connector.
 *
 * The flow, and why each step exists:
 *
 *   1. **prepareRequest** — a verifier server independently checks that the XRPL transaction
 *      exists and matches, then returns the canonical ABI-encoded request. We cannot build this
 *      ourselves: the request embeds a message-integrity code the verifier computes from the
 *      response it will later attest to.
 *   2. **requestAttestation** — post the encoded request to `FdcHub` with the round fee. This
 *      is what puts the request in front of Flare's validator set.
 *   3. **wait for finalisation** — the round the request landed in must be finalised on `Relay`
 *      (protocol 200) before any Merkle root exists to prove against.
 *   4. **proof retrieval** — the Data Availability layer serves the Merkle proof plus the raw
 *      ABI-encoded response for that request in that round.
 *
 * Steps 1 and 4 are off-chain conveniences; the security comes from step 3. Nothing this client
 * returns is trusted — `IntentSettler` re-verifies the proof against the on-chain root.
 */

/** FDC ids are the UTF-8 name right-padded to 32 bytes. */
export function toAttestationId(name: string): string {
  return zeroPadBytes(hexlify(toUtf8Bytes(name)), 32);
}

export const ATTESTATION_TYPE_PAYMENT = toAttestationId("Payment");

/** Matches `IPayment.Response` exactly — field order defines the Merkle leaf. */
const RESPONSE_TUPLE =
  "tuple(" +
  "bytes32 attestationType," +
  "bytes32 sourceId," +
  "uint64 votingRound," +
  "uint64 lowestUsedTimestamp," +
  "tuple(bytes32 transactionId,uint16 inUtxo,uint16 utxo) requestBody," +
  "tuple(" +
  "uint64 blockNumber,uint64 blockTimestamp,bytes32 sourceAddressHash,bytes32 sourceAddressesRoot," +
  "bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount," +
  "int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount," +
  "bytes32 standardPaymentReference,bool oneToOne,uint8 status" +
  ") responseBody" +
  ")";

export interface PaymentResponse {
  attestationType: string;
  sourceId: string;
  votingRound: bigint;
  lowestUsedTimestamp: bigint;
  requestBody: {transactionId: string; inUtxo: number; utxo: number};
  responseBody: {
    blockNumber: bigint;
    blockTimestamp: bigint;
    sourceAddressHash: string;
    sourceAddressesRoot: string;
    receivingAddressHash: string;
    intendedReceivingAddressHash: string;
    spentAmount: bigint;
    intendedSpentAmount: bigint;
    receivedAmount: bigint;
    intendedReceivedAmount: bigint;
    standardPaymentReference: string;
    oneToOne: boolean;
    status: number;
  };
}

/** The `IPayment.Proof` tuple `IntentSettler.settleIntent` expects. */
export interface PaymentProof {
  merkleProof: string[];
  data: PaymentResponse;
}

const abiCoder = AbiCoder.defaultAbiCoder();

async function postJson<T>(url: string, body: unknown, apiKey: string): Promise<T> {
  const headers: Record<string, string> = {"Content-Type": "application/json"};
  if (apiKey) headers["X-API-KEY"] = apiKey;

  const response = await fetch(url, {method: "POST", headers, body: JSON.stringify(body)});
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${response.statusText}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                        step 1: prepare the request                         */
/* -------------------------------------------------------------------------- */

interface PrepareResponse {
  status: string;
  abiEncodedRequest?: string;
}

/**
 * Asks the verifier to build the ABI-encoded attestation request for an XRPL transaction.
 *
 * A `status` other than `VALID` means the verifier could not confirm the transaction — usually
 * because it has not propagated yet. That is a retry, not a failure.
 */
export async function prepareRequest(transactionId: string): Promise<string> {
  const url = `${config.fdc.verifierUrl}/verifier/xrp/Payment/prepareRequest`;
  const body = {
    attestationType: ATTESTATION_TYPE_PAYMENT,
    sourceId: toAttestationId(config.xrpl.sourceId),
    requestBody: {
      transactionId: transactionId.startsWith("0x") ? transactionId : `0x${transactionId}`,
      inUtxo: "0",
      utxo: "0",
    },
  };

  const result = await postJson<PrepareResponse>(url, body, config.fdc.verifierApiKey);
  if (result.status !== "VALID" || !result.abiEncodedRequest) {
    throw new Error(`verifier rejected ${transactionId}: status=${result.status}`);
  }
  return result.abiEncodedRequest;
}

/* -------------------------------------------------------------------------- */
/*                       step 2: submit to the FdcHub                         */
/* -------------------------------------------------------------------------- */

export interface SubmittedRequest {
  txHash: string;
  votingRound: number;
  abiEncodedRequest: string;
}

/**
 * Submits the request on-chain and resolves which voting round it landed in.
 *
 * The round is derived from the *mined block's* timestamp, not from `Date.now()` — a request
 * submitted near a round boundary would otherwise be looked up in the wrong round and the proof
 * would never be found.
 */
export async function submitAttestationRequest(abiEncodedRequest: string): Promise<SubmittedRequest> {
  const [hub, feeConfig] = await Promise.all([fdcHub(true), fdcRequestFeeConfigurations()]);

  const fee: bigint = await feeConfig.getRequestFee(abiEncodedRequest);
  log.debug(`request fee ${fee} wei`);

  const tx = await hub.requestAttestation(abiEncodedRequest, {value: fee});
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`attestation request ${tx.hash} produced no receipt`);

  const block = await receipt.getBlock();
  const relayContract = await relay();
  const votingRound: bigint = await relayContract.getVotingRoundId(block.timestamp);

  log.info(`attestation requested in round ${votingRound}`, {tx: receipt.hash});
  return {txHash: receipt.hash, votingRound: Number(votingRound), abiEncodedRequest};
}

/* -------------------------------------------------------------------------- */
/*                      step 3: wait for the round to close                   */
/* -------------------------------------------------------------------------- */

export async function isRoundFinalized(votingRound: number): Promise<boolean> {
  const relayContract = await relay();
  try {
    return await relayContract.isFinalized(config.fdc.protocolId, votingRound);
  } catch (error) {
    // Some Relay deployments revert rather than returning false for a future round.
    log.debug(`isFinalized(${votingRound}) reverted, treating as not final`, describeError(error));
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                        step 4: retrieve the proof                          */
/* -------------------------------------------------------------------------- */

interface DaLayerProofResponse {
  proof?: string[];
  response_hex?: string;
  responseHex?: string;
}

/**
 * Fetches the Merkle proof for a finalised request.
 *
 * We deliberately use the `-raw` endpoint and ABI-decode the response ourselves. The decoded
 * JSON variant is convenient but lossy in a way that matters: the Merkle leaf is
 * `keccak256(abi.encode(response))`, so any re-encoding from JSON risks a field-ordering or
 * numeric-width mismatch that would produce a proof the settler rejects. Decoding the exact
 * bytes the DA layer served cannot drift.
 */
export async function retrieveProof(
  abiEncodedRequest: string,
  votingRound: number,
): Promise<PaymentProof | null> {
  const url = `${config.fdc.daLayerUrl}/api/v1/fdc/proof-by-request-round-raw`;

  let result: DaLayerProofResponse;
  try {
    result = await postJson<DaLayerProofResponse>(
      url,
      {votingRoundId: votingRound, requestBytes: abiEncodedRequest},
      config.fdc.daLayerApiKey,
    );
  } catch (error) {
    log.debug(`proof not available yet for round ${votingRound}`, describeError(error));
    return null;
  }

  const responseHex = result.response_hex ?? result.responseHex;
  if (!responseHex || !result.proof) {
    log.debug(`DA layer returned an empty proof for round ${votingRound}`);
    return null;
  }

  return {merkleProof: result.proof, data: decodePaymentResponse(responseHex)};
}

/** ABI-decodes `response_hex` into the exact struct shape `settleIntent` takes. */
export function decodePaymentResponse(responseHex: string): PaymentResponse {
  const [decoded] = abiCoder.decode([RESPONSE_TUPLE], responseHex);
  return {
    attestationType: decoded.attestationType,
    sourceId: decoded.sourceId,
    votingRound: decoded.votingRound,
    lowestUsedTimestamp: decoded.lowestUsedTimestamp,
    requestBody: {
      transactionId: decoded.requestBody.transactionId,
      inUtxo: Number(decoded.requestBody.inUtxo),
      utxo: Number(decoded.requestBody.utxo),
    },
    responseBody: {
      blockNumber: decoded.responseBody.blockNumber,
      blockTimestamp: decoded.responseBody.blockTimestamp,
      sourceAddressHash: decoded.responseBody.sourceAddressHash,
      sourceAddressesRoot: decoded.responseBody.sourceAddressesRoot,
      receivingAddressHash: decoded.responseBody.receivingAddressHash,
      intendedReceivingAddressHash: decoded.responseBody.intendedReceivingAddressHash,
      spentAmount: decoded.responseBody.spentAmount,
      intendedSpentAmount: decoded.responseBody.intendedSpentAmount,
      receivedAmount: decoded.responseBody.receivedAmount,
      intendedReceivedAmount: decoded.responseBody.intendedReceivedAmount,
      standardPaymentReference: decoded.responseBody.standardPaymentReference,
      oneToOne: decoded.responseBody.oneToOne,
      status: Number(decoded.responseBody.status),
    },
  };
}

/**
 * Converts the proof into the positional-array form ethers passes as a Solidity struct.
 *
 * ethers v6 accepts objects for structs, but only when every key matches; nested tuples with
 * `int256` fields are far less error-prone as ordered arrays.
 */
export function toContractProof(proof: PaymentProof): unknown[] {
  const {data} = proof;
  return [
    proof.merkleProof,
    [
      data.attestationType,
      data.sourceId,
      data.votingRound,
      data.lowestUsedTimestamp,
      [data.requestBody.transactionId, data.requestBody.inUtxo, data.requestBody.utxo],
      [
        data.responseBody.blockNumber,
        data.responseBody.blockTimestamp,
        data.responseBody.sourceAddressHash,
        data.responseBody.sourceAddressesRoot,
        data.responseBody.receivingAddressHash,
        data.responseBody.intendedReceivingAddressHash,
        data.responseBody.spentAmount,
        data.responseBody.intendedSpentAmount,
        data.responseBody.receivedAmount,
        data.responseBody.intendedReceivedAmount,
        data.responseBody.standardPaymentReference,
        data.responseBody.oneToOne,
        data.responseBody.status,
      ],
    ],
  ];
}

/**
 * Local pre-flight before spending gas on `settleIntent`.
 *
 * Every check here is enforced again on-chain — this only exists to turn a wasted reverting
 * transaction into a log line.
 */
export function checkProofAgainstIntent(
  proof: PaymentProof,
  expected: {intentId: string; depositAddressHash: string; minAmountDrops: bigint},
): string | null {
  const body = proof.data.responseBody;

  if (proof.data.attestationType.toLowerCase() !== ATTESTATION_TYPE_PAYMENT.toLowerCase()) {
    return `wrong attestation type ${proof.data.attestationType}`;
  }
  if (body.status !== 0) return `payment status ${body.status} (not successful)`;
  if (body.standardPaymentReference.toLowerCase() !== expected.intentId.toLowerCase()) {
    return `payment reference ${body.standardPaymentReference} != intent ${expected.intentId}`;
  }
  if (body.receivingAddressHash.toLowerCase() !== expected.depositAddressHash.toLowerCase()) {
    return `paid to the wrong address (hash ${body.receivingAddressHash})`;
  }
  if (body.receivedAmount < expected.minAmountDrops) {
    return `underpaid: received ${body.receivedAmount} < required ${expected.minAmountDrops}`;
  }
  return null;
}
