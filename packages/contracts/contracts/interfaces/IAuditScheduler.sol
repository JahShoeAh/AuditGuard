// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IAuditScheduler
/// @notice Minimal interface consumed by AuditAuction and external callers.
interface IAuditScheduler {
    enum TriggerMode { TIME_BASED, REDEPLOY }

    struct AuditSchedule {
        address owner;
        TriggerMode mode;
        uint256 intervalSeconds;
        uint256 nextAuditDue;
        address currentScheduleAddr;
        uint256 timesTriggered;
        bool active;
    }

    function scheduleAudit(address contractAddress, uint256 intervalSeconds, TriggerMode mode) external;
    function cancelSchedule(address contractAddress) external;
    function onRedeployDetected(address contractAddress) external;
    function getSchedule(address contractAddress) external view returns (AuditSchedule memory);
    function getActiveSchedules() external view returns (address[] memory);
    function totalScheduled() external view returns (uint256);
}
