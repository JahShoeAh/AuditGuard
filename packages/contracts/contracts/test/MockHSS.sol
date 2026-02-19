// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockHSS
/// @notice Mock for the Hedera Schedule Service precompile at 0x16b.
/// @dev Used exclusively in Hardhat tests via `hardhat_setCode`.
///      Returns synthetic schedule addresses and SUCCESS (22) response codes.
contract MockHSS {
    uint256 private _callCount;

    /// @notice Mirrors the scheduleCall selector so the AuditScheduler can decode it.
    /// @dev Returns (int64(22), synthetic_schedule_address).
    fallback(bytes calldata) external returns (bytes memory) {
        // Generate a deterministic but unique fake schedule address per call
        _callCount++;
        address fakeSchedule = address(uint160(uint256(keccak256(abi.encode("schedule", _callCount)))));
        return abi.encode(int64(22), fakeSchedule);
    }
}
