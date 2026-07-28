// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {IPayment} from "../interfaces/IPayment.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Test double for the FAssets v1.3 AssetManager.
/// @dev Models the two-phase mint: {reserveCollateral} records who reserved what, and
///      {executeMinting} mints `lots * lotSize` FAssets to the reserver, minus a minting fee,
///      then burns the reservation. Enough to prove {FAssetsMinter} wires the flow correctly.
contract MockAssetManager is IAssetManager {
    struct Reservation {
        address minter;
        address agentVault;
        uint256 lots;
        bool executed;
    }

    MockERC20 public immutable fAssetToken;

    uint256 public lotSizeUBA = 20_000_000; // 20 XRP in drops
    uint256 public reservationFeeWei = 0.1 ether;
    uint256 public mintingFeeBIPS = 0; // agent's cut, in bips of the minted amount
    uint256 public nextReservationId = 1;

    mapping(uint256 collateralReservationId => Reservation) public reservations;

    error UnknownReservation(uint256 id);
    error ReservationAlreadyExecuted(uint256 id);
    error InsufficientReservationFee(uint256 sent, uint256 required);

    constructor(address fAssetToken_) {
        fAssetToken = MockERC20(fAssetToken_);
    }

    function setLotSize(uint256 newLotSizeUBA) external {
        lotSizeUBA = newLotSizeUBA;
    }

    function setMintingFeeBIPS(uint256 newFeeBIPS) external {
        mintingFeeBIPS = newFeeBIPS;
    }

    function setReservationFee(uint256 newFeeWei) external {
        reservationFeeWei = newFeeWei;
    }

    function fAsset() external view returns (address) {
        return address(fAssetToken);
    }

    function assetMintingGranularityUBA() external pure returns (uint256) {
        return 1;
    }

    function assetMintingDecimals() external pure returns (uint256) {
        return 6;
    }

    function lotSize() external view returns (uint256) {
        return lotSizeUBA;
    }

    function collateralReservationFee(uint256 lots) public view returns (uint256) {
        return reservationFeeWei * lots;
    }

    function reserveCollateral(
        address agentVault,
        uint256 lots,
        uint256, /* maxMintingFeeBIPS */
        address payable, /* executor */
        string[] calldata /* minterUnderlyingAddresses */
    ) external payable returns (uint256 collateralReservationId) {
        uint256 required = collateralReservationFee(lots);
        if (msg.value < required) revert InsufficientReservationFee(msg.value, required);

        collateralReservationId = nextReservationId++;
        reservations[collateralReservationId] =
            Reservation({minter: msg.sender, agentVault: agentVault, lots: lots, executed: false});
    }

    function executeMinting(IPayment.Proof calldata, /* payment */ uint256 collateralReservationId)
        external
    {
        Reservation storage reservation = reservations[collateralReservationId];
        if (reservation.minter == address(0)) revert UnknownReservation(collateralReservationId);
        if (reservation.executed) revert ReservationAlreadyExecuted(collateralReservationId);
        reservation.executed = true;

        uint256 gross = reservation.lots * lotSizeUBA;
        uint256 fee = (gross * mintingFeeBIPS) / 10_000;
        fAssetToken.mint(reservation.minter, gross - fee);
    }
}
