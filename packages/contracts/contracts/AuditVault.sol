// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @notice Minimal callback interface for the parent VaultFactory.
interface IVaultFactory {
    /// @notice Called by a vault when auto-audit trigger conditions are met.
    function onAutoAuditTriggered(address contractAddress, string calldata reason) external;

    /// @notice Called by a vault to register a first-time depositor in the factory's index.
    function registerDepositor(address depositor, address vault) external;
}

/// @title AuditGuard Audit Vault
/// @notice Individual vault instance tied to a single audited smart contract. Supports
///         multi-depositor funding, escrow reservations for audit jobs, monitoring agent
///         subscriptions, critical bounty pools, and automatic re-audit triggering.
/// @dev Deployed by VaultFactory via CREATE2 with the covered contract address as salt.
///      Must be initialized exactly once via initialize() immediately after deployment.
contract AuditVault is ReentrancyGuard {
    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code for successful operations.
    int64 internal constant HTS_SUCCESS = 22;

    /// @dev Hedera response code when token is already associated.
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    /// @dev Duration of one monitoring payment window.
    uint256 internal constant WEEK = 7 days;

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    /// @notice Configuration rules governing vault behaviour. Shared with VaultFactory.
    struct VaultConfig {
        /// @notice Maximum GUARD per week the vault will pay for continuous monitoring. 0 = no monitoring budget.
        uint256 weeklyMonitoringBudget;
        /// @notice GUARD reserved for critical vulnerability bounties.
        uint256 criticalBountyAllocation;
        /// @notice Seconds between automatic re-audit triggers. 0 = manual only.
        uint256 reauditIntervalSeconds;
        /// @notice Maximum GUARD allowed for a single audit job draw, preventing full drain.
        uint256 maxSingleAuditBudget;
        /// @notice Whether monitoring agents are allowed to apply for subscriptions.
        bool acceptsMonitoringBids;
    }

    /// @notice Active monitoring subscription state.
    struct MonitoringSubscription {
        /// @notice Wallet of the monitoring agent. address(0) if none.
        address agent;
        /// @notice GUARD per week the agent charges.
        uint256 weeklyRate;
        /// @notice Timestamp when the subscription started.
        uint256 startedAt;
        /// @notice Timestamp of last monitoring payment claim.
        uint256 lastPaymentAt;
        /// @notice Timestamp when subscription expires. 0 = indefinite until cancelled.
        uint256 expiresAt;
        /// @notice Whether the subscription is currently active.
        bool active;
    }

    // ──────────────────────────────────────────────
    //  State — Identity
    // ──────────────────────────────────────────────

    /// @notice The VaultFactory that deployed this vault.
    address public factory;

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice The smart contract this vault covers.
    address public contractAddress;

    /// @notice Chain identifier of the covered contract (e.g. "hedera-testnet").
    string public contractChain;

    /// @notice Address that created this vault — has admin rights over configuration.
    address public creator;

    /// @notice AgentRegistry contract address for agent tier/status checks.
    address public agentRegistry;

    /// @notice Current vault configuration rules.
    VaultConfig public config;

    /// @notice Whether initialize() has been called.
    bool public initialized;

    // ──────────────────────────────────────────────
    //  State — Financial
    // ──────────────────────────────────────────────

    /// @notice Lifetime total GUARD deposited across all depositors.
    uint256 public totalDeposited;

    /// @notice Current available GUARD balance (includes escrowed and bounty-earmarked funds).
    uint256 public currentBalance;

    /// @notice GUARD locked by active audit auctions. Cannot be withdrawn.
    uint256 public reservedForEscrow;

    /// @notice Funded portion of the critical bounty allocation.
    uint256 public criticalBountyPool;

    /// @notice GUARD already paid out from the critical bounty pool.
    uint256 public criticalBountySpent;

    // ──────────────────────────────────────────────
    //  State — Monitoring
    // ──────────────────────────────────────────────

    /// @notice Current monitoring agent subscription.
    MonitoringSubscription public activeMonitor;

    /// @notice GUARD spent on monitoring in the current weekly window.
    uint256 public weeklyMonitoringSpent;

    /// @notice Start of the current weekly monitoring window.
    uint256 public weeklyResetTimestamp;

    // ──────────────────────────────────────────────
    //  State — Audit History
    // ──────────────────────────────────────────────

    /// @notice Timestamp of the most recently completed audit.
    uint256 public lastAuditTimestamp;

    /// @notice Total number of audits completed for this contract.
    uint256 public totalAuditsCompleted;

    /// @notice Security score (0-100) set by the most recent audit / iNFT update.
    uint256 public lastSecurityScore;

    /// @notice True when re-audit conditions are met and an auction should be created.
    bool public auditTriggerPending;

    /// @notice Vault balance snapshot taken at last audit completion (for threshold triggers).
    uint256 public balanceAtLastAudit;

    // ──────────────────────────────────────────────
    //  State — Depositors
    // ──────────────────────────────────────────────

    /// @notice Per-depositor contribution tracking for proportional withdrawal rights.
    mapping(address => uint256) public depositorBalances;

    /// @notice Ordered list of unique depositor addresses.
    address[] public depositors;

    /// @dev Fast lookup to avoid duplicate pushes to depositors[].
    mapping(address => bool) private _isDepositor;

    // ──────────────────────────────────────────────
    //  State — Access Control
    // ──────────────────────────────────────────────

    /// @notice Contracts authorised to reserve/draw funds (AuditAuction, PaymentSettlement, etc.).
    mapping(address => bool) public authorizedDrawers;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when GUARD is deposited into this vault.
    /// @dev [Frontend] Feeds the live deposit activity feed on the dashboard.
    event Deposited(address indexed depositor, uint256 amount, uint256 newBalance);

    /// @notice Emitted when a depositor withdraws their proportional share.
    event Withdrawn(address indexed depositor, uint256 amount);

    /// @notice Emitted when funds are reserved for an active audit auction.
    event BudgetReserved(uint256 amount, uint256 totalReserved);

    /// @notice Emitted when reserved funds are drawn to pay an agent.
    event PaymentDrawn(address indexed recipient, uint256 amount);

    /// @notice Emitted when a reservation is released (job cancelled).
    event ReservationReleased(uint256 amount);

    /// @notice Emitted when a critical bounty is paid out.
    event BountyPaid(address indexed recipient, uint256 amount);

    /// @notice Emitted when a monitoring agent successfully applies.
    event MonitoringApplied(address indexed agent, uint256 weeklyRate);

    /// @notice Emitted when the monitoring agent is replaced by a cheaper competitor.
    event MonitoringAgentChanged(address indexed oldAgent, address indexed newAgent, uint256 newRate);

    /// @notice Emitted when a monitoring agent claims their periodic payment.
    event MonitoringPaymentClaimed(address indexed agent, uint256 amount);

    /// @notice Emitted when a monitoring subscription is cancelled.
    event MonitoringCancelled(address indexed agent);

    /// @notice Emitted when an audit is recorded as completed.
    /// @dev [iNFT] Triggers Contract Health iNFT state update.
    event AuditRecorded(uint256 securityScore, uint256 totalAudits);

    /// @notice Emitted when automatic re-audit conditions are met.
    /// @dev [Agent Systems] Orchestrator listens and creates new AuditAuction jobs.
    event AutoAuditTriggered(string reason);

    /// @notice Emitted when the vault configuration is updated by the creator.
    event ConfigUpdated();

    /// @notice Emitted when this vault is associated with the GUARD token on HTS.
    event GuardTokenAssociated(address indexed token);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    /// @dev Restricts to contracts registered as authorised drawers.
    modifier onlyAuthorizedDrawer() {
        require(authorizedDrawers[msg.sender], "AuditVault: caller is not authorized drawer");
        _;
    }

    /// @dev Restricts to the vault creator (admin).
    modifier onlyCreator() {
        require(msg.sender == creator, "AuditVault: caller is not creator");
        _;
    }

    // ──────────────────────────────────────────────
    //  Initialization
    // ──────────────────────────────────────────────

    /// @notice Initializes the vault with its identity, configuration, and authorized drawers.
    /// @dev Called exactly once by VaultFactory immediately after CREATE2 deployment.
    ///      The caller (VaultFactory) is stored as `factory` for callback permissions.
    /// @param _contractAddress The smart contract this vault covers.
    /// @param _contractChain Chain identifier (e.g. "hedera-testnet").
    /// @param _creator Address that created the vault (admin).
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract for monitoring tier checks.
    /// @param _config Initial vault configuration rules.
    /// @param _authorizedDrawers Contracts permitted to reserve and draw funds.
    function initialize(
        address _contractAddress,
        string calldata _contractChain,
        address _creator,
        address _guardToken,
        address _agentRegistry,
        VaultConfig calldata _config,
        address[] calldata _authorizedDrawers
    ) external {
        require(!initialized, "AuditVault: already initialized");
        require(_contractAddress != address(0), "AuditVault: contract address is zero");
        require(_creator != address(0), "AuditVault: creator is zero");
        require(_guardToken != address(0), "AuditVault: guard token is zero");

        initialized = true;
        factory = msg.sender;
        contractAddress = _contractAddress;
        contractChain = _contractChain;
        creator = _creator;
        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        config = _config;
        weeklyResetTimestamp = block.timestamp;

        for (uint256 i = 0; i < _authorizedDrawers.length; i++) {
            authorizedDrawers[_authorizedDrawers[i]] = true;
        }
    }

    /// @notice Associates this vault with the GUARD token through HTS precompile.
    /// @dev Called by VaultFactory after initialization. Also available as a standalone call
    ///      if the association fails during the deployment transaction on Hedera JSON-RPC.
    function associateGuardToken() external nonReentrant {
        require(initialized, "AuditVault: not initialized");
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "AuditVault: token association failed"
        );
        emit GuardTokenAssociated(guardToken);
    }

    // ──────────────────────────────────────────────
    //  Deposits & Withdrawals
    // ──────────────────────────────────────────────

    /// @notice Deposits GUARD into this vault. Anyone can deposit — DAOs, bug bounty
    ///         platforms, and competing protocols can all fund audits for contracts they
    ///         depend on.
    /// @dev [Frontend] Emits Deposited event for the live deposit activity feed.
    ///      [Agent Systems] Balance changes influence agent bidding priorities via
    ///      VaultFactory.getVaultsByPriority().
    ///      Auto-funds the critical bounty pool if under allocation.
    ///      Triggers auto-audit if balance doubles since last audit.
    /// @param amount GUARD amount in smallest units.
    function deposit(uint256 amount) external nonReentrant {
        require(initialized, "AuditVault: not initialized");
        require(amount > 0, "AuditVault: amount is zero");

        _transferGuard(msg.sender, address(this), amount);

        // Track depositor — notify factory on first deposit for index
        if (!_isDepositor[msg.sender]) {
            _isDepositor[msg.sender] = true;
            depositors.push(msg.sender);
            IVaultFactory(factory).registerDepositor(msg.sender, address(this));
        }

        depositorBalances[msg.sender] += amount;
        totalDeposited += amount;
        currentBalance += amount;

        // Auto-fund critical bounty pool if under allocation
        if (criticalBountyPool < config.criticalBountyAllocation) {
            uint256 gap = config.criticalBountyAllocation - criticalBountyPool;
            uint256 toBounty = amount < gap ? amount : gap;
            criticalBountyPool += toBounty;
        }

        // Auto-audit trigger: balance doubled since last audit
        if (
            !auditTriggerPending &&
            balanceAtLastAudit > 0 &&
            currentBalance >= balanceAtLastAudit * 2
        ) {
            auditTriggerPending = true;
            emit AutoAuditTriggered("balance_threshold_crossed");
            IVaultFactory(factory).onAutoAuditTriggered(contractAddress, "balance_threshold_crossed");
        }

        emit Deposited(msg.sender, amount, currentBalance);
    }

    /// @notice Withdraws a depositor's proportional share of available funds.
    /// @dev Cannot withdraw funds locked in escrow by active auctions.
    /// @param amount GUARD amount to withdraw.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "AuditVault: amount is zero");
        require(depositorBalances[msg.sender] >= amount, "AuditVault: exceeds depositor balance");
        require(
            currentBalance - reservedForEscrow >= amount,
            "AuditVault: insufficient available balance"
        );

        depositorBalances[msg.sender] -= amount;
        currentBalance -= amount;

        _transferGuard(address(this), msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Escrow — Audit Job Funding
    // ──────────────────────────────────────────────

    /// @notice Reserves funds for an active audit auction job.
    /// @dev [Agent Systems] AuditAuction calls this when creating a job that draws budget
    ///      from this vault. Reservations are NOT transfers — funds remain in the vault
    ///      but cannot be withdrawn until released or drawn.
    /// @param amount GUARD to reserve.
    /// @return success True if the reservation succeeded.
    function reserveForAuction(uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
        returns (bool success)
    {
        require(amount > 0, "AuditVault: amount is zero");
        if (config.maxSingleAuditBudget > 0) {
            require(
                amount <= config.maxSingleAuditBudget,
                "AuditVault: exceeds max single audit budget"
            );
        }
        require(
            currentBalance - reservedForEscrow >= amount,
            "AuditVault: insufficient available balance"
        );

        reservedForEscrow += amount;

        emit BudgetReserved(amount, reservedForEscrow);
        return true;
    }

    /// @notice Draws payment from reserved escrow to an agent.
    /// @dev [Agent Systems] PaymentSettlement or AuditAuction calls after audit completion.
    ///      Only reserved (escrowed) funds can be drawn — prevents unauthorized drains.
    /// @param recipient Agent wallet to receive payment.
    /// @param amount GUARD to transfer.
    function drawPayment(address recipient, uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
    {
        require(recipient != address(0), "AuditVault: recipient is zero");
        require(amount > 0, "AuditVault: amount is zero");
        require(reservedForEscrow >= amount, "AuditVault: exceeds reserved escrow");

        reservedForEscrow -= amount;
        currentBalance -= amount;

        _transferGuard(address(this), recipient, amount);

        emit PaymentDrawn(recipient, amount);
    }

    /// @notice Releases a reservation when an audit job is cancelled.
    /// @dev [Agent Systems] AuditAuction calls when an auction is cancelled, returning
    ///      reserved funds to the available balance.
    /// @param amount GUARD to unreserve.
    function releaseReservation(uint256 amount) external onlyAuthorizedDrawer nonReentrant {
        require(amount > 0, "AuditVault: amount is zero");
        require(reservedForEscrow >= amount, "AuditVault: exceeds reserved escrow");

        reservedForEscrow -= amount;

        emit ReservationReleased(amount);
    }

    // ──────────────────────────────────────────────
    //  Bounty Pool
    // ──────────────────────────────────────────────

    /// @notice Draws a critical vulnerability bounty payment from the bounty pool.
    /// @dev [Agent Systems] Authorized drawers pay agents who discover critical
    ///      vulnerabilities. The bounty pool is earmarked from deposits up to
    ///      config.criticalBountyAllocation.
    /// @param recipient Agent wallet to receive the bounty.
    /// @param amount GUARD to transfer.
    function drawBounty(address recipient, uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
    {
        require(recipient != address(0), "AuditVault: recipient is zero");
        require(amount > 0, "AuditVault: amount is zero");
        require(
            criticalBountySpent + amount <= criticalBountyPool,
            "AuditVault: bounty pool insufficient"
        );
        require(currentBalance >= amount, "AuditVault: insufficient balance");

        criticalBountySpent += amount;
        currentBalance -= amount;

        _transferGuard(address(this), recipient, amount);

        emit BountyPaid(recipient, amount);
    }

    // ──────────────────────────────────────────────
    //  Monitoring Subscriptions
    // ──────────────────────────────────────────────

    /// @notice Applies to become the vault's monitoring agent. Only registered active agents
    ///         at SPECIALIZED tier or above can apply. If a current monitor exists and is
    ///         active, the applicant must offer a strictly lower rate (competitive bidding).
    /// @dev [Agent Systems] Monitoring agents call this directly — fully autonomous
    ///      marketplace. Implements the spec's "A Monitoring Agent places a standing bid:
    ///      'I'll monitor this contract 24/7 for 5 GUARD/week.' The contract's budget
    ///      accepts this bid autonomously."
    /// @param weeklyRate GUARD per week the agent charges for continuous monitoring.
    function applyForMonitoring(uint256 weeklyRate) external nonReentrant {
        require(initialized, "AuditVault: not initialized");
        require(config.acceptsMonitoringBids, "AuditVault: monitoring bids not accepted");
        require(
            weeklyRate <= config.weeklyMonitoringBudget,
            "AuditVault: rate exceeds weekly budget"
        );

        // Verify agent is registered, active, and SPECIALIZED+
        IAgentRegistry registry = IAgentRegistry(agentRegistry);
        require(registry.isActiveAgent(msg.sender), "AuditVault: agent not active");
        IAgentRegistry.AgentTier tier = registry.getAgentTier(msg.sender);
        require(
            tier == IAgentRegistry.AgentTier.SPECIALIZED ||
                tier == IAgentRegistry.AgentTier.PREMIUM,
            "AuditVault: agent must be SPECIALIZED or PREMIUM"
        );

        bool hasActive = activeMonitor.active && activeMonitor.agent != address(0);
        bool expired = hasActive &&
            activeMonitor.expiresAt > 0 &&
            block.timestamp > activeMonitor.expiresAt;

        if (hasActive) {
            if (!expired) {
                // Competing bid — must be strictly cheaper
                require(
                    weeklyRate < activeMonitor.weeklyRate,
                    "AuditVault: must bid lower than current monitor"
                );
            }
            // Settle outstanding payment to outgoing monitor
            address oldAgent = activeMonitor.agent;
            _settleMonitoring();
            emit MonitoringAgentChanged(oldAgent, msg.sender, weeklyRate);
        }

        activeMonitor = MonitoringSubscription({
            agent: msg.sender,
            weeklyRate: weeklyRate,
            startedAt: block.timestamp,
            lastPaymentAt: block.timestamp,
            expiresAt: 0,
            active: true
        });

        emit MonitoringApplied(msg.sender, weeklyRate);
    }

    /// @notice Claims accumulated monitoring payment for the active monitoring agent.
    /// @dev [Agent Systems] Monitoring agents call periodically (at least weekly) to
    ///      collect payment. Payment is pro-rated based on elapsed time since last claim,
    ///      capped by the weekly monitoring budget and available vault balance.
    function claimMonitoringPayment() external nonReentrant {
        require(msg.sender == activeMonitor.agent, "AuditVault: caller is not monitor");
        require(activeMonitor.active, "AuditVault: no active subscription");

        _resetWeeklyIfNeeded();

        uint256 elapsed = block.timestamp - activeMonitor.lastPaymentAt;
        uint256 owed = (activeMonitor.weeklyRate * elapsed) / WEEK;

        // Cap at weekly budget remaining
        uint256 weeklyRemaining = config.weeklyMonitoringBudget >= weeklyMonitoringSpent
            ? config.weeklyMonitoringBudget - weeklyMonitoringSpent
            : 0;
        if (owed > weeklyRemaining) owed = weeklyRemaining;

        // Cap at available balance
        uint256 available = currentBalance > reservedForEscrow
            ? currentBalance - reservedForEscrow
            : 0;
        if (owed > available) owed = available;

        require(owed > 0, "AuditVault: nothing to claim");

        weeklyMonitoringSpent += owed;
        currentBalance -= owed;
        activeMonitor.lastPaymentAt = block.timestamp;

        _transferGuard(address(this), msg.sender, owed);

        emit MonitoringPaymentClaimed(msg.sender, owed);
    }

    /// @notice Cancels the active monitoring subscription. Callable by the vault creator
    ///         or the monitoring agent themselves.
    /// @dev Pro-rated payment for work done since last claim is settled before cancellation.
    function cancelMonitoring() external nonReentrant {
        require(
            msg.sender == creator || msg.sender == activeMonitor.agent,
            "AuditVault: not creator or monitor"
        );
        require(activeMonitor.active, "AuditVault: no active subscription");

        address agent = activeMonitor.agent;
        _settleMonitoring();

        activeMonitor.active = false;
        activeMonitor.agent = address(0);

        emit MonitoringCancelled(agent);
    }

    // ──────────────────────────────────────────────
    //  Audit Lifecycle
    // ──────────────────────────────────────────────

    /// @notice Records that an audit has been completed, updating history and security score.
    /// @dev [Agent Systems] PaymentSettlement calls after a job is settled.
    ///      [iNFT] Triggers Contract Health iNFT state update via the AuditRecorded event.
    ///      Resets auditTriggerPending and snapshots the current balance for future
    ///      threshold triggers.
    /// @param securityScore New security score (0-100).
    function recordAuditCompletion(uint256 securityScore) external onlyAuthorizedDrawer {
        require(securityScore <= 100, "AuditVault: score exceeds 100");

        lastAuditTimestamp = block.timestamp;
        totalAuditsCompleted += 1;
        lastSecurityScore = securityScore;
        auditTriggerPending = false;
        balanceAtLastAudit = currentBalance;

        emit AuditRecorded(securityScore, totalAuditsCompleted);
    }

    /// @notice Checks re-audit conditions and triggers if the configured interval has
    ///         elapsed since the last audit. Permissionless — any agent or automation
    ///         service can call this as a public good.
    /// @dev [Agent Systems] Scanner Agent calls this periodically. Implements the spec's
    ///      "auto-trigger new auctions when certain thresholds are met".
    ///      Can also be automated via Hedera scheduled transactions.
    function checkAndTriggerReaudit() external {
        require(config.reauditIntervalSeconds > 0, "AuditVault: manual reaudit only");
        require(lastAuditTimestamp > 0, "AuditVault: no audit completed yet");
        require(!auditTriggerPending, "AuditVault: trigger already pending");
        require(
            block.timestamp > lastAuditTimestamp + config.reauditIntervalSeconds,
            "AuditVault: reaudit interval not elapsed"
        );

        auditTriggerPending = true;

        emit AutoAuditTriggered("reaudit_interval_elapsed");
        IVaultFactory(factory).onAutoAuditTriggered(contractAddress, "reaudit_interval_elapsed");
    }

    // ──────────────────────────────────────────────
    //  Configuration
    // ──────────────────────────────────────────────

    /// @notice Updates the vault's configuration rules.
    /// @dev Only callable by the vault creator. Allows changing monitoring budget, bounty
    ///      allocation, reaudit interval, and other policy parameters.
    ///      Cannot reduce criticalBountyAllocation below what has already been spent.
    /// @param newConfig New configuration to apply.
    function updateConfig(VaultConfig calldata newConfig) external onlyCreator {
        require(
            newConfig.criticalBountyAllocation >= criticalBountySpent,
            "AuditVault: new allocation below spent"
        );
        config = newConfig;
        emit ConfigUpdated();
    }

    /// @notice Updates the authorized drawer mapping. Only callable by the factory
    ///         (e.g., when AuditAuction or PaymentSettlement contracts are upgraded).
    /// @param drawer Address to update.
    /// @param authorized Whether the address should be authorized.
    function setAuthorizedDrawer(address drawer, bool authorized) external {
        require(msg.sender == factory, "AuditVault: caller is not factory");
        authorizedDrawers[drawer] = authorized;
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    /// @notice Returns the vault's current total GUARD balance.
    /// @return balance Current balance including reserved and bounty-earmarked funds.
    function getBalance() external view returns (uint256 balance) {
        return currentBalance;
    }

    /// @notice Returns GUARD available for new reservations or withdrawals.
    /// @dev [Frontend] Shows "available balance" on the vault detail card.
    /// @return available Balance minus escrow reservations.
    function getAvailableBalance() external view returns (uint256 available) {
        return currentBalance > reservedForEscrow ? currentBalance - reservedForEscrow : 0;
    }

    /// @notice Returns a specific depositor's contribution balance.
    /// @param depositor Depositor address.
    /// @return balance Depositor's remaining contribution.
    function getDepositorBalance(address depositor) external view returns (uint256 balance) {
        return depositorBalances[depositor];
    }

    /// @notice Returns the current monitoring subscription details.
    /// @dev [Agent Systems] Agents query this to check if a monitoring slot is open.
    /// @return subscription Active monitoring subscription state.
    function getMonitoringInfo() external view returns (MonitoringSubscription memory subscription) {
        return activeMonitor;
    }

    /// @notice Returns audit history summary.
    /// @dev [iNFT] Used by Contract Health iNFTs to display audit status.
    /// @return lastAudit Timestamp of last completed audit.
    /// @return totalAudits Total number of completed audits.
    /// @return securityScore Most recent security score (0-100).
    function getAuditHistory()
        external
        view
        returns (uint256 lastAudit, uint256 totalAudits, uint256 securityScore)
    {
        return (lastAuditTimestamp, totalAuditsCompleted, lastSecurityScore);
    }

    /// @notice Returns whether a re-audit is due based on the configured interval.
    /// @dev [Agent Systems] Scanner Agent uses this in periodic sweeps.
    ///      Returns false if reauditIntervalSeconds is 0 (manual only) or no audit
    ///      has been completed yet.
    /// @return due True if the reaudit interval has elapsed since the last audit.
    function isReauditDue() public view returns (bool due) {
        if (config.reauditIntervalSeconds == 0) return false;
        if (lastAuditTimestamp == 0) return false;
        return block.timestamp > lastAuditTimestamp + config.reauditIntervalSeconds;
    }

    /// @notice Returns the list of all depositor addresses.
    /// @return allDepositors Array of unique depositor addresses.
    function getDepositors() external view returns (address[] memory allDepositors) {
        return depositors;
    }

    /// @notice Returns a comprehensive vault summary in a single call.
    /// @dev [Frontend] Populates the vault detail card on the dashboard — single RPC call
    ///      instead of multiple getter calls.
    /// @return _contractAddress The covered contract address.
    /// @return balance Current total GUARD balance.
    /// @return reserved GUARD locked in escrow.
    /// @return bountyRemaining Remaining critical bounty pool funds.
    /// @return lastAudit Timestamp of the last completed audit.
    /// @return securityScore Most recent security score (0-100).
    /// @return monitoringActive Whether a monitoring agent is currently active.
    /// @return reauditDue Whether a re-audit is due.
    function getVaultSummary()
        external
        view
        returns (
            address _contractAddress,
            uint256 balance,
            uint256 reserved,
            uint256 bountyRemaining,
            uint256 lastAudit,
            uint256 securityScore,
            bool monitoringActive,
            bool reauditDue
        )
    {
        uint256 bountyRem = criticalBountyPool > criticalBountySpent
            ? criticalBountyPool - criticalBountySpent
            : 0;

        return (
            contractAddress,
            currentBalance,
            reservedForEscrow,
            bountyRem,
            lastAuditTimestamp,
            lastSecurityScore,
            activeMonitor.active && activeMonitor.agent != address(0),
            isReauditDue()
        );
    }

    // ──────────────────────────────────────────────
    //  Internal Helpers
    // ──────────────────────────────────────────────

    /// @dev Settles outstanding monitoring payment to the active monitor.
    ///      Used when replacing a monitor or cancelling a subscription.
    function _settleMonitoring() internal {
        if (!activeMonitor.active || activeMonitor.agent == address(0)) return;

        _resetWeeklyIfNeeded();

        uint256 elapsed = block.timestamp - activeMonitor.lastPaymentAt;
        uint256 owed = (activeMonitor.weeklyRate * elapsed) / WEEK;

        uint256 weeklyRemaining = config.weeklyMonitoringBudget >= weeklyMonitoringSpent
            ? config.weeklyMonitoringBudget - weeklyMonitoringSpent
            : 0;
        if (owed > weeklyRemaining) owed = weeklyRemaining;

        uint256 available = currentBalance > reservedForEscrow
            ? currentBalance - reservedForEscrow
            : 0;
        if (owed > available) owed = available;

        if (owed > 0) {
            weeklyMonitoringSpent += owed;
            currentBalance -= owed;
            activeMonitor.lastPaymentAt = block.timestamp;
            _transferGuard(address(this), activeMonitor.agent, owed);
            emit MonitoringPaymentClaimed(activeMonitor.agent, owed);
        }
    }

    /// @dev Resets weekly monitoring accounting if the window has elapsed.
    function _resetWeeklyIfNeeded() internal {
        if (block.timestamp >= weeklyResetTimestamp + WEEK) {
            weeklyMonitoringSpent = 0;
            weeklyResetTimestamp = block.timestamp;
        }
    }

    /// @dev Transfers GUARD via HTS precompile with int64 safety check.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "AuditVault: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "AuditVault: HTS transfer failed");
    }
}
