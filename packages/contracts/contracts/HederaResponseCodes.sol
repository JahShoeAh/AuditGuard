// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title Hedera Response Codes
/// @notice Vendored subset of Hedera response codes used by AuditGuard HSS contracts.
/// @dev Full list: https://github.com/hashgraph/hedera-smart-contracts/blob/main/contracts/system-contracts/HederaResponseCodes.sol
library HederaResponseCodes {
    // ───────────────────────────────────────────────────
    //  Core status codes
    // ───────────────────────────────────────────────────

    /// @notice The operation succeeded.
    int32 internal constant SUCCESS = 22;

    /// @notice The transaction or entity was not found.
    int32 internal constant INVALID_SCHEDULE_ID = 150;

    /// @notice The schedule has already been deleted.
    int32 internal constant SCHEDULE_ALREADY_DELETED = 193;

    /// @notice Unknown / unhandled response.
    int32 internal constant UNKNOWN = 21;
}
