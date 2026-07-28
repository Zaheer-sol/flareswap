// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPayment} from "./IPayment.sol";

/// @notice Flare Data Connector verification contract.
/// @dev Resolved from {IFlareContractRegistry} under the name "FdcVerification".
///      `verifyPayment` recomputes the Merkle leaf from `_proof.data`, walks `_proof.merkleProof`,
///      and compares the result against the Merkle root that the FDC voting round committed
///      on-chain. It returns a bool — it does NOT revert on a bad proof.
interface IFdcVerification {
    function verifyPayment(IPayment.Proof calldata _proof) external view returns (bool _proved);
}
