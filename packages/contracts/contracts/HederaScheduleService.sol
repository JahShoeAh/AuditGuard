// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {HederaResponseCodes} from "./HederaResponseCodes.sol";

/// @title Hedera Schedule Service Base Contract
/// @notice Vendored from https://github.com/hashgraph/hedera-smart-contracts
/// @dev Provides internal helpers wrapping the HSS system contract at 0x16b.
///      Contracts that need scheduling should inherit this contract.
///      Implements HIP-1215 (scheduleCall) and HIP-755 (deleteSchedule).
abstract contract HederaScheduleService {
    // ── System contract ──────────────────────────────────────────────────────
    /// @notice The Hedera Schedule Service system contract address on all networks.
    address internal constant HSS = address(0x16b);

    // ── IHRC1215 selectors (pre-computed from function signatures) ───────────
    // scheduleCall(address,uint256,uint256,uint64,bytes)
    bytes4 private constant SELECTOR_SCHEDULE_CALL = 0x3b7e6dfd;
    // deleteSchedule(address)
    bytes4 private constant SELECTOR_DELETE_SCHEDULE = 0x8e35b9dc;
    // hasScheduleCapacity(uint256,uint256)
    bytes4 private constant SELECTOR_HAS_CAPACITY = 0x9c888068;

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @notice Schedules a future smart-contract call via HSS.
    /// @param to          Target contract that will be called at expiry.
    /// @param expirySecond Unix timestamp (seconds) when the call should fire.
    /// @param gasLimit    Maximum gas for the scheduled execution.
    /// @param value       Tinybars to attach (0 for token-only flows).
    /// @param callData    ABI-encoded function call to execute on `to`.
    /// @return responseCode Hedera response code (22 = SUCCESS).
    /// @return scheduleAddress On-chain address of the created schedule entity.
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) internal returns (int64 responseCode, address scheduleAddress) {
        (bool success, bytes memory result) = HSS.call(
            abi.encodeWithSelector(SELECTOR_SCHEDULE_CALL, to, expirySecond, gasLimit, value, callData)
        );
        if (success && result.length >= 64) {
            (responseCode, scheduleAddress) = abi.decode(result, (int64, address));
        } else {
            responseCode = int64(HederaResponseCodes.UNKNOWN);
            scheduleAddress = address(0);
        }
    }

    /// @notice Cancels (deletes) a pending schedule before it executes.
    /// @param scheduleAddress The on-chain schedule address to delete.
    /// @return responseCode Hedera response code (22 = SUCCESS).
    function deleteSchedule(address scheduleAddress) internal returns (int64 responseCode) {
        (bool success, bytes memory result) = HSS.call(
            abi.encodeWithSelector(SELECTOR_DELETE_SCHEDULE, scheduleAddress)
        );
        responseCode = (success && result.length >= 32)
            ? abi.decode(result, (int64))
            : int64(HederaResponseCodes.UNKNOWN);
    }

    /// @notice Returns true if the given second still has capacity for a new schedule.
    /// @param expirySecond Unix timestamp to check.
    /// @param gasLimit     Gas that will be needed.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) internal view returns (bool hasCapacity) {
        (bool success, bytes memory result) = HSS.staticcall(
            abi.encodeWithSelector(SELECTOR_HAS_CAPACITY, expirySecond, gasLimit)
        );
        hasCapacity = (success && result.length >= 32) ? abi.decode(result, (bool)) : false;
    }
}
