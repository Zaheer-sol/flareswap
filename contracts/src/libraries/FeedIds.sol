// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice FTSOv2 feed identifiers.
/// @dev A feed id is 21 bytes: `0x01` (category = crypto) followed by the ASCII feed name,
///      right-padded with zero bytes to 20. {toFeedId} builds one at runtime; the constants
///      below are the pre-computed ids for the feeds FlareSwap uses.
library FeedIds {
    uint8 internal constant CATEGORY_CRYPTO = 0x01;

    bytes21 internal constant FLR_USD = bytes21(0x01464c522f55534400000000000000000000000000);
    bytes21 internal constant XRP_USD = bytes21(0x015852502f55534400000000000000000000000000);
    bytes21 internal constant BTC_USD = bytes21(0x014254432f55534400000000000000000000000000);
    bytes21 internal constant ETH_USD = bytes21(0x014554482f55534400000000000000000000000000);
    bytes21 internal constant USDC_USD = bytes21(0x01555344432f555344000000000000000000000000);
    bytes21 internal constant USDT_USD = bytes21(0x01555344542f555344000000000000000000000000);

    error FeedNameTooLong(uint256 length);

    /// @notice Builds a feed id from a category byte and a feed name such as "XRP/USD".
    function toFeedId(uint8 category, string memory name) internal pure returns (bytes21) {
        bytes memory nameBytes = bytes(name);
        if (nameBytes.length > 20) revert FeedNameTooLong(nameBytes.length);

        bytes21 id = bytes21(bytes1(category));
        for (uint256 i = 0; i < nameBytes.length; i++) {
            // byte 0 is the category, so the name starts at byte 1
            id |= bytes21(nameBytes[i]) >> (8 * (i + 1));
        }
        return id;
    }

    /// @notice Convenience wrapper for the crypto category.
    function crypto(string memory name) internal pure returns (bytes21) {
        return toFeedId(CATEGORY_CRYPTO, name);
    }
}
