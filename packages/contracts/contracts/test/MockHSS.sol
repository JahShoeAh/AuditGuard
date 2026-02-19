// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockHSS
/// @notice Mock for the Hedera Schedule Service precompile at 0x16b.
/// @dev Used exclusively in Hardhat tests via `hardhat_setCode`.
///      Returns synthetic schedule addresses and SUCCESS (22) response codes.
contract MockHSS {
    uint256 private _callCount;
    bytes4 private constant SELECTOR_SCHEDULE_CALL = 0x3b7e6dfd;
    bytes4 private constant SELECTOR_DELETE_SCHEDULE = 0x8e35b9dc;
    bytes4 private constant SELECTOR_HAS_CAPACITY = 0x9c888068;

    /// @notice Mirrors HSS scheduleCall(to,expiry,gas,value,callData).
    /// @dev Returns (SUCCESS, synthetic schedule address).
    function scheduleCall(
        address,
        uint256,
        uint256,
        uint64,
        bytes calldata
    ) external returns (int64, address) {
        // Generate a deterministic but unique fake schedule address per call
        _callCount++;
        address fakeSchedule = address(uint160(uint256(keccak256(abi.encode("schedule", _callCount)))));
        return (int64(22), fakeSchedule);
    }

    /// @notice Mirrors HSS deleteSchedule(scheduleAddress).
    /// @dev Always returns SUCCESS in tests.
    function deleteSchedule(address) external pure returns (int64) {
        return int64(22);
    }

    /// @notice Mirrors HSS hasScheduleCapacity(expirySecond, gasLimit).
    /// @dev Must be `view`-safe for staticcall in HederaScheduleService.
    function hasScheduleCapacity(uint256, uint256) external pure returns (bool) {
        return true;
    }

    /// @dev Keep a permissive selector router so the vendored HSS wrapper works in tests.
    fallback(bytes calldata data) external payable returns (bytes memory) {
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        if (selector == SELECTOR_HAS_CAPACITY) {
            return abi.encode(true);
        }

        if (selector == SELECTOR_DELETE_SCHEDULE) {
            return abi.encode(int64(22));
        }

        if (selector == SELECTOR_SCHEDULE_CALL) {
            _callCount++;
            address fakeSchedule = address(uint160(uint256(keccak256(abi.encode("schedule", _callCount)))));
            return abi.encode(int64(22), fakeSchedule);
        }

        return abi.encode(int64(22), address(0));
    }
}
