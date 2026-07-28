// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {FAssetsMinter} from "../src/adapters/FAssetsMinter.sol";
import {PooledFxrpMinter} from "../src/adapters/PooledFxrpMinter.sol";
import {IFxrpMinter} from "../src/interfaces/IFxrpMinter.sol";
import {IPayment} from "../src/interfaces/IPayment.sol";
import {MockAssetManager} from "../src/mocks/MockAssetManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Covers both {IFxrpMinter} implementations against the same contract.
contract MinterTest is Test {
    address internal owner = makeAddr("owner");
    address internal settler = makeAddr("settler");
    address internal operator = makeAddr("operator");
    address internal attacker = makeAddr("attacker");
    address internal agentVault = makeAddr("agentVault");
    address internal recipient = makeAddr("recipient");

    MockERC20 internal fxrp;
    MockAssetManager internal assetManager;
    FAssetsMinter internal fassetsMinter;
    PooledFxrpMinter internal pooledMinter;

    bytes32 internal constant PAYMENT_REF = keccak256("intent-1");

    function setUp() public {
        fxrp = new MockERC20("FAsset XRP", "FXRP", 6);
        assetManager = new MockAssetManager(address(fxrp));

        fassetsMinter = new FAssetsMinter(address(assetManager), 6, owner);
        pooledMinter = new PooledFxrpMinter(address(fxrp), 6, owner);

        vm.startPrank(owner);
        fassetsMinter.setAuthorized(settler, true);
        fassetsMinter.setAuthorized(operator, true);
        pooledMinter.setAuthorized(settler, true);
        vm.stopPrank();

        vm.deal(operator, 100 ether);
    }

    function _proof(bytes32 paymentReference) internal pure returns (IPayment.Proof memory proof) {
        IPayment.ResponseBody memory body;
        body.standardPaymentReference = paymentReference;
        body.receivedAmount = 500e6;
        IPayment.Response memory response;
        response.attestationType = bytes32("Payment");
        response.responseBody = body;
        proof = IPayment.Proof({merkleProof: new bytes32[](0), data: response});
    }

    /* ------------------------------------------------------------------ */
    /*                          FAssetsMinter                              */
    /* ------------------------------------------------------------------ */

    function test_fassetsMinterResolvesFAssetFromAssetManager() public view {
        assertEq(fassetsMinter.fAsset(), address(fxrp));
        assertEq(fassetsMinter.fAssetDecimals(), 6);
        assertEq(fassetsMinter.lotSize(), 20_000_000);
    }

    function test_reserveThenExecuteMintsAndForwards() public {
        uint256 lots = 25; // 25 * 20 XRP = 500 XRP
        uint256 fee = assetManager.collateralReservationFee(lots);

        vm.prank(operator);
        uint256 crId =
            fassetsMinter.reserveCollateral{value: fee}(PAYMENT_REF, agentVault, lots, 1000, new string[](0));
        assertEq(fassetsMinter.reservationFor(PAYMENT_REF), crId);

        vm.prank(settler);
        uint256 minted = fassetsMinter.mint(500e6, recipient, _proof(PAYMENT_REF));

        assertEq(minted, 500e6, "25 lots of 20 XRP");
        assertEq(fxrp.balanceOf(recipient), 500e6);
        assertEq(fxrp.balanceOf(address(fassetsMinter)), 0, "nothing retained");
        assertEq(fassetsMinter.reservationFor(PAYMENT_REF), 0, "reservation consumed");
        assertEq(fassetsMinter.totalMinted(), 500e6);
    }

    /// @dev The agent's minting fee comes out of the minted amount. Measuring the balance delta
    ///      means the settler swaps what actually arrived, not an assumed 1:1.
    function test_mintAccountsForAgentMintingFee() public {
        assetManager.setMintingFeeBIPS(50); // 0.5%
        uint256 lots = 25;
        // Read the fee before pranking: an external call in an argument position would consume
        // the prank before `reserveCollateral` is reached.
        uint256 fee = assetManager.collateralReservationFee(lots);

        vm.prank(operator);
        fassetsMinter.reserveCollateral{value: fee}(PAYMENT_REF, agentVault, lots, 1000, new string[](0));

        vm.prank(settler);
        uint256 minted = fassetsMinter.mint(500e6, recipient, _proof(PAYMENT_REF));

        assertEq(minted, 500e6 - (500e6 * 50) / 10_000);
        assertEq(fxrp.balanceOf(recipient), minted);
    }

    function test_mintRequiresAReservation() public {
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(FAssetsMinter.NoReservation.selector, PAYMENT_REF));
        fassetsMinter.mint(500e6, recipient, _proof(PAYMENT_REF));
    }

    function test_reservationCannotBeDoubleBooked() public {
        vm.startPrank(operator);
        uint256 crId = fassetsMinter.reserveCollateral{value: 10 ether}(
            PAYMENT_REF, agentVault, 25, 1000, new string[](0)
        );
        vm.expectRevert(
            abi.encodeWithSelector(FAssetsMinter.ReservationExists.selector, PAYMENT_REF, crId)
        );
        fassetsMinter.reserveCollateral{value: 10 ether}(PAYMENT_REF, agentVault, 25, 1000, new string[](0));
        vm.stopPrank();
    }

    function test_mintCannotBeReplayed() public {
        vm.prank(operator);
        fassetsMinter.reserveCollateral{value: 10 ether}(PAYMENT_REF, agentVault, 25, 1000, new string[](0));

        vm.startPrank(settler);
        fassetsMinter.mint(500e6, recipient, _proof(PAYMENT_REF));
        vm.expectRevert(abi.encodeWithSelector(FAssetsMinter.NoReservation.selector, PAYMENT_REF));
        fassetsMinter.mint(500e6, recipient, _proof(PAYMENT_REF));
        vm.stopPrank();
    }

    function test_onlyAuthorizedMayMintOrReserve() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFxrpMinter.MinterNotAuthorized.selector, attacker));
        fassetsMinter.mint(500e6, attacker, _proof(PAYMENT_REF));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFxrpMinter.MinterNotAuthorized.selector, attacker));
        fassetsMinter.reserveCollateral(PAYMENT_REF, agentVault, 25, 1000, new string[](0));
    }

    function test_clearReservationAllowsRebooking() public {
        vm.prank(operator);
        fassetsMinter.reserveCollateral{value: 10 ether}(PAYMENT_REF, agentVault, 25, 1000, new string[](0));

        vm.startPrank(operator);
        fassetsMinter.clearReservation(PAYMENT_REF);
        uint256 crId2 = fassetsMinter.reserveCollateral{value: 10 ether}(
            PAYMENT_REF, agentVault, 25, 1000, new string[](0)
        );
        vm.stopPrank();
        assertEq(fassetsMinter.reservationFor(PAYMENT_REF), crId2);
    }

    /* ------------------------------------------------------------------ */
    /*                          PooledFxrpMinter                           */
    /* ------------------------------------------------------------------ */

    function test_pooledMinterReleasesFromReserve() public {
        fxrp.mint(address(this), 1_000e6);
        fxrp.approve(address(pooledMinter), 1_000e6);
        pooledMinter.fundReserve(1_000e6);
        assertEq(pooledMinter.reserveBalance(), 1_000e6);

        vm.prank(settler);
        uint256 minted = pooledMinter.mint(500e6, recipient, _proof(PAYMENT_REF));

        assertEq(minted, 500e6);
        assertEq(fxrp.balanceOf(recipient), 500e6);
        assertEq(pooledMinter.reserveBalance(), 500e6);
        assertEq(pooledMinter.totalMinted(), 500e6);
    }

    function test_pooledMinterFailsClosedWhenReserveIsShort() public {
        fxrp.mint(address(this), 100e6);
        fxrp.approve(address(pooledMinter), 100e6);
        pooledMinter.fundReserve(100e6);

        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(IFxrpMinter.InsufficientReserve.selector, uint256(500e6), uint256(100e6))
        );
        pooledMinter.mint(500e6, recipient, _proof(PAYMENT_REF));
    }

    function test_pooledMinterOnlyAuthorized() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFxrpMinter.MinterNotAuthorized.selector, attacker));
        pooledMinter.mint(500e6, attacker, _proof(PAYMENT_REF));
    }

    function test_pooledMinterPreviewMatchesMint() public {
        fxrp.mint(address(this), 1_000e6);
        fxrp.approve(address(pooledMinter), 1_000e6);
        pooledMinter.fundReserve(1_000e6);

        uint256 preview = pooledMinter.previewMint(500e6);
        vm.prank(settler);
        assertEq(pooledMinter.mint(500e6, recipient, _proof(PAYMENT_REF)), preview);
    }

    /// @dev FXRP happens to share XRP's 6 decimals, but the adapter must rescale if it ever
    ///      does not — an off-by-10^n here would be a catastrophic mispricing.
    function test_pooledMinterRescalesMismatchedDecimals() public {
        MockERC20 fxrp18 = new MockERC20("FAsset XRP 18", "FXRP18", 18);
        PooledFxrpMinter scaled = new PooledFxrpMinter(address(fxrp18), 6, owner);
        vm.prank(owner);
        scaled.setAuthorized(settler, true);

        fxrp18.mint(address(this), 1_000e18);
        fxrp18.approve(address(scaled), 1_000e18);
        scaled.fundReserve(1_000e18);

        assertEq(scaled.previewMint(500e6), 500e18);
        vm.prank(settler);
        assertEq(scaled.mint(500e6, recipient, _proof(PAYMENT_REF)), 500e18);
    }

    function test_onlyOwnerCanWithdrawReserve() public {
        fxrp.mint(address(this), 1_000e6);
        fxrp.approve(address(pooledMinter), 1_000e6);
        pooledMinter.fundReserve(1_000e6);

        vm.prank(attacker);
        vm.expectRevert();
        pooledMinter.withdrawReserve(attacker, 1_000e6);

        vm.prank(owner);
        pooledMinter.withdrawReserve(owner, 1_000e6);
        assertEq(fxrp.balanceOf(owner), 1_000e6);
    }
}
