// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Test double for FTSOv2.
/// @dev The real `getFeedById` is `payable`; here it is `view` so both a direct call and the
///      `staticcall` path in {FtsoV2Reader} behave identically. That is exactly the property
///      FlareSwap relies on in production, so testing against this mock tests the real path.
contract MockFtsoV2 {
    struct Feed {
        uint256 value;
        int8 decimals;
        uint64 timestamp;
        bool set;
    }

    mapping(bytes21 feedId => Feed) public feeds;

    error FeedNotSet(bytes21 feedId);

    function setFeed(bytes21 feedId, uint256 value, int8 decimals, uint64 timestamp) external {
        feeds[feedId] = Feed({value: value, decimals: decimals, timestamp: timestamp, set: true});
    }

    function setFeedNow(bytes21 feedId, uint256 value, int8 decimals) external {
        feeds[feedId] = Feed({value: value, decimals: decimals, timestamp: uint64(block.timestamp), set: true});
    }

    function getFeedById(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp)
    {
        Feed memory feed = feeds[feedId];
        if (!feed.set) revert FeedNotSet(feedId);
        return (feed.value, feed.decimals, feed.timestamp);
    }

    function getFeedsById(bytes21[] calldata feedIds)
        external
        view
        returns (uint256[] memory values, int8[] memory decimals, uint64 timestamp)
    {
        values = new uint256[](feedIds.length);
        decimals = new int8[](feedIds.length);
        for (uint256 i = 0; i < feedIds.length; i++) {
            Feed memory feed = feeds[feedIds[i]];
            if (!feed.set) revert FeedNotSet(feedIds[i]);
            values[i] = feed.value;
            decimals[i] = feed.decimals;
            timestamp = feed.timestamp;
        }
    }
}
