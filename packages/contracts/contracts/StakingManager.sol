// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @notice Extended callback interface for StakingManager → AgentRegistry reputation sync.
/// @dev AgentRegistry.updateReputation(address, int256) exists gated by onlyOrchestratorOrAuction.
///      StakingManager must be added as an authorized caller in Prompt 4 rewiring.
interface IAgentRegistryStaking {
    function updateReputation(address agent, int256 delta) external;
}

/// @notice Minimal interface for DelegatedStaking slash propagation.
/// @dev DelegatedStaking.propagateSlash() must be called after every initiateSlash()
///      so delegators share proportional slashing risk with the agent.
interface IDelegatedStaking {
    function propagateSlash(address agent, uint256 slashBps) external;
}

/// @title AuditGuard Staking Manager
/// @notice Single source of truth for agent collateral, staking economics, slashing with
///         on-chain evidence and appeals, and unbonding cooldowns. Replaces the scattered
///         slash logic from Day 1 (AgentRegistry, AuditAuction, SubAuction) with a unified
///         contract that treats pre-built seeded agents and external third-party agents
///         identically.
/// @dev Integrates with AgentRegistry (identity/reputation), AuditAuction (job locks),
///      SubAuction (sub-job slashing), and PaymentSettlement (completion unlocks).
///      Slashed funds go through an escrow period during which agents can appeal.
///      Evidence is stored as a bytes32 hash anchored in 0g Labs DA by the iNFT teammate.
///      Governance hooks: parameter-setting functions are gated to owner for MVP, intended
///      for DAO governance per the spec ("Agents vote on slashing/penalty parameters").
contract StakingManager is ReentrancyGuard, Pausable, Ownable {
    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code for successful operations.
    int64 internal constant HTS_SUCCESS = 22;

    /// @dev Hedera response code when token is already associated.
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────

    /// @notice Lifecycle status of an agent's stake.
    enum StakeStatus {
        ACTIVE,
        UNBONDING,
        WITHDRAWN,
        FROZEN
    }

    /// @notice Categorised reason for a slashing event.
    enum SlashReason {
        FALSE_POSITIVE,
        FALSE_NEGATIVE,
        MALICIOUS_REPORT,
        SLA_VIOLATION,
        COLLUSION,
        PLAGIARISM
    }

    /// @notice Lifecycle status of a slash appeal.
    enum AppealStatus {
        NONE,
        PENDING,
        APPROVED,
        DENIED
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    /// @notice Full staking state for a single agent.
    struct StakeInfo {
        /// @notice Agent wallet address.
        address agent;
        /// @notice Total GUARD staked (includes locked and available).
        uint256 totalStaked;
        /// @notice Portion locked in active jobs — cannot be unstaked or withdrawn.
        uint256 lockedStake;
        /// @notice Portion available for unstaking (totalStaked - lockedStake).
        uint256 availableStake;
        /// @notice GUARD currently in the unbonding cooldown period.
        uint256 unbondingAmount;
        /// @notice Timestamp when the unbonding cooldown finishes.
        uint256 unbondingCompleteAt;
        /// @notice Current lifecycle status.
        StakeStatus status;
        /// @notice Timestamp of first stake.
        uint256 stakedAt;
        /// @notice Timestamp of most recent stake change.
        uint256 lastStakeChangeAt;
    }

    /// @notice On-chain record of a slashing event with appeal support.
    struct SlashRecord {
        /// @notice Auto-incrementing slash identifier.
        uint256 slashId;
        /// @notice Address of the slashed agent.
        address agent;
        /// @notice AuditAuction jobId that triggered this slash (0 for sub-auction or standalone).
        uint256 jobId;
        /// @notice SubAuction subJobId (0 if main auction).
        uint256 subJobId;
        /// @notice Categorised reason for the slash.
        SlashReason reason;
        /// @notice Slash magnitude in basis points (500 = 5%, 10000 = 100%).
        uint256 slashBasisPoints;
        /// @notice Actual GUARD amount taken from the agent's stake.
        uint256 slashedAmount;
        /// @notice Hash of evidence payload stored in 0g Labs DA by the iNFT teammate.
        bytes32 evidenceHash;
        /// @notice Contract or address that initiated the slash.
        address slashedBy;
        /// @notice Block timestamp when the slash was initiated.
        uint256 timestamp;
        /// @notice Current appeal status.
        AppealStatus appealStatus;
        /// @notice Deadline for the agent to file an appeal.
        uint256 appealDeadline;
        /// @notice Agent's appeal justification (empty if no appeal filed).
        string appealReason;
    }

    /// @notice Point-in-time snapshot of a staking action for history charts.
    /// @dev [Frontend] Renders staking history chart on agent profile page.
    struct StakeSnapshot {
        /// @notice Block timestamp of the action.
        uint256 timestamp;
        /// @notice GUARD amount involved in the action.
        uint256 amount;
        /// @notice Human-readable action label ("stake", "unstake_request", etc.).
        string action;
        /// @notice Job context (0 if not job-related).
        uint256 jobId;
    }

    // ──────────────────────────────────────────────
    //  State — Token & Registry
    // ──────────────────────────────────────────────

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AgentRegistry contract for registration checks and reputation sync.
    address public agentRegistry;

    /// @notice Treasury address that receives finalized slash proceeds.
    address public treasury;

    /// @notice DelegatedStaking contract — receives slash propagation calls.
    /// @dev Set via setDelegatedStaking() after DelegatedStaking is deployed.
    ///      Zero address = delegation feature not yet deployed (skips propagation).
    address public delegatedStaking;

    // ──────────────────────────────────────────────
    //  State — Authorization
    // ──────────────────────────────────────────────

    /// @notice Contracts authorised to initiate slashing, lock, and unlock stake
    ///         (AuditAuction, SubAuction, PaymentSettlement).
    mapping(address => bool) public authorizedSlashers;

    // ──────────────────────────────────────────────
    //  State — Parameters (governance-adjustable)
    // ──────────────────────────────────────────────

    /// @notice Cooldown period before unbonding stake can be withdrawn.
    /// @dev 24 hours for hackathon. Prevents agents from fleeing before report evaluation.
    uint256 public unbondingPeriod = 86400;

    /// @notice Minimum GUARD stake for an agent to remain ACTIVE. 100 GUARD (8 decimals).
    uint256 public minStakeForActive = 100 * 10 ** 8;

    /// @notice Window (seconds) in which a slashed agent can file an appeal.
    uint256 public appealWindowSeconds = 43200;

    /// @notice Hold period for slashed funds in escrow before treasury transfer.
    uint256 public slashEscrowPeriod = 21600;

    // ──────────────────────────────────────────────
    //  State — Slash Rates & Reputation Penalties
    // ──────────────────────────────────────────────

    /// @notice Slash magnitude in basis points per reason. Governance-adjustable per the
    ///         spec: "Agents (weighted by stake + reputation) vote on: Slashing/penalty parameters."
    mapping(SlashReason => uint256) public slashRates;

    /// @notice Reputation delta applied to AgentRegistry per slash reason.
    mapping(SlashReason => int256) public reputationPenalties;

    // ──────────────────────────────────────────────
    //  State — Storage
    // ──────────────────────────────────────────────

    /// @notice Agent wallet → full staking state.
    mapping(address => StakeInfo) public stakes;

    /// @notice Slash ID → full slash record.
    mapping(uint256 => SlashRecord) public slashRecords;

    /// @notice Agent wallet → ordered list of their slash IDs.
    mapping(address => uint256[]) public agentSlashHistory;

    /// @notice Agent wallet → staking action history for frontend charts.
    mapping(address => StakeSnapshot[]) internal _stakeHistory;

    /// @notice Agent wallet → lifetime total GUARD slashed from this agent.
    mapping(address => uint256) public agentTotalSlashed;

    /// @notice Next auto-incrementing slash ID (starts at 1).
    uint256 public nextSlashId = 1;

    /// @notice Aggregate GUARD slashed across all agents for dashboard stats.
    uint256 public totalSlashedAllTime;

    /// @notice GUARD held in escrow pending appeal resolution (not yet sent to treasury).
    uint256 public slashEscrowBalance;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when an agent deposits GUARD stake.
    event Staked(address indexed agent, uint256 amount, uint256 newTotal);

    /// @notice Emitted when an agent initiates the unbonding cooldown.
    event UnstakeRequested(address indexed agent, uint256 amount, uint256 completesAt);

    /// @notice Emitted when unbonding completes and GUARD is returned to the agent.
    event UnstakeCompleted(address indexed agent, uint256 amount);

    /// @notice Emitted when stake is locked for an active audit job.
    event StakeLocked(address indexed agent, uint256 amount, uint256 jobId);

    /// @notice Emitted when stake is unlocked after job completion.
    event StakeUnlocked(address indexed agent, uint256 amount, uint256 jobId);

    /// @notice Emitted when a slash is initiated against an agent.
    /// @dev [iNFT] THE key event: triggers agent profile iNFT state change, stores
    ///      evidence hash as iNFT metadata.
    ///      [Agent Systems] Orchestrator uses this for risk assessment.
    ///      [Frontend] Populates the slash history feed.
    event SlashInitiated(
        uint256 indexed slashId,
        address indexed agent,
        SlashReason reason,
        uint256 slashedAmount,
        uint256 slashBasisPoints,
        bytes32 evidenceHash,
        uint256 jobId
    );

    /// @notice Emitted when a slashed agent files an appeal.
    event AppealFiled(uint256 indexed slashId, address indexed agent, string reason);

    /// @notice Emitted when governance approves an appeal, restoring slashed funds.
    event AppealApproved(uint256 indexed slashId, address indexed agent, uint256 restoredAmount);

    /// @notice Emitted when governance denies an appeal, finalizing the slash to treasury.
    event AppealDenied(uint256 indexed slashId, address indexed agent, uint256 finalizedAmount);

    /// @notice Emitted when an unfiled appeal expires and funds are sent to treasury.
    event AppealExpired(uint256 indexed slashId);

    /// @notice Emitted when a governance-adjustable slash rate is changed.
    event SlashRateUpdated(SlashReason reason, uint256 oldRate, uint256 newRate);

    /// @notice Emitted when the unbonding cooldown period is changed.
    event UnbondingPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);

    /// @notice Emitted when an agent voluntarily begins full exit.
    event AgentDeactivating(address indexed agent);

    /// @notice Emitted when this contract is associated with the GUARD token on HTS.
    event GuardTokenAssociated(address indexed token);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    /// @dev Restricts to contracts registered as authorised slashers/lockers.
    modifier onlyAuthorizedSlasher() {
        require(authorizedSlashers[msg.sender], "StakingManager: not authorized slasher");
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice Deploys the StakingManager with initial slash rates and reputation penalties.
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract address.
    /// @param _treasury Treasury address for finalized slash proceeds.
    constructor(
        address _guardToken,
        address _agentRegistry,
        address _treasury
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "StakingManager: guard token is zero");
        require(_treasury != address(0), "StakingManager: treasury is zero");

        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        treasury = _treasury;

        // Slash rates per spec: "5% false positive, 10% false negative, 100% malicious"
        slashRates[SlashReason.FALSE_POSITIVE] = 500;
        slashRates[SlashReason.FALSE_NEGATIVE] = 1000;
        slashRates[SlashReason.MALICIOUS_REPORT] = 10000;
        slashRates[SlashReason.SLA_VIOLATION] = 2500;
        slashRates[SlashReason.COLLUSION] = 10000;
        slashRates[SlashReason.PLAGIARISM] = 5000;

        // Reputation penalties applied to AgentRegistry on slash
        reputationPenalties[SlashReason.FALSE_POSITIVE] = -100;
        reputationPenalties[SlashReason.FALSE_NEGATIVE] = -200;
        reputationPenalties[SlashReason.MALICIOUS_REPORT] = -5000;
        reputationPenalties[SlashReason.SLA_VIOLATION] = -300;
        reputationPenalties[SlashReason.COLLUSION] = -5000;
        reputationPenalties[SlashReason.PLAGIARISM] = -2500;
    }

    // ──────────────────────────────────────────────
    //  Staking
    // ──────────────────────────────────────────────

    /// @notice Deposits GUARD as collateral. The caller must be registered in AgentRegistry.
    /// @dev [Agent Systems] Day 3 flow: register in AgentRegistry (identity only) → stake
    ///      in StakingManager (economics). AgentRegistry will be updated (Prompt 4) to check
    ///      StakingManager for stake amounts instead of tracking its own.
    ///      [iNFT] Agent iNFT stores "staked collateral" — updated via Staked event.
    /// @param amount GUARD to stake in smallest units.
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "StakingManager: amount is zero");

        // Verify agent is registered (best-effort; Prompt 4 will align the check)
        if (agentRegistry != address(0)) {
            require(
                IAgentRegistry(agentRegistry).isActiveAgent(msg.sender),
                "StakingManager: agent not registered"
            );
        }

        _transferGuard(msg.sender, address(this), amount);

        StakeInfo storage s = stakes[msg.sender];
        if (s.agent == address(0)) {
            s.agent = msg.sender;
            s.stakedAt = block.timestamp;
        }

        s.totalStaked += amount;
        s.availableStake += amount;
        s.lastStakeChangeAt = block.timestamp;

        // Transition from WITHDRAWN to ACTIVE when sufficient stake is provided
        if (s.status == StakeStatus.WITHDRAWN && s.totalStaked >= minStakeForActive) {
            s.status = StakeStatus.ACTIVE;
        }

        _recordSnapshot(msg.sender, amount, "stake", 0);
        emit Staked(msg.sender, amount, s.totalStaked);
    }

    /// @notice Initiates an unbonding cooldown for a partial unstake. The remaining stake
    ///         must stay at or above minStakeForActive. For full exit, use deactivate().
    /// @dev The unbonding period prevents the Day 1 problem where "agents can unstake
    ///      right before a report is evaluated, dodging slashing." Only one unbonding
    ///      can be active at a time — complete the current one before requesting another.
    /// @param amount GUARD to begin unbonding.
    function requestUnstake(uint256 amount) external nonReentrant whenNotPaused {
        StakeInfo storage s = stakes[msg.sender];
        require(s.agent != address(0), "StakingManager: no stake");
        require(s.status == StakeStatus.ACTIVE, "StakingManager: not active");
        require(amount > 0, "StakingManager: amount is zero");
        require(amount <= s.availableStake, "StakingManager: exceeds available stake");
        require(s.unbondingAmount == 0, "StakingManager: unbonding already in progress");

        uint256 remaining = s.totalStaked - amount;
        require(
            remaining >= minStakeForActive,
            "StakingManager: below minimum, use deactivate()"
        );

        s.availableStake -= amount;
        s.unbondingAmount = amount;
        s.unbondingCompleteAt = block.timestamp + unbondingPeriod;
        s.lastStakeChangeAt = block.timestamp;

        _recordSnapshot(msg.sender, amount, "unstake_request", 0);
        emit UnstakeRequested(msg.sender, amount, s.unbondingCompleteAt);
    }

    /// @notice Completes a matured unbonding, returning GUARD to the agent.
    /// @dev Can be called regardless of current status (FROZEN agents can still
    ///      withdraw matured unbonding, but the funds may have been partially slashed).
    function completeUnstake() external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        require(s.unbondingAmount > 0, "StakingManager: nothing to complete");
        require(
            block.timestamp >= s.unbondingCompleteAt,
            "StakingManager: unbonding period not elapsed"
        );

        uint256 amount = s.unbondingAmount;
        s.totalStaked -= amount;
        s.unbondingAmount = 0;
        s.unbondingCompleteAt = 0;
        s.lastStakeChangeAt = block.timestamp;

        if (s.totalStaked == 0) {
            s.status = StakeStatus.WITHDRAWN;
        } else if (s.status == StakeStatus.UNBONDING && s.totalStaked >= minStakeForActive) {
            s.status = StakeStatus.ACTIVE;
        }

        _transferGuard(address(this), msg.sender, amount);

        _recordSnapshot(msg.sender, amount, "unstake_complete", 0);
        emit UnstakeCompleted(msg.sender, amount);
    }

    /// @notice Voluntarily exits the marketplace entirely. All available stake enters
    ///         the unbonding cooldown. All active jobs must be completed first.
    /// @dev Sets status to UNBONDING. After the cooldown, call completeUnstake() to
    ///      withdraw and transition to WITHDRAWN.
    function deactivate() external nonReentrant whenNotPaused {
        StakeInfo storage s = stakes[msg.sender];
        require(s.agent != address(0), "StakingManager: no stake");
        require(
            s.status == StakeStatus.ACTIVE || s.status == StakeStatus.UNBONDING,
            "StakingManager: not active"
        );
        require(s.lockedStake == 0, "StakingManager: has locked stake in active jobs");
        require(s.unbondingAmount == 0, "StakingManager: unbonding already in progress");
        require(s.availableStake > 0, "StakingManager: nothing to unstake");

        uint256 amount = s.availableStake;
        s.availableStake = 0;
        s.unbondingAmount = amount;
        s.unbondingCompleteAt = block.timestamp + unbondingPeriod;
        s.status = StakeStatus.UNBONDING;
        s.lastStakeChangeAt = block.timestamp;

        _recordSnapshot(msg.sender, amount, "deactivate", 0);
        emit AgentDeactivating(msg.sender);
        emit UnstakeRequested(msg.sender, amount, s.unbondingCompleteAt);
    }

    // ──────────────────────────────────────────────
    //  Job Stake Locking
    // ──────────────────────────────────────────────

    /// @notice Locks a portion of an agent's stake for an active audit job.
    /// @dev [Agent Systems] AuditAuction calls this when an agent wins a job, preventing
    ///      the agent from withdrawing collateral that backs their work commitment.
    /// @param agent Agent wallet address.
    /// @param amount GUARD to lock.
    /// @param jobId AuditAuction job ID for context.
    function lockStake(
        address agent,
        uint256 amount,
        uint256 jobId
    ) external onlyAuthorizedSlasher nonReentrant {
        require(amount > 0, "StakingManager: amount is zero");
        StakeInfo storage s = stakes[agent];
        require(s.agent != address(0), "StakingManager: agent has no stake");
        require(amount <= s.availableStake, "StakingManager: exceeds available stake");

        s.availableStake -= amount;
        s.lockedStake += amount;
        s.lastStakeChangeAt = block.timestamp;

        _recordSnapshot(agent, amount, "lock", jobId);
        emit StakeLocked(agent, amount, jobId);
    }

    /// @notice Unlocks stake after an audit job is completed or cancelled.
    /// @dev [Agent Systems] AuditAuction or PaymentSettlement calls this after job
    ///      completion, returning locked collateral to the available pool.
    /// @param agent Agent wallet address.
    /// @param amount GUARD to unlock.
    /// @param jobId AuditAuction job ID for context.
    function unlockStake(
        address agent,
        uint256 amount,
        uint256 jobId
    ) external onlyAuthorizedSlasher nonReentrant {
        require(amount > 0, "StakingManager: amount is zero");
        StakeInfo storage s = stakes[agent];
        require(s.agent != address(0), "StakingManager: agent has no stake");
        require(amount <= s.lockedStake, "StakingManager: exceeds locked stake");

        s.lockedStake -= amount;
        s.availableStake += amount;
        s.lastStakeChangeAt = block.timestamp;

        _recordSnapshot(agent, amount, "unlock", jobId);
        emit StakeUnlocked(agent, amount, jobId);
    }

    // ──────────────────────────────────────────────
    //  Slashing
    // ──────────────────────────────────────────────

    /// @notice Initiates a slash against an agent with on-chain evidence. Slashed funds
    ///         enter escrow for the appeal window before being sent to treasury.
    /// @dev [Agent Systems] AuditAuction, SubAuction, or PaymentSettlement call this when
    ///      evaluation reveals false positives, false negatives, malicious reports, etc.
    ///      [iNFT] SlashInitiated event triggers agent profile iNFT state change and
    ///      stores the evidence hash as iNFT metadata.
    ///      Slash deducts from available stake first, then locked, then unbonding — this
    ///      prevents the Day 1 problem where agents could dodge slashing by unstaking.
    /// @param agent Agent wallet to slash.
    /// @param jobId AuditAuction jobId (0 for sub-auction or standalone).
    /// @param subJobId SubAuction subJobId (0 if main auction).
    /// @param reason Categorised slash reason.
    /// @param evidenceHash Hash of evidence payload stored in 0g Labs DA.
    function initiateSlash(
        address agent,
        uint256 jobId,
        uint256 subJobId,
        SlashReason reason,
        bytes32 evidenceHash
    ) external onlyAuthorizedSlasher nonReentrant whenNotPaused {
        StakeInfo storage s = stakes[agent];
        require(s.agent != address(0), "StakingManager: agent has no stake");
        require(s.totalStaked > 0, "StakingManager: nothing to slash");

        uint256 basisPoints = slashRates[reason];
        require(basisPoints > 0, "StakingManager: slash rate not configured");

        uint256 slashedAmount = _deductSlash(s, basisPoints);

        // Move slashed tokens to escrow (not treasury yet — appeal window)
        slashEscrowBalance += slashedAmount;

        // Create slash record with appeal window
        uint256 slashId = nextSlashId++;
        _createSlashRecord(slashId, agent, jobId, subJobId, reason, basisPoints, slashedAmount, evidenceHash);

        agentSlashHistory[agent].push(slashId);
        agentTotalSlashed[agent] += slashedAmount;
        totalSlashedAllTime += slashedAmount;
        s.lastStakeChangeAt = block.timestamp;

        // Reputation penalty (best-effort until Prompt 4 wires StakingManager as
        // an authorized caller on AgentRegistry.updateReputation)
        _applyReputationPenalty(agent, reason);

        // Freeze agent if below minimum stake or 100% slash
        if (s.totalStaked < minStakeForActive || basisPoints == 10000) {
            s.status = StakeStatus.FROZEN;
            // AgentRegistry status sync (SUSPENDED / SLASHED) will be wired in Prompt 4.
            // For now the FROZEN status in StakingManager is the source of truth.
        }

        _recordSnapshot(agent, slashedAmount, "slash", jobId);
        emit SlashInitiated(slashId, agent, reason, slashedAmount, basisPoints, evidenceHash, jobId);

        // Propagate slash to delegators — they share the agent's risk proportionally.
        // Best-effort (try/catch) so a buggy DelegatedStaking cannot block slashing.
        if (delegatedStaking != address(0)) {
            try IDelegatedStaking(delegatedStaking).propagateSlash(agent, basisPoints) {} catch {}
        }
    }

    // ──────────────────────────────────────────────
    //  Appeals
    // ──────────────────────────────────────────────

    /// @notice Files an appeal against a slash. Must be called by the slashed agent within
    ///         the appeal window. Critical for trust — external third-party agent developers
    ///         need to know they won't be arbitrarily slashed.
    /// @dev For MVP, appeals are resolved by the owner (governance proxy). In production,
    ///      this would go to a DAO vote per the spec: "Agents vote on slashing/penalty
    ///      parameters."
    /// @param slashId Slash record ID to appeal.
    /// @param reason Agent's appeal justification.
    function fileAppeal(uint256 slashId, string calldata reason) external {
        SlashRecord storage record = slashRecords[slashId];
        require(record.slashId != 0, "StakingManager: invalid slash id");
        require(msg.sender == record.agent, "StakingManager: not slashed agent");
        require(record.appealStatus == AppealStatus.PENDING, "StakingManager: not pending");
        require(
            block.timestamp <= record.appealDeadline,
            "StakingManager: appeal window closed"
        );
        require(bytes(reason).length > 0, "StakingManager: reason required");

        record.appealReason = reason;

        emit AppealFiled(slashId, msg.sender, reason);
    }

    /// @notice Resolves an appeal. Only callable by governance (owner for MVP).
    /// @dev If approved: slashed funds return to agent, reputation penalty is reversed,
    ///      and FROZEN status may be restored to ACTIVE.
    ///      If denied: slashed funds transfer from escrow to treasury.
    /// @param slashId Slash record ID to resolve.
    /// @param approved True to approve (restore funds), false to deny (finalize slash).
    function resolveAppeal(uint256 slashId, bool approved) external onlyOwner nonReentrant {
        SlashRecord storage record = slashRecords[slashId];
        require(record.slashId != 0, "StakingManager: invalid slash id");
        require(record.appealStatus == AppealStatus.PENDING, "StakingManager: not pending");
        require(bytes(record.appealReason).length > 0, "StakingManager: no appeal filed");

        if (approved) {
            // Restore slashed funds to agent's available stake
            StakeInfo storage s = stakes[record.agent];
            s.totalStaked += record.slashedAmount;
            s.availableStake += record.slashedAmount;
            s.lastStakeChangeAt = block.timestamp;

            slashEscrowBalance -= record.slashedAmount;
            agentTotalSlashed[record.agent] -= record.slashedAmount;
            totalSlashedAllTime -= record.slashedAmount;

            // Reverse reputation penalty
            int256 repDelta = reputationPenalties[record.reason];
            if (repDelta != 0 && agentRegistry != address(0)) {
                try IAgentRegistryStaking(agentRegistry).updateReputation(
                    record.agent,
                    -repDelta
                ) {} catch {}
            }

            // Restore FROZEN → ACTIVE if sufficient stake
            if (s.status == StakeStatus.FROZEN && s.totalStaked >= minStakeForActive) {
                s.status = StakeStatus.ACTIVE;
            }

            record.appealStatus = AppealStatus.APPROVED;

            _recordSnapshot(record.agent, record.slashedAmount, "appeal_approved", record.jobId);
            emit AppealApproved(slashId, record.agent, record.slashedAmount);
        } else {
            // Finalize — transfer slashed funds from escrow to treasury
            slashEscrowBalance -= record.slashedAmount;
            _transferGuard(address(this), treasury, record.slashedAmount);

            record.appealStatus = AppealStatus.DENIED;

            emit AppealDenied(slashId, record.agent, record.slashedAmount);
        }
    }

    /// @notice Finalizes expired, unfiled appeals — transferring escrowed funds to treasury.
    ///         Permissionless (anyone can call) to prevent stuck escrow funds.
    /// @dev Processes slash records where the appeal window has closed and no appeal was
    ///      filed. Filed appeals (non-empty appealReason) remain PENDING for governance.
    function finalizeExpiredAppeals() external nonReentrant {
        for (uint256 i = 1; i < nextSlashId; i++) {
            SlashRecord storage record = slashRecords[i];
            if (
                record.appealStatus == AppealStatus.PENDING &&
                block.timestamp > record.appealDeadline &&
                bytes(record.appealReason).length == 0
            ) {
                slashEscrowBalance -= record.slashedAmount;
                _transferGuard(address(this), treasury, record.slashedAmount);

                record.appealStatus = AppealStatus.DENIED;

                emit AppealExpired(i);
            }
        }
    }

    // ──────────────────────────────────────────────
    //  Governance / Admin
    // ──────────────────────────────────────────────

    /// @notice Sets the slash rate for a given reason. Governance-adjustable per the spec:
    ///         "Agents (weighted by stake + reputation) vote on: Slashing/penalty parameters."
    /// @dev For MVP, only callable by owner. In production, this would be called by the
    ///      DAO governance contract.
    /// @param reason Slash reason to configure.
    /// @param basisPoints New slash magnitude (0-10000, where 10000 = 100%).
    function setSlashRate(SlashReason reason, uint256 basisPoints) external onlyOwner {
        require(basisPoints <= 10000, "StakingManager: exceeds 100%");
        uint256 oldRate = slashRates[reason];
        slashRates[reason] = basisPoints;
        emit SlashRateUpdated(reason, oldRate, basisPoints);
    }

    /// @notice Sets the unbonding cooldown period.
    /// @param seconds_ New unbonding duration in seconds.
    function setUnbondingPeriod(uint256 seconds_) external onlyOwner {
        uint256 oldPeriod = unbondingPeriod;
        unbondingPeriod = seconds_;
        emit UnbondingPeriodUpdated(oldPeriod, seconds_);
    }

    /// @notice Sets the appeal window duration.
    /// @param seconds_ New appeal window in seconds.
    function setAppealWindow(uint256 seconds_) external onlyOwner {
        appealWindowSeconds = seconds_;
    }

    /// @notice Sets the slash escrow hold period.
    /// @param seconds_ New escrow period in seconds.
    function setSlashEscrowPeriod(uint256 seconds_) external onlyOwner {
        slashEscrowPeriod = seconds_;
    }

    /// @notice Sets the reputation penalty for a given slash reason.
    /// @param reason Slash reason to configure.
    /// @param delta Reputation delta (should be negative for penalties).
    function setReputationPenalty(SlashReason reason, int256 delta) external onlyOwner {
        reputationPenalties[reason] = delta;
    }

    /// @notice Adds a contract as an authorised slasher/locker.
    /// @param slasher Contract address to authorise.
    function addAuthorizedSlasher(address slasher) external onlyOwner {
        require(slasher != address(0), "StakingManager: address is zero");
        authorizedSlashers[slasher] = true;
    }

    /// @notice Removes a contract from the authorised slashers.
    /// @param slasher Contract address to deauthorise.
    function removeAuthorizedSlasher(address slasher) external onlyOwner {
        authorizedSlashers[slasher] = false;
    }

    /// @notice Sets the AgentRegistry contract address.
    /// @param _agentRegistry New AgentRegistry address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        agentRegistry = _agentRegistry;
    }

    /// @notice Sets the treasury address for slash proceeds.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "StakingManager: address is zero");
        treasury = _treasury;
    }

    /// @notice Wires the DelegatedStaking contract so slash events propagate to delegators.
    /// @dev Call after deploying DelegatedStaking. Set to address(0) to disable propagation.
    ///      [DelegatedStaking] DelegatedStaking.propagateSlash() is called from initiateSlash().
    /// @param _delegatedStaking DelegatedStaking contract address.
    function setDelegatedStaking(address _delegatedStaking) external onlyOwner {
        delegatedStaking = _delegatedStaking;
    }

    /// @notice Associates this contract with the GUARD token through HTS precompile.
    /// @dev Call post-deployment on Hedera JSON-RPC flows where constructor precompile
    ///      calls can revert.
    function associateGuardToken() external onlyOwner nonReentrant {
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "StakingManager: token association failed"
        );
        emit GuardTokenAssociated(guardToken);
    }

    /// @notice Pauses all staking and slashing operations. Emergency use only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    /// @notice Returns the full staking state for an agent.
    /// @dev [iNFT] Agent iNFT reads "staked collateral" from this.
    /// @param agent Agent wallet address.
    /// @return info Full StakeInfo struct.
    function getStakeInfo(address agent) external view returns (StakeInfo memory info) {
        return stakes[agent];
    }

    /// @notice Returns the effective stake (total minus unbonding) — what actually backs
    ///         the agent's commitments.
    /// @param agent Agent wallet address.
    /// @return effective Effective GUARD stake.
    function getEffectiveStake(address agent) external view returns (uint256 effective) {
        StakeInfo storage s = stakes[agent];
        return s.totalStaked > s.unbondingAmount ? s.totalStaked - s.unbondingAmount : 0;
    }

    /// @notice Checks whether an agent has sufficient available stake for a commitment.
    /// @dev [Agent Systems] AuditAuction checks this before accepting bids to ensure
    ///      the agent can back their commitment with collateral.
    /// @param agent Agent wallet address.
    /// @param requiredAmount Minimum GUARD required.
    /// @return sufficient True if the agent's available stake covers the requirement.
    function isStakeSufficient(
        address agent,
        uint256 requiredAmount
    ) external view returns (bool sufficient) {
        return stakes[agent].availableStake >= requiredAmount;
    }

    /// @notice Returns a slash record by ID.
    /// @param slashId Slash record identifier.
    /// @return record Full SlashRecord struct.
    function getSlashRecord(uint256 slashId) external view returns (SlashRecord memory record) {
        return slashRecords[slashId];
    }

    /// @notice Returns all slash IDs for an agent.
    /// @dev [Agent Systems] Agents check counterparty risk before sub-contracting.
    /// @param agent Agent wallet address.
    /// @return slashIds Ordered list of slash record IDs.
    function getAgentSlashHistory(
        address agent
    ) external view returns (uint256[] memory slashIds) {
        return agentSlashHistory[agent];
    }

    /// @notice Returns the number of times an agent has been slashed.
    /// @dev [Agent Systems] Quick counterparty risk check.
    /// @param agent Agent wallet address.
    /// @return count Number of slash events.
    function getSlashCount(address agent) external view returns (uint256 count) {
        return agentSlashHistory[agent].length;
    }

    /// @notice Returns the full staking action history for an agent.
    /// @dev [Frontend] Renders staking history chart on the agent profile page.
    /// @param agent Agent wallet address.
    /// @return history Ordered array of StakeSnapshot records.
    function getStakeHistory(
        address agent
    ) external view returns (StakeSnapshot[] memory history) {
        return _stakeHistory[agent];
    }

    /// @notice Returns a health summary for an agent's staking position.
    /// @dev [Frontend] Agent detail card on the dashboard.
    ///      [Agent Systems] Risk assessment for sub-contracting decisions.
    /// @param agent Agent wallet address.
    /// @return effectiveStake GUARD backing commitments (total - unbonding).
    /// @return slashCount Lifetime slash event count.
    /// @return totalSlashed Lifetime GUARD slashed.
    /// @return hasActiveAppeals Whether any slash appeal is PENDING.
    /// @return status Current StakeStatus.
    function getAgentStakeHealth(
        address agent
    )
        external
        view
        returns (
            uint256 effectiveStake,
            uint256 slashCount,
            uint256 totalSlashed,
            bool hasActiveAppeals,
            StakeStatus status
        )
    {
        StakeInfo storage s = stakes[agent];
        effectiveStake = s.totalStaked > s.unbondingAmount
            ? s.totalStaked - s.unbondingAmount
            : 0;
        slashCount = agentSlashHistory[agent].length;
        totalSlashed = agentTotalSlashed[agent];

        hasActiveAppeals = false;
        uint256[] storage history = agentSlashHistory[agent];
        for (uint256 i = 0; i < history.length; i++) {
            if (slashRecords[history[i]].appealStatus == AppealStatus.PENDING) {
                hasActiveAppeals = true;
                break;
            }
        }

        status = s.status;
    }

    /// @notice Returns all slash IDs with PENDING appeal status.
    /// @dev [Frontend] Governance/admin panel for reviewing and resolving appeals.
    /// @return slashIds Array of slash IDs awaiting resolution.
    function getPendingAppeals() external view returns (uint256[] memory slashIds) {
        // Count pending
        uint256 count = 0;
        for (uint256 i = 1; i < nextSlashId; i++) {
            if (slashRecords[i].appealStatus == AppealStatus.PENDING) {
                count++;
            }
        }

        // Collect
        slashIds = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i < nextSlashId; i++) {
            if (slashRecords[i].appealStatus == AppealStatus.PENDING) {
                slashIds[idx++] = i;
            }
        }
    }

    /// @notice Returns the slash rate for a given reason.
    /// @param reason Slash reason to query.
    /// @return basisPoints Slash magnitude (500 = 5%, 10000 = 100%).
    function getSlashRate(SlashReason reason) external view returns (uint256 basisPoints) {
        return slashRates[reason];
    }

    /// @notice Returns the aggregate GUARD slashed across all agents.
    /// @dev [Frontend] Dashboard aggregate stat.
    /// @return total Lifetime GUARD slashed.
    function getTotalSlashedAllTime() external view returns (uint256 total) {
        return totalSlashedAllTime;
    }

    // ──────────────────────────────────────────────
    //  Internal Helpers
    // ──────────────────────────────────────────────

    /// @dev Appends a snapshot to the agent's staking history.
    function _recordSnapshot(
        address agent,
        uint256 amount,
        string memory action,
        uint256 jobId
    ) internal {
        _stakeHistory[agent].push(
            StakeSnapshot({
                timestamp: block.timestamp,
                amount: amount,
                action: action,
                jobId: jobId
            })
        );
    }

    /// @dev Deducts slashed amount from an agent's stake pools: available → locked → unbonding.
    ///      Reaching unbonding funds prevents the dodge-by-unstaking exploit.
    function _deductSlash(
        StakeInfo storage s,
        uint256 basisPoints
    ) internal returns (uint256 slashedAmount) {
        slashedAmount = (s.totalStaked * basisPoints) / 10000;
        if (slashedAmount > s.totalStaked) slashedAmount = s.totalStaked;

        s.totalStaked -= slashedAmount;
        uint256 remaining = slashedAmount;

        // Deduct from available first
        uint256 take = remaining < s.availableStake ? remaining : s.availableStake;
        s.availableStake -= take;
        remaining -= take;

        // Then from locked
        if (remaining > 0) {
            take = remaining < s.lockedStake ? remaining : s.lockedStake;
            s.lockedStake -= take;
            remaining -= take;
        }

        // Then from unbonding
        if (remaining > 0) {
            take = remaining < s.unbondingAmount ? remaining : s.unbondingAmount;
            s.unbondingAmount -= take;
        }
    }

    /// @dev Creates and stores a SlashRecord. Separated to reduce stack depth in initiateSlash.
    function _createSlashRecord(
        uint256 slashId,
        address agent,
        uint256 jobId,
        uint256 subJobId,
        SlashReason reason,
        uint256 basisPoints,
        uint256 slashedAmount,
        bytes32 evidenceHash
    ) internal {
        slashRecords[slashId] = SlashRecord({
            slashId: slashId,
            agent: agent,
            jobId: jobId,
            subJobId: subJobId,
            reason: reason,
            slashBasisPoints: basisPoints,
            slashedAmount: slashedAmount,
            evidenceHash: evidenceHash,
            slashedBy: msg.sender,
            timestamp: block.timestamp,
            appealStatus: AppealStatus.PENDING,
            appealDeadline: block.timestamp + appealWindowSeconds,
            appealReason: ""
        });
    }

    /// @dev Applies reputation penalty to AgentRegistry. Best-effort via try/catch until
    ///      Prompt 4 wires StakingManager as an authorized caller.
    function _applyReputationPenalty(address agent, SlashReason reason) internal {
        int256 repDelta = reputationPenalties[reason];
        if (repDelta != 0 && agentRegistry != address(0)) {
            try IAgentRegistryStaking(agentRegistry).updateReputation(agent, repDelta) {} catch {}
        }
    }

    /// @dev Transfers GUARD via HTS precompile with int64 safety check.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(
            amount <= uint256(uint64(type(int64).max)),
            "StakingManager: amount exceeds int64"
        );
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "StakingManager: HTS transfer failed");
    }
}
