// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice FDC `Payment` attestation type.
/// @dev Struct layout mirrors `flare-periphery-contracts` exactly — the Merkle leaf is
///      `keccak256(abi.encode(Response))`, so field order and types must not be changed.
interface IPayment {
    struct RequestBody {
        /// @notice Transaction id / hash on the source chain (XRPL tx hash, BTC txid, ...).
        bytes32 transactionId;
        /// @notice UTXO index of the spender (UTXO chains only; 0 for XRPL).
        uint16 inUtxo;
        /// @notice UTXO index of the receiver (UTXO chains only; 0 for XRPL).
        uint16 utxo;
    }

    struct ResponseBody {
        /// @notice Block number of the source-chain transaction.
        uint64 blockNumber;
        /// @notice Block timestamp of the source-chain transaction.
        uint64 blockTimestamp;
        /// @notice keccak256 of the standardised source address string.
        bytes32 sourceAddressHash;
        /// @notice Merkle root of all source addresses (UTXO chains).
        bytes32 sourceAddressesRoot;
        /// @notice keccak256 of the standardised receiving address string.
        bytes32 receivingAddressHash;
        /// @notice keccak256 of the intended receiving address (before failure, if any).
        bytes32 intendedReceivingAddressHash;
        /// @notice Amount debited from the source address, in smallest units (drops for XRP).
        int256 spentAmount;
        /// @notice Amount that was intended to be debited.
        int256 intendedSpentAmount;
        /// @notice Amount credited to the receiving address, in smallest units.
        int256 receivedAmount;
        /// @notice Amount that was intended to be credited.
        int256 intendedReceivedAmount;
        /// @notice Standardised payment reference (XRPL memo / OP_RETURN), or 0 if absent.
        bytes32 standardPaymentReference;
        /// @notice True if the transaction has exactly one source and one receiving address.
        bool oneToOne;
        /// @notice 0 = success, 1 = failed by sender's fault, 2 = failed by receiver's fault.
        uint8 status;
    }

    struct Request {
        bytes32 attestationType;
        bytes32 sourceId;
        bytes32 messageIntegrityCode;
        RequestBody requestBody;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}
