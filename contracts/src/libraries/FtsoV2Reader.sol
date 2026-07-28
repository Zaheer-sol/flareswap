// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IFtsoV2} from "../interfaces/IFtsoV2.sol";

/// @notice Reads FTSOv2 feeds from a `view` context.
/// @dev `FtsoV2Interface.getFeedById` is declared `payable` upstream so that a per-feed fee can
///      be charged in future. It performs no storage writes when the fee is zero — which is the
///      case for every standard feed — so a `staticcall` succeeds and lets FlareSwap keep its
///      price getters `view`. If Flare ever prices a feed we use, the staticcall reverts loudly
///      rather than returning a stale number, and the caller must switch to a payable path.
library FtsoV2Reader {
    error FtsoCallFailed(bytes21 feedId);
    error FtsoMalformedResponse(bytes21 feedId);

    function readFeed(address ftsoV2, bytes21 feedId)
        internal
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        (bool ok, bytes memory ret) =
            ftsoV2.staticcall(abi.encodeWithSelector(IFtsoV2.getFeedById.selector, feedId));
        if (!ok) revert FtsoCallFailed(feedId);
        if (ret.length < 96) revert FtsoMalformedResponse(feedId);
        (value, decimals, timestamp) = abi.decode(ret, (uint256, int8, uint64));
    }
}
