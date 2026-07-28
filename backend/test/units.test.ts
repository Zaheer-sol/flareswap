import {test, describe} from "node:test";
import assert from "node:assert/strict";
import {keccak256, toUtf8Bytes} from "ethers";

import {
  standardAddressHash,
  encodeIntentMemo,
  decodeIntentMemo,
  buildDepositTransaction,
  xrpToDrops,
  dropsToXrp,
  parseDeposit,
} from "../src/lib/xrplUtils.js";
import {feedId} from "../src/services/priceService.js";
import {toAttestationId, ATTESTATION_TYPE_PAYMENT, decodePaymentResponse} from "../src/services/fdcClient.js";

/**
 * These cover the pure functions that sit on the trust boundary between XRPL, the FDC and our
 * contracts. Every one of them has a Solidity counterpart that must agree byte for byte — a
 * silent divergence here shows up as a settlement that reverts after a user has already sent
 * real XRP, so they are worth pinning down precisely.
 */

describe("standardAddressHash", () => {
  test("is keccak256 of the raw UTF-8 address, matching the FDC spec", () => {
    const address = "rFLARESWAPcoreVaultDeposit1234567";
    assert.equal(standardAddressHash(address), keccak256(toUtf8Bytes(address)));
  });

  test("matches what Solidity's keccak256(bytes(addr)) produces", () => {
    // Cross-checked against `keccak256(bytes("rTest"))` in Foundry.
    assert.equal(
      standardAddressHash("rTest"),
      keccak256(toUtf8Bytes("rTest")),
    );
  });

  test("is case sensitive — XRPL base58 addresses must not be normalised", () => {
    assert.notEqual(standardAddressHash("rAbC"), standardAddressHash("rabc"));
  });
});

describe("intent memo encoding", () => {
  const intentId = "0x" + "ab".repeat(32);

  test("encodes a 32-byte intent id as uppercase hex without 0x", () => {
    const memo = encodeIntentMemo(intentId);
    assert.equal(memo.length, 64, "XRPL memo must be exactly 32 bytes of hex");
    assert.equal(memo, "AB".repeat(32));
    assert.ok(!memo.startsWith("0x"));
  });

  test("round-trips through decode", () => {
    assert.equal(decodeIntentMemo(encodeIntentMemo(intentId)), intentId);
  });

  test("rejects an id that is not 32 bytes", () => {
    assert.throws(() => encodeIntentMemo("0xdeadbeef"), /32 bytes/);
  });

  test("decode rejects anything that is not a 32-byte reference", () => {
    assert.equal(decodeIntentMemo(undefined), null);
    assert.equal(decodeIntentMemo("deadbeef"), null);
    assert.equal(decodeIntentMemo("zz".repeat(32)), null);
  });
});

describe("buildDepositTransaction", () => {
  const intentId = "0x" + "11".repeat(32);

  test("produces a Payment with exactly one memo, as the FDC requires", () => {
    const tx = buildDepositTransaction({
      account: "rSender",
      destination: "rVault",
      amountDrops: "500000000",
      intentId,
      destinationTag: 1_000_000,
    }) as Record<string, never>;

    assert.equal(tx.TransactionType, "Payment");
    assert.equal(tx.Destination, "rVault");
    assert.equal(tx.Amount, "500000000", "a bare string Amount means drops");
    assert.equal(tx.DestinationTag, 1_000_000);
    assert.equal((tx.Memos as unknown as unknown[]).length, 1, "FDC needs exactly one memo");
  });
});

describe("drops conversion", () => {
  test("xrpToDrops", () => {
    assert.equal(xrpToDrops("500"), "500000000");
    assert.equal(xrpToDrops("0.5"), "500000");
    assert.equal(xrpToDrops("1.234567"), "1234567");
    assert.equal(xrpToDrops("0.0000001"), "0", "sub-drop precision truncates");
  });

  test("dropsToXrp", () => {
    assert.equal(dropsToXrp("500000000"), "500");
    assert.equal(dropsToXrp("1234567"), "1.234567");
    assert.equal(dropsToXrp("1000000"), "1");
    assert.equal(dropsToXrp("0"), "0");
  });

  test("round-trips whole and fractional amounts", () => {
    for (const value of ["1", "500", "0.123456", "999999.999999"]) {
      assert.equal(dropsToXrp(xrpToDrops(value)), value);
    }
  });
});

