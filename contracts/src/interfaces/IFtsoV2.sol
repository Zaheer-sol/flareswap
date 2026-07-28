// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Minimal FTSOv2 surface used by FlareSwap.
/// @dev The production `FtsoV2Interface` declares these as `payable` (a per-call fee may be
///      configured for some feeds). They never write storage when the fee is zero, which is the
///      case for all standard feeds today, so FlareSwap reads them through `staticcall`
///      (see {FtsoV2Reader}). That keeps `PriceOracle` view-compatible for the frontend while
///      still pointing at the real, unmodified FTSOv2 contract.
interface IFtsoV2 {
    /// @param _feedId 21-byte feed id: 1 byte category + 20 bytes ASCII name, right zero-padded.
    ///        Category 0x01 = crypto. e.g. FLR/USD = 0x01464c522f55534400000000000000000000000000
    /// @return _value      Feed value, to be interpreted with `_decimals`.
    /// @return _decimals   Number of decimals (can be negative).
    /// @return _timestamp  Unix timestamp of the voting round the value belongs to.
    function getFeedById(bytes21 _feedId)
        external
        payable
        returns (uint256 _value, int8 _decimals, uint64 _timestamp);

    /// @notice Batched variant of {getFeedById}.
    function getFeedsById(bytes21[] calldata _feedIds)
        external
        payable
        returns (uint256[] memory _values, int8[] memory _decimals, uint64 _timestamp);

    /// @notice Feed value rescaled to 18 decimals.
    function getFeedByIdInWei(bytes21 _feedId)
        external
        payable
        returns (uint256 _value, uint64 _timestamp);
}
