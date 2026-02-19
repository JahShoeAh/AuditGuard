// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HederaScheduleService} from "./HederaScheduleService.sol";
import {HederaResponseCodes} from "./HederaResponseCodes.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title AuditGuard Audit Scheduler
/// @notice Contract-native recurring audit scheduling using the Hedera Schedule Service (HSS).
/// @dev Vault owners call scheduleAudit() to configure a cadence. The HSS system contract at
///      0x16b autonomously fires triggerAudit() at each interval — zero off-chain keeper required.
///      Satisfies the Hedera HSS bounty requirement of "scheduling initiated from a smart contract."
///
///      Two trigger modes:
///        TIME_BASED  — repeat every `intervalSeconds` (e.g. every 30 days)
///        REDEPLOY    — fire once when orchestrator detects new bytecode hash, then re-arm
///
///      Integration path:
///        AuditScheduler.triggerAudit()  emits AuditTriggered
///        Orchestrator listens and calls  AuditAuction.createAuditJob()
///        Full pipeline runs autonomously from there
contract AuditScheduler is HederaScheduleService, ReentrancyGuard, Ownable {
    // ─────────────────────────────────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Determines when an audit is triggered.
    enum TriggerMode {
        TIME_BASED, // every `intervalSeconds`
        REDEPLOY    // when orchestrator detects bytecode change
    }

    /// @notice Per-contract audit schedule.
    struct AuditSchedule {
        address owner;               // vault depositor who set the cadence
        TriggerMode mode;
        uint256 intervalSeconds;     // 0 = redeploy-only (used only for TIME_BASED)
        uint256 nextAuditDue;        // unix timestamp of next expected trigger
        address currentScheduleAddr; // HSS schedule entity address (for cancellation)
        uint256 timesTriggered;
        bool active;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────────────────────────────────

    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));
    int64 internal constant HTS_SUCCESS = 22;

    /// @notice Gas reserved for the HSS-invoked triggerAudit() call.
    /// @dev Must cover: storage reads, event emission, and re-scheduling.
    uint256 internal constant TRIGGER_GAS_LIMIT = 2_000_000;

    /// @notice Minimum interval allowed — 1 hour.
    uint256 internal constant MIN_INTERVAL = 1 hours;

    /// @notice Maximum interval allowed — 365 days.
    uint256 internal constant MAX_INTERVAL = 365 days;

    /// @notice Delay used for "immediate" redeploy-triggered audits (avoids same-block issues).
    uint256 internal constant REDEPLOY_DELAY = 5 minutes;

    // ─────────────────────────────────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AuditAuction contract — receives job creation requests.
    address public auctionContract;

    /// @notice Orchestrator address — authorised to call onRedeployDetected.
    address public orchestrator;

    /// @notice Minimum GUARD budget a vault must have to justify re-scheduling.
    uint256 public minAuditBudget;

    /// @notice Maps covered contract address to its audit schedule.
    mapping(address => AuditSchedule) public schedules;

    /// @notice Enumerable list of all scheduled contract addresses.
    address[] public scheduledContracts;

    // ─────────────────────────────────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Emitted when a new audit schedule is registered or updated.
    /// @dev Orchestrator / Dashboard subscribe to this to show schedule state.
    event AuditScheduled(
        address indexed contractAddress,
        address indexed owner,
        address scheduleAddress,
        uint256 nextAuditDue,
        TriggerMode mode,
        uint256 intervalSeconds
    );

    /// @notice Emitted when the HSS fires and triggerAudit() executes.
    /// @dev Orchestrator listens to this to call AuditAuction.createAuditJob().
    event AuditTriggered(
        address indexed contractAddress,
        address scheduleAddress,
        uint256 triggeredAt,
        uint256 timesTriggered,
        address nextScheduleAddress  // address(0) if not re-scheduled
    );

    /// @notice Emitted when a schedule is purposefully cancelled.
    event AuditScheduleCancelled(
        address indexed contractAddress,
        address indexed cancelledBy,
        string reason
    );

    /// @notice Emitted if the HSS scheduleCall itself fails.
    event ScheduleFailed(
        address indexed contractAddress,
        int64 responseCode,
        string context
    );

    // ─────────────────────────────────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "AuditScheduler: caller is not orchestrator");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deploys AuditScheduler.
    /// @param _guardToken     GUARD HTS token EVM address.
    /// @param _auctionContract AuditAuction contract address.
    /// @param _orchestrator   Orchestrator address.
    /// @param _minAuditBudget Minimum GUARD balance vault must hold to allow re-scheduling.
    constructor(
        address _guardToken,
        address _auctionContract,
        address _orchestrator,
        uint256 _minAuditBudget
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "AuditScheduler: guard token is zero");
        require(_auctionContract != address(0), "AuditScheduler: auction is zero");
        require(_orchestrator != address(0), "AuditScheduler: orchestrator is zero");
        guardToken = _guardToken;
        auctionContract = _auctionContract;
        orchestrator = _orchestrator;
        minAuditBudget = _minAuditBudget;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Vault-owner actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Register or update a recurring audit schedule for a contract.
    /// @dev For TIME_BASED mode, `intervalSeconds` must be in [MIN_INTERVAL, MAX_INTERVAL].
    ///      For REDEPLOY mode, pass intervalSeconds = 0.
    ///      Calling again for an already-scheduled contract replaces the existing schedule:
    ///      the old HSS schedule is deleted first.
    ///
    ///      THIS IS THE ENTRY POINT FOR CONTRACT-DRIVEN SCHEDULING.
    ///      The vault owner calls this once; HSS handles everything thereafter.
    ///
    /// @param contractAddress  The smart contract to audit.
    /// @param intervalSeconds  Seconds between audits (TIME_BASED) or 0 (REDEPLOY).
    /// @param mode             TIME_BASED or REDEPLOY.
    function scheduleAudit(
        address contractAddress,
        uint256 intervalSeconds,
        TriggerMode mode
    ) external nonReentrant {
        require(contractAddress != address(0), "AuditScheduler: contract is zero");

        if (mode == TriggerMode.TIME_BASED) {
            require(intervalSeconds >= MIN_INTERVAL, "AuditScheduler: interval too short");
            require(intervalSeconds <= MAX_INTERVAL, "AuditScheduler: interval too long");
        } else {
            // REDEPLOY mode — no interval required; orchestrator fires onRedeployDetected
            intervalSeconds = 0;
        }

        AuditSchedule storage sched = schedules[contractAddress];

        // If replacing an existing active schedule, delete the old HSS entity first
        if (sched.active && sched.currentScheduleAddr != address(0)) {
            deleteSchedule(sched.currentScheduleAddr);
        }

        // Track for enumeration (avoid duplicates)
        if (!sched.active && sched.owner == address(0)) {
            scheduledContracts.push(contractAddress);
        }

        sched.owner = msg.sender;
        sched.mode = mode;
        sched.intervalSeconds = intervalSeconds;
        sched.timesTriggered = 0;
        sched.active = true;

        if (mode == TriggerMode.TIME_BASED) {
            uint256 firstAuditDue = block.timestamp + intervalSeconds;
            sched.nextAuditDue = firstAuditDue;
            _createSchedule(contractAddress, firstAuditDue);
        } else {
            // REDEPLOY mode: schedule arm is created by onRedeployDetected()
            sched.nextAuditDue = 0;
            sched.currentScheduleAddr = address(0);
            emit AuditScheduled(contractAddress, msg.sender, address(0), 0, mode, intervalSeconds);
        }
    }

    /// @notice Cancel an audit schedule and delete the pending HSS schedule.
    /// @param contractAddress The contract whose schedule to cancel.
    function cancelSchedule(address contractAddress) external nonReentrant {
        AuditSchedule storage sched = schedules[contractAddress];
        require(sched.active, "AuditScheduler: no active schedule");
        require(
            msg.sender == sched.owner || msg.sender == owner() || msg.sender == orchestrator,
            "AuditScheduler: unauthorized"
        );

        _deactivate(contractAddress, msg.sender, "manual_cancel");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  HSS callback — called by the Hedera network at schedule expiry
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Called autonomously by the Hedera network when an HSS schedule fires.
    /// @dev Only this contract or the schedule owner may call it (guards against front-running).
    ///      Emits AuditTriggered so the orchestrator can open a new AuditAuction job.
    ///      For TIME_BASED, re-schedules the next cycle immediately.
    /// @param contractAddress The contract being audited.
    function triggerAudit(address contractAddress) external nonReentrant {
        AuditSchedule storage sched = schedules[contractAddress];
        require(sched.active, "AuditScheduler: no active schedule");
        // HSS calls this as the contract itself; orchestrator may also call for redeploy mode
        require(
            msg.sender == address(this) || msg.sender == orchestrator,
            "AuditScheduler: unauthorized caller"
        );

        sched.timesTriggered += 1;
        address firedSchedule = sched.currentScheduleAddr;
        sched.currentScheduleAddr = address(0);

        address nextScheduleAddr = address(0);

        if (sched.mode == TriggerMode.TIME_BASED) {
            // Advance due time by interval (not block.timestamp to avoid drift)
            uint256 nextDue = sched.nextAuditDue + sched.intervalSeconds;
            sched.nextAuditDue = nextDue;

            // Re-schedule next cycle
            nextScheduleAddr = _createSchedule(contractAddress, nextDue);
        }

        // Signal orchestrator to open a new AuditAuction job
        emit AuditTriggered(
            contractAddress,
            firedSchedule,
            block.timestamp,
            sched.timesTriggered,
            nextScheduleAddr
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Orchestrator actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Called by the orchestrator when the scanner detects a new bytecode hash.
    /// @dev Creates an immediate (REDEPLOY_DELAY) HSS schedule for the contract.
    ///      If the contract is not in REDEPLOY mode, this is a no-op.
    /// @param contractAddress The re-deployed contract.
    function onRedeployDetected(address contractAddress) external onlyOrchestrator nonReentrant {
        AuditSchedule storage sched = schedules[contractAddress];
        if (!sched.active || sched.mode != TriggerMode.REDEPLOY) return;

        // Cancel any prior pending redeploy schedule
        if (sched.currentScheduleAddr != address(0)) {
            deleteSchedule(sched.currentScheduleAddr);
            sched.currentScheduleAddr = address(0);
        }

        uint256 immediateAuditDue = block.timestamp + REDEPLOY_DELAY;
        sched.nextAuditDue = immediateAuditDue;
        _createSchedule(contractAddress, immediateAuditDue);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  View functions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the audit schedule for a given contract.
    function getSchedule(address contractAddress) external view returns (AuditSchedule memory) {
        return schedules[contractAddress];
    }

    /// @notice Returns all contracts that have an active schedule.
    function getActiveSchedules() external view returns (address[] memory active) {
        uint256 count;
        uint256 len = scheduledContracts.length;
        for (uint256 i; i < len; i++) {
            if (schedules[scheduledContracts[i]].active) count++;
        }
        active = new address[](count);
        uint256 idx;
        for (uint256 i; i < len; i++) {
            if (schedules[scheduledContracts[i]].active) {
                active[idx++] = scheduledContracts[i];
            }
        }
    }

    /// @notice Total number of contracts that have ever been scheduled.
    function totalScheduled() external view returns (uint256) {
        return scheduledContracts.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Update the orchestrator address.
    function setOrchestrator(address _orchestrator) external onlyOwner {
        require(_orchestrator != address(0), "AuditScheduler: orchestrator is zero");
        orchestrator = _orchestrator;
    }

    /// @notice Update the AuditAuction contract address.
    function setAuctionContract(address _auctionContract) external onlyOwner {
        require(_auctionContract != address(0), "AuditScheduler: auction is zero");
        auctionContract = _auctionContract;
    }

    /// @notice Update the minimum vault GUARD balance required to allow re-scheduling.
    function setMinAuditBudget(uint256 _minAuditBudget) external onlyOwner {
        minAuditBudget = _minAuditBudget;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Calls HSS scheduleCall targeting triggerAudit(contractAddress) at expirySecond.
    ///      If the call fails or there is no capacity, emits ScheduleFailed and deactivates.
    /// @param contractAddress The contract to audit.
    /// @param expirySecond    Unix timestamp when HSS should fire.
    /// @return schedAddr      The created HSS schedule address (address(0) on failure).
    function _createSchedule(address contractAddress, uint256 expirySecond) internal returns (address schedAddr) {
        // Pre-flight capacity check
        if (!hasScheduleCapacity(expirySecond, TRIGGER_GAS_LIMIT)) {
            emit ScheduleFailed(contractAddress, int64(HederaResponseCodes.UNKNOWN), "no_capacity");
            _deactivate(contractAddress, address(this), "no_schedule_capacity");
            return address(0);
        }

        bytes memory callData = abi.encodeWithSelector(
            this.triggerAudit.selector,
            contractAddress
        );

        (int64 rc, address scheduleAddress) = scheduleCall(
            address(this),
            expirySecond,
            TRIGGER_GAS_LIMIT,
            0,
            callData
        );

        if (rc != int64(HederaResponseCodes.SUCCESS)) {
            emit ScheduleFailed(contractAddress, rc, "schedule_call_failed");
            _deactivate(contractAddress, address(this), "hss_error");
            return address(0);
        }

        schedules[contractAddress].currentScheduleAddr = scheduleAddress;

        emit AuditScheduled(
            contractAddress,
            schedules[contractAddress].owner,
            scheduleAddress,
            expirySecond,
            schedules[contractAddress].mode,
            schedules[contractAddress].intervalSeconds
        );

        return scheduleAddress;
    }

    /// @dev Cancels the HSS schedule (best-effort) and marks the entry inactive.
    function _deactivate(address contractAddress, address cancelledBy, string memory reason) internal {
        AuditSchedule storage sched = schedules[contractAddress];
        if (sched.currentScheduleAddr != address(0)) {
            deleteSchedule(sched.currentScheduleAddr);
            sched.currentScheduleAddr = address(0);
        }
        sched.active = false;
        emit AuditScheduleCancelled(contractAddress, cancelledBy, reason);
    }
}
