// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IFdcVerification} from "../interfaces/IFdcVerification.sol";
import {IPayment} from "../interfaces/IPayment.sol";

/// @notice Test double for `FdcVerification` that performs *real* Merkle verification.
///
/// @dev This deliberately does not simply return `true`. It reproduces the production algorithm:
///      the leaf is `keccak256(abi.encode(proof.data))` and it must resolve, through
///      `proof.merkleProof`, to the root committed for `proof.data.votingRound`. Tests therefore
///      exercise the same failure modes as mainnet — a tampered amount, a swapped payment
///      reference or a forged receiving address all change the leaf and fail verification.
contract MockFdcVerification is IFdcVerification {
    mapping(uint64 votingRound => bytes32) public merkleRoots;

    event MerkleRootSet(uint64 indexed votingRound, bytes32 root);

    function setMerkleRoot(uint64 votingRound, bytes32 root) external {
        merkleRoots[votingRound] = root;
        emit MerkleRootSet(votingRound, root);
    }

    /// @notice Leaf hash for a response, matching the FDC's Merkle tree construction.
    function leafFor(IPayment.Response calldata data) external pure returns (bytes32) {
        return keccak256(abi.encode(data));
    }

    function verifyPayment(IPayment.Proof calldata proof) external view returns (bool) {
        bytes32 root = merkleRoots[proof.data.votingRound];
        if (root == bytes32(0)) return false;
        return MerkleProof.verify(proof.merkleProof, root, keccak256(abi.encode(proof.data)));
    }
}