describe("parseDeposit", () => {
  const intentId = "0x" + "cd".repeat(32);
  const memo = {Memo: {MemoData: "CD".repeat(32)}};

  test("extracts the intent id, amount and tag from a validated Payment", () => {
    const deposit = parseDeposit(
      {
        TransactionType: "Payment",
        Account: "rSender",
        Destination: "rVault",
        DestinationTag: 1_000_042,
        Amount: "500000000",
        Memos: [memo],
      },
      {delivered_amount: "500000000", TransactionResult: "tesSUCCESS"},
      90_000_000,
      "ABC123",
    );

    assert.ok(deposit);
    assert.equal(deposit.intentId, intentId);
    assert.equal(deposit.amountDrops, "500000000");
    assert.equal(deposit.destinationTag, 1_000_042);
    assert.equal(deposit.destination, "rVault");
  });

  test("prefers delivered_amount over Amount for partial payments", () => {
    const deposit = parseDeposit(
      {TransactionType: "Payment", Destination: "rVault", Amount: "500000000", Memos: [memo]},
      {delivered_amount: "1000000", TransactionResult: "tesSUCCESS"},
      1,
      "HASH",
    );
    assert.equal(
      deposit?.amountDrops,
      "1000000",
      "trusting Amount would request an attestation the settler then rejects",
    );
  });

  test("ignores failed transactions", () => {
    const deposit = parseDeposit(
      {TransactionType: "Payment", Destination: "rVault", Amount: "1"},
      {TransactionResult: "tecPATH_DRY"},
      1,
      "HASH",
    );
    assert.equal(deposit, null);
  });

  test("ignores non-Payment transactions", () => {
    const deposit = parseDeposit({TransactionType: "OfferCreate"}, undefined, 1, "HASH");
    assert.equal(deposit, null);
  });

  test("returns null amountDrops for issued-currency payments", () => {
    const deposit = parseDeposit(
      {
        TransactionType: "Payment",
        Destination: "rVault",
        Amount: {currency: "USD", issuer: "rIssuer", value: "100"},
      },
      {TransactionResult: "tesSUCCESS"},
      1,
      "HASH",
    );
    assert.equal(deposit?.amountDrops, null, "only native XRP can be minted as FXRP");
  });

  test("tolerates a memo that a wallet encoded as a UTF-8 hex string", () => {
    const asText = Buffer.from(intentId, "utf8").toString("hex").toUpperCase();
    const deposit = parseDeposit(
      {
        TransactionType: "Payment",
        Destination: "rVault",
        Amount: "1000000",
        Memos: [{Memo: {MemoData: asText}}],
      },
      {TransactionResult: "tesSUCCESS"},
      1,
      "HASH",
    );
    assert.equal(deposit?.intentId, intentId);
  });
});

describe("FTSO feed ids", () => {
  test("FLR/USD matches the id published by Flare", () => {
    assert.equal(feedId("FLR/USD"), "0x01464c522f55534400000000000000000000000000");
  });

  test("XRP/USD matches the Solidity FeedIds.XRP_USD constant", () => {
    assert.equal(feedId("XRP/USD"), "0x015852502f55534400000000000000000000000000");
  });

  test("is 21 bytes with a 0x01 crypto category prefix", () => {
    const id = feedId("USDC/USD");
    assert.equal(id.length, 2 + 42, "21 bytes");
    assert.ok(id.startsWith("0x01"));
  });

  test("rejects a name longer than 20 bytes", () => {
    assert.throws(() => feedId("A".repeat(21)), /too long/);
  });
});

describe("FDC attestation ids", () => {
  test('"Payment" is the ASCII name right-padded to 32 bytes', () => {
    assert.equal(
      ATTESTATION_TYPE_PAYMENT,
      "0x5061796d656e74000000000000000000000000000000000000000000000000000".slice(0, 66),
    );
    assert.equal(toAttestationId("Payment"), ATTESTATION_TYPE_PAYMENT);
  });

  test("source ids follow the same encoding", () => {
    assert.equal(
      toAttestationId("testXRP"),
      "0x7465737458525000000000000000000000000000000000000000000000000000",
    );
    assert.equal(toAttestationId("XRP").length, 66);
  });
});

describe("decodePaymentResponse", () => {
  test("round-trips an ABI-encoded response into the settleIntent struct shape", async () => {
    const {AbiCoder} = await import("ethers");
    const coder = AbiCoder.defaultAbiCoder();
    const tuple =
      "tuple(bytes32,bytes32,uint64,uint64,tuple(bytes32,uint16,uint16)," +
      "tuple(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8))";

    const reference = "0x" + "ee".repeat(32);
    const encoded = coder.encode(
      [tuple],
      [
        [
          ATTESTATION_TYPE_PAYMENT,
          toAttestationId("testXRP"),
          123_456n,
          1_800_000_000n,
          ["0x" + "aa".repeat(32), 0, 0],
          [
            90_000_000n,
            1_800_000_000n,
            keccak256(toUtf8Bytes("rSender")),
            "0x" + "00".repeat(32),
            keccak256(toUtf8Bytes("rVault")),
            keccak256(toUtf8Bytes("rVault")),
            500_000_012n,
            500_000_012n,
            500_000_000n,
            500_000_000n,
            reference,
            true,
            0,
          ],
        ],
      ],
    );

    const decoded = decodePaymentResponse(encoded);
    assert.equal(decoded.attestationType, ATTESTATION_TYPE_PAYMENT);
    assert.equal(decoded.votingRound, 123_456n);
    assert.equal(decoded.responseBody.receivedAmount, 500_000_000n);
    assert.equal(decoded.responseBody.standardPaymentReference, reference);
    assert.equal(decoded.responseBody.status, 0);
    assert.equal(decoded.responseBody.oneToOne, true);
  });
});
