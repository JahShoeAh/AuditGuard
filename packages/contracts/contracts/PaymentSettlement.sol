// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IAuditAuction} from "./interfaces/IAuditAuction.sol";
import {ISubAuction} from "./interfaces/ISubAuction.sol";

/// @title PaymentSettlement — Atomic multi-party batch settlement for AuditGuard
/// @author AuditGuard Team
/// @notice Executes atomic payment batches via HTS so that an entire audit job's payouts
///         (main agents, sub-contractors, data sellers, platform fees, bonuses) settle in a
///         single transaction. The Orchestrator builds the settlement manifest and calls
///         settleJob(); this contract is agent-agnostic.
/// @dev All settlements are atomic via HTS, logged to HCS (off-chain), and trigger automatic
///      iNFT state updates via the JobSettled event.
///
///      Integration points consumed by teammates:
///      - [Agent Systems] Orchestrator builds manifest, pre-funds contract, calls settleJob()
///      - [iNFT] Consumes JobSettled to transition job → COMPLETED, update agent/contract iNFTs
///      - [Frontend] Consumes JobSettled to populate settlement feed; calls view functions for
///        breakdown tables and pending previews
contract PaymentSettlement is Ownable, ReentrancyGuard, Pausable {
    // ─────────────────────────────────────────────────────────────────────
    // HTS precompile
    // ─────────────────────────────────────────────────────────────────────

    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    // ─────────────────────────────────────────────────────────────────────
    // Enums
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Categorizes each line-item in a settlement for dashboard display and iNFT tagging.
    enum PaymentType {
        MAIN_AUDIT,
        SUB_CONTRACT,
        DATA_PURCHASE,
        BONUS_SPEED,
        BONUS_UNIQUE_FINDING,
        MONITORING_PAYMENT,
        REPORT_FEE,
        PLATFORM_FEE,
        BOUNTY_PAYOUT,
        REFUND
    }

    // ─────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────

    /// @notice A single line-item in a settlement manifest.
    /// @dev The Orchestrator populates these based on agent findings, bonuses, and sub-contract
    ///      completions. reportFee is deducted from the agent's payout, not added on top.
    struct PaymentItem {
        address recipient;
        uint256 basePayment;
        uint256 bonus;
        uint256 reportFee;
        PaymentType paymentType;
        string description;
    }

    /// @notice Full manifest describing every payout for a completed audit job.
    /// @dev Built off-chain by the Orchestrator, passed to settleJob() as calldata.
    struct SettlementManifest {
        uint256 jobId;
        address reportAgent;
        PaymentItem[] payments;
        uint256 totalPayout;
        uint256 totalReportFees;
        uint256 platformFee;
        uint256 timestamp;
    }

    /// @notice On-chain record created after a successful settlement execution.
    struct SettlementRecord {
        uint256 settlementId;
        uint256 jobId;
        uint256 totalDisbursed;
        uint256 platformFeeCollected;
        uint256 reportFeesCollected;
        uint256 recipientCount;
        uint256 settledAt;
        bool successful;
    }

    // ─────────────────────────────────────────────────────────────────────
    // State variables
    // ─────────────────────────────────────────────────────────────────────

    /// @notice GUARD token address on Hedera.
    address public guardToken;

    /// @notice AgentRegistry contract for reputation lookups and job completion recording.
    address public agentRegistry;

    /// @notice AuditAuction contract — called to mark jobs COMPLETED after settlement.
    address public mainAuction;

    /// @notice SubAuction contract — read for sub-job settlement logging.
    address public subAuction;

    /// @notice AuditBudgetVault — optional future integration for cross-contract draws.
    address public budgetVault;

    /// @notice Platform treasury that receives the 5% platform fee.
    address public treasury;

    /// @notice Orchestrator EOA — sole caller of settleJob and fund management functions.
    address public orchestrator;

    /// @notice Platform fee percentage applied to totalPayout (default 5, max 20).
    uint256 public platformFeePercent = 5;

    /// @notice Base report-inclusion fee charged to each agent (0.1 GUARD, 8 decimals).
    uint256 public reportFeeBase = 1 * 10 ** 7;

    /// @notice Reputation threshold (basis points) at or above which agents get the discounted
    ///         report fee. Default 8500 = 85.00 reputation.
    uint256 public reportFeeDiscountThreshold = 8500;

    /// @notice Discounted report fee for high-reputation agents (0.05 GUARD, 8 decimals).
    uint256 public reportFeeDiscounted = 5 * 10 ** 6;

    /// @notice Auto-incrementing settlement id, starts at 1.
    uint256 public nextSettlementId = 1;

    /// @notice settlementId → SettlementRecord.
    mapping(uint256 => SettlementRecord) public settlements;

    /// @notice jobId → settlementId (0 means not yet settled).
    mapping(uint256 => uint256) public jobToSettlement;

    /// @notice settlementId → payment breakdown array.
    mapping(uint256 => PaymentItem[]) internal _settlementPayments;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Emitted after a full audit job is atomically settled.
    /// @dev THE key event consumed by all teammates:
    ///      [Agent Systems] triggers post-settlement agent behaviors
    ///      [iNFT] triggers job iNFT → COMPLETED, updates agent iNFTs, updates contract health iNFT
    ///      [Frontend] populates the settlement feed on the dashboard
    event JobSettled(
        uint256 indexed settlementId,
        uint256 indexed jobId,
        uint256 totalDisbursed,
        uint256 platformFee,
        uint256 reportFees,
        uint256 recipientCount
    );

    /// @notice Emitted when a sub-job completion is logged into the unified settlement ledger.
    /// @dev [iNFT] Updates sub-contract lineage on the parent job iNFT.
    ///      [Frontend] Shows sub-contract settlement in the job breakdown view.
    event SubJobSettled(
        uint256 indexed settlementId,
        uint256 indexed subJobId,
        address indexed agent,
        uint256 amount
    );

    /// @notice Emitted when the Orchestrator deposits GUARD to fund upcoming settlements.
    /// @dev [Frontend] Updates the "pending settlement funds" indicator on the dashboard.
    event FundsDeposited(address indexed from, uint256 amount);

    /// @notice Emitted when excess funds are withdrawn back to the Orchestrator.
    /// @dev [Frontend] Updates the contract balance display.
    event FundsWithdrawn(address indexed to, uint256 amount);

    // ─────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────

    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "PaymentSettlement: caller is not orchestrator");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Deploys the PaymentSettlement contract.
    /// @param _guardToken GUARD token address on Hedera.
    /// @param _agentRegistry AgentRegistry contract address.
    /// @param _mainAuction AuditAuction contract address.
    /// @param _subAuction SubAuction contract address.
    /// @param _treasury Platform treasury address for fee collection.
    /// @param _orchestrator Orchestrator EOA that calls settleJob.
    constructor(
        address _guardToken,
        address _agentRegistry,
        address _mainAuction,
        address _subAuction,
        address _treasury,
        address _orchestrator
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "PaymentSettlement: guard token is zero");
        require(_agentRegistry != address(0), "PaymentSettlement: agent registry is zero");
        require(_mainAuction != address(0), "PaymentSettlement: main auction is zero");
        require(_subAuction != address(0), "PaymentSettlement: sub auction is zero");
        require(_treasury != address(0), "PaymentSettlement: treasury is zero");
        require(_orchestrator != address(0), "PaymentSettlement: orchestrator is zero");

        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        mainAuction = _mainAuction;
        subAuction = _subAuction;
        treasury = _treasury;
        orchestrator = _orchestrator;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Core — settleJob
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Atomically settles all payouts for a completed audit job.
    /// @dev Called by the Orchestrator after pre-funding this contract with GUARD from the vault.
    ///      Executes all agent payments, bonuses, report fees, and the platform fee in one
    ///      transaction. Reverts entirely if any individual transfer fails (atomic guarantee).
    ///
    ///      Flow:
    ///      1. Validates job state (AUDITING_IN_PROGRESS or REPORT_PENDING, not already settled)
    ///      2. Validates each recipient is a registered agent (or treasury)
    ///      3. Calculates report fee per agent based on reputation discount eligibility
    ///      4. Transfers net payment (base + bonus - reportFee) to each recipient
    ///      5. Transfers aggregated report fees to the reportAgent
    ///      6. Transfers platform fee to treasury
    ///      7. Records settlement on-chain
    ///      8. Marks job COMPLETED in AuditAuction
    ///      9. Records job completion in AgentRegistry for each agent recipient
    ///
    /// @param jobId The AuditAuction job id being settled.
    /// @param payments Array of PaymentItem line-items (agent payouts, bonuses, sub-contracts).
    /// @param reportAgent Address of the Report Agent that aggregated findings.
    ///
    /// [Agent Systems] Orchestrator calls this after building the settlement manifest.
    /// [iNFT] Consumes the emitted JobSettled event to update all linked iNFTs.
    /// [Frontend] Consumes JobSettled to render the settlement breakdown on the dashboard.
    function settleJob(
        uint256 jobId,
        PaymentItem[] calldata payments,
        address reportAgent
    ) external onlyOrchestrator nonReentrant whenNotPaused {
        // ── Validate job state ──────────────────────────────────────────
        _validateJobForSettlement(jobId);
        require(payments.length > 0, "PaymentSettlement: empty payment list");
        require(reportAgent != address(0), "PaymentSettlement: report agent is zero");

        // ── Calculate totals and per-agent report fees ──────────────────
        (
            uint256[] memory reportFees,
            uint256 totalPayout,
            uint256 totalReportFees,
            uint256 calcPlatformFee
        ) = _calculateSettlement(payments);

        // ── Execute atomic transfers ────────────────────────────────────
        _executeTransfers(payments, reportFees, reportAgent, totalReportFees, calcPlatformFee);

        // ── Record settlement on-chain ──────────────────────────────────
        uint256 settlementId = _recordSettlement(
            jobId, payments, reportFees, totalPayout, totalReportFees, calcPlatformFee
        );

        // ── Post-settlement side effects ────────────────────────────────

        // Mark job COMPLETED in AuditAuction
        IAuditAuction(mainAuction).completeJob(jobId);

        // Note: The Orchestrator calls AgentRegistry.recordJobCompletion()
        // separately with accurate finding counts. This avoids parsing
        // description strings on-chain.

        emit JobSettled(
            settlementId,
            jobId,
            totalPayout + calcPlatformFee,
            calcPlatformFee,
            totalReportFees,
            payments.length
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Core — settleSubJob
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Logs a completed sub-job into the unified settlement ledger.
    /// @dev The SubAuction contract handles its own payment transfers. This function only
    ///      creates a SettlementRecord for unified tracking so that the Frontend and iNFT
    ///      teammates have a single source of truth for all settlements.
    /// @param subJobId The SubAuction sub-job id to log.
    ///
    /// [iNFT] Consumes SubJobSettled to update sub-contract lineage on parent job iNFT.
    /// [Frontend] Shows sub-contract settlement in the unified settlement feed.
    function settleSubJob(uint256 subJobId) external onlyOrchestrator whenNotPaused {
        ISubAuction sub = ISubAuction(subAuction);
        ISubAuction.SubJob memory subJob = sub.getSubJob(subJobId);

        require(
            subJob.status == ISubAuction.SubJobStatus.ACCEPTED,
            "PaymentSettlement: sub-job not accepted"
        );
        require(subJob.selectedAgent != address(0), "PaymentSettlement: no selected agent");

        uint256 settlementId = nextSettlementId++;

        settlements[settlementId] = SettlementRecord({
            settlementId: settlementId,
            jobId: subJob.parentJobId,
            totalDisbursed: subJob.paymentAmount,
            platformFeeCollected: 0,
            reportFeesCollected: 0,
            recipientCount: 1,
            settledAt: block.timestamp,
            successful: true
        });

        _settlementPayments[settlementId].push(
            PaymentItem({
                recipient: subJob.selectedAgent,
                basePayment: subJob.paymentAmount,
                bonus: 0,
                reportFee: 0,
                paymentType: PaymentType.SUB_CONTRACT,
                description: subJob.taskDescription
            })
        );

        emit SubJobSettled(settlementId, subJobId, subJob.selectedAgent, subJob.paymentAmount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Core — Fund management
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Deposits GUARD into this contract to fund upcoming settlements.
    /// @dev Called by the Orchestrator after drawing from AuditBudgetVault. Transfers GUARD
    ///      from msg.sender to this contract via HTS.
    /// @param amount Amount of GUARD to deposit (8 decimals).
    ///
    /// [Frontend] Updates the "pending settlement funds" balance on the dashboard.
    function depositSettlementFunds(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "PaymentSettlement: zero deposit");
        _transferGuard(msg.sender, address(this), amount);
        emit FundsDeposited(msg.sender, amount);
    }

    /// @notice Withdraws unused GUARD back to the Orchestrator.
    /// @dev Safety valve for recovering excess funds after settlements or in case of
    ///      manifest recalculation.
    /// @param amount Amount of GUARD to withdraw (8 decimals).
    ///
    /// [Frontend] Updates the contract balance display.
    function withdrawExcess(uint256 amount) external onlyOrchestrator nonReentrant whenNotPaused {
        require(amount > 0, "PaymentSettlement: zero withdrawal");
        _transferGuard(address(this), orchestrator, amount);
        emit FundsWithdrawn(orchestrator, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Preview / Simulation
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Previews the full settlement breakdown without executing transfers.
    /// @dev Called by the Orchestrator to validate the manifest before committing, and by the
    ///      Frontend to render the "pending settlement" preview on the dashboard.
    /// @param jobId The AuditAuction job id (used for validation only).
    /// @param payments Array of PaymentItem line-items to simulate.
    /// @param reportAgent Address of the Report Agent (unused in preview but kept for signature parity).
    /// @return totalPayout Sum of all basePayment + bonus across all items.
    /// @return platformFee Calculated platform fee (platformFeePercent% of totalPayout).
    /// @return totalReportFees Sum of calculated report fees (reputation-adjusted).
    /// @return totalDisbursed Total GUARD that will leave this contract (totalPayout + platformFee).
    ///
    /// [Agent Systems] Orchestrator calls this to validate manifest before settleJob().
    /// [Frontend] Calls this to show "pending settlement" breakdown before execution.
    function calculateSettlementPreview(
        uint256 jobId,
        PaymentItem[] calldata payments,
        address reportAgent
    )
        external
        view
        returns (
            uint256 totalPayout,
            uint256 platformFee,
            uint256 totalReportFees,
            uint256 totalDisbursed
        )
    {
        // Suppress unused variable warnings — kept for call-signature parity with settleJob
        jobId;
        reportAgent;

        IAgentRegistry registry = IAgentRegistry(agentRegistry);

        uint256 totalBase;
        uint256 totalBonus;

        for (uint256 i = 0; i < payments.length; i++) {
            totalBase += payments[i].basePayment;
            totalBonus += payments[i].bonus;

            uint256 agentReputation = registry.getAgentReputation(payments[i].recipient);
            uint256 fee;
            if (agentReputation >= reportFeeDiscountThreshold) {
                fee = reportFeeDiscounted;
            } else {
                fee = reportFeeBase;
            }

            if (
                payments[i].paymentType == PaymentType.MAIN_AUDIT
                    || payments[i].paymentType == PaymentType.SUB_CONTRACT
                    || payments[i].paymentType == PaymentType.MONITORING_PAYMENT
                    || payments[i].paymentType == PaymentType.BOUNTY_PAYOUT
            ) {
                totalReportFees += fee;
            }
        }

        totalPayout = totalBase + totalBonus;
        platformFee = (totalPayout * platformFeePercent) / 100;
        totalDisbursed = totalPayout + platformFee;
    }

    // ─────────────────────────────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Returns the full SettlementRecord for a given settlement id.
    /// @param settlementId The settlement id to look up.
    /// @return record The on-chain settlement record.
    ///
    /// [Frontend] Used to render settlement detail pages.
    function getSettlement(uint256 settlementId) external view returns (SettlementRecord memory record) {
        record = settlements[settlementId];
        require(record.settlementId != 0, "PaymentSettlement: settlement not found");
    }

    /// @notice Returns the full payment breakdown for a settlement.
    /// @param settlementId The settlement id to look up.
    /// @return payments Array of PaymentItem line-items that were disbursed.
    ///
    /// [Frontend] Renders the settlement breakdown table showing each agent's payout,
    ///           bonuses, and fee deductions.
    function getSettlementPayments(uint256 settlementId)
        external
        view
        returns (PaymentItem[] memory payments)
    {
        require(settlements[settlementId].settlementId != 0, "PaymentSettlement: settlement not found");
        return _settlementPayments[settlementId];
    }

    /// @notice Returns the settlement id for a given job, or 0 if not yet settled.
    /// @param jobId The AuditAuction job id.
    /// @return settlementId The linked settlement id (0 = unsettled).
    ///
    /// [iNFT] Checks whether a job has been settled before transitioning iNFT state.
    function getSettlementForJob(uint256 jobId) external view returns (uint256 settlementId) {
        return jobToSettlement[jobId];
    }

    /// @notice Returns whether a job has been settled.
    /// @param jobId The AuditAuction job id.
    /// @return settled True if a SettlementRecord exists for this job.
    ///
    /// [Agent Systems] Guards against duplicate settlement attempts.
    /// [Frontend] Controls UI state (settled vs pending).
    function isJobSettled(uint256 jobId) external view returns (bool settled) {
        return jobToSettlement[jobId] != 0;
    }

    /// @notice Returns the GUARD balance held by this contract for pending settlements.
    /// @return balance Current GUARD balance (8 decimals).
    ///
    /// [Frontend] Displays "funds available for settlement" on the Payment Agent dashboard.
    function getContractBalance() external pure returns (uint256 balance) {
        // Query HTS for the token balance held by this contract.
        // On Hedera, direct balance queries go through the mirror node; on-chain we track
        // via transfer deltas. For simplicity, we expose this as a view that the Frontend
        // can cross-reference with mirror node data.
        // Note: Solidity cannot directly query HTS balances on-chain without an additional
        // precompile. The Frontend should use the Hedera mirror node REST API for accurate
        // real-time balances. This function is a placeholder for future HTS balance precompile
        // integration.
        return 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin functions
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Updates the Orchestrator address.
    /// @param _orchestrator New Orchestrator EOA address.
    function setOrchestrator(address _orchestrator) external onlyOwner {
        require(_orchestrator != address(0), "PaymentSettlement: zero address");
        orchestrator = _orchestrator;
    }

    /// @notice Updates the platform treasury address.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "PaymentSettlement: zero address");
        treasury = _treasury;
    }

    /// @notice Updates the AuditAuction contract reference.
    /// @param _mainAuction New AuditAuction contract address.
    function setMainAuction(address _mainAuction) external onlyOwner {
        require(_mainAuction != address(0), "PaymentSettlement: zero address");
        mainAuction = _mainAuction;
    }

    /// @notice Updates the SubAuction contract reference.
    /// @param _subAuction New SubAuction contract address.
    function setSubAuction(address _subAuction) external onlyOwner {
        require(_subAuction != address(0), "PaymentSettlement: zero address");
        subAuction = _subAuction;
    }

    /// @notice Updates the AuditBudgetVault reference for future cross-contract draw integration.
    /// @param _budgetVault New AuditBudgetVault contract address.
    function setBudgetVault(address _budgetVault) external onlyOwner {
        require(_budgetVault != address(0), "PaymentSettlement: zero address");
        budgetVault = _budgetVault;
    }

    /// @notice Updates the AgentRegistry contract reference.
    /// @param _agentRegistry New AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        require(_agentRegistry != address(0), "PaymentSettlement: zero address");
        agentRegistry = _agentRegistry;
    }

    /// @notice Updates the platform fee percentage.
    /// @param _platformFeePercent New fee percentage (0–20).
    function setPlatformFeePercent(uint256 _platformFeePercent) external onlyOwner {
        require(_platformFeePercent <= 20, "PaymentSettlement: fee exceeds 20%");
        platformFeePercent = _platformFeePercent;
    }

    /// @notice Updates report fee parameters.
    /// @param _base New base report fee (8 decimals).
    /// @param _discounted New discounted report fee for high-rep agents (8 decimals).
    /// @param _threshold New reputation threshold for discount eligibility (basis points).
    function setReportFees(uint256 _base, uint256 _discounted, uint256 _threshold) external onlyOwner {
        require(_discounted <= _base, "PaymentSettlement: discounted exceeds base");
        require(_threshold <= 10000, "PaymentSettlement: threshold exceeds max reputation");
        reportFeeBase = _base;
        reportFeeDiscounted = _discounted;
        reportFeeDiscountThreshold = _threshold;
    }

    /// @notice Associates this contract with GUARD token through HTS precompile.
    /// @dev No access restriction — idempotent, costs only a small HBAR fee.
    ///      Must be called via Hedera SDK (ContractExecuteTransaction) post-deployment.
    function associateGuardToken() external {
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "PaymentSettlement: token association failed"
        );
    }

    /// @notice Pauses all settlement operations. Emergency stop.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes settlement operations after emergency pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Validates that a job is eligible for settlement.
    function _validateJobForSettlement(uint256 jobId) internal view {
        IAuditAuction.JobStatus status = IAuditAuction(mainAuction).getJobStatus(jobId);
        require(
            status == IAuditAuction.JobStatus.AUDITING_IN_PROGRESS
                || status == IAuditAuction.JobStatus.REPORT_PENDING,
            "PaymentSettlement: invalid job status"
        );
        require(jobToSettlement[jobId] == 0, "PaymentSettlement: job already settled");
    }

    /// @dev Validates recipients and calculates report fees, totals, and platform fee.
    /// @return reportFees Per-payment calculated report fees.
    /// @return totalPayout Sum of all basePayment + bonus.
    /// @return totalReportFees Sum of all calculated report fees.
    /// @return calcPlatformFee Platform fee derived from totalPayout.
    function _calculateSettlement(PaymentItem[] calldata payments)
        internal
        view
        returns (
            uint256[] memory reportFees,
            uint256 totalPayout,
            uint256 totalReportFees,
            uint256 calcPlatformFee
        )
    {
        IAgentRegistry registry = IAgentRegistry(agentRegistry);
        reportFees = new uint256[](payments.length);

        uint256 totalBase;
        uint256 totalBonus;

        for (uint256 i = 0; i < payments.length; i++) {
            require(payments[i].recipient != address(0), "PaymentSettlement: zero recipient");
            require(
                payments[i].recipient == treasury || registry.isActiveAgent(payments[i].recipient),
                "PaymentSettlement: recipient not registered"
            );

            totalBase += payments[i].basePayment;
            totalBonus += payments[i].bonus;

            // Calculate report fee based on agent reputation
            if (_isReportFeeEligible(payments[i].paymentType)) {
                uint256 rep = registry.getAgentReputation(payments[i].recipient);
                uint256 fee = rep >= reportFeeDiscountThreshold ? reportFeeDiscounted : reportFeeBase;
                reportFees[i] = fee;
                totalReportFees += fee;
            }
        }

        totalPayout = totalBase + totalBonus;
        calcPlatformFee = (totalPayout * platformFeePercent) / 100;
    }

    /// @dev Returns true if the payment type should incur a report-inclusion fee.
    function _isReportFeeEligible(PaymentType pt) internal pure returns (bool) {
        return pt == PaymentType.MAIN_AUDIT || pt == PaymentType.SUB_CONTRACT
            || pt == PaymentType.MONITORING_PAYMENT || pt == PaymentType.BOUNTY_PAYOUT;
    }

    /// @dev Executes all HTS transfers for a settlement batch. Reverts entirely if any
    ///      single transfer fails (atomic guarantee).
    function _executeTransfers(
        PaymentItem[] calldata payments,
        uint256[] memory reportFees,
        address reportAgent,
        uint256 totalReportFees,
        uint256 calcPlatformFee
    ) internal {
        // 1. Pay each recipient: netPayment = basePayment + bonus - reportFee
        for (uint256 i = 0; i < payments.length; i++) {
            uint256 netPayment = payments[i].basePayment + payments[i].bonus - reportFees[i];
            if (netPayment > 0) {
                _transferGuard(address(this), payments[i].recipient, netPayment);
            }
        }

        // 2. Transfer aggregated report fees to the Report Agent
        if (totalReportFees > 0) {
            _transferGuard(address(this), reportAgent, totalReportFees);
        }

        // 3. Transfer platform fee to treasury
        if (calcPlatformFee > 0) {
            _transferGuard(address(this), treasury, calcPlatformFee);
        }
    }

    /// @dev Stores the SettlementRecord and PaymentItem[] breakdown on-chain.
    /// @return settlementId The newly assigned settlement id.
    function _recordSettlement(
        uint256 jobId,
        PaymentItem[] calldata payments,
        uint256[] memory reportFees,
        uint256 totalPayout,
        uint256 totalReportFees,
        uint256 calcPlatformFee
    ) internal returns (uint256 settlementId) {
        settlementId = nextSettlementId++;

        settlements[settlementId] = SettlementRecord({
            settlementId: settlementId,
            jobId: jobId,
            totalDisbursed: totalPayout + calcPlatformFee,
            platformFeeCollected: calcPlatformFee,
            reportFeesCollected: totalReportFees,
            recipientCount: payments.length,
            settledAt: block.timestamp,
            successful: true
        });

        // Store the full payment breakdown for on-chain queries
        for (uint256 i = 0; i < payments.length; i++) {
            _settlementPayments[settlementId].push(
                PaymentItem({
                    recipient: payments[i].recipient,
                    basePayment: payments[i].basePayment,
                    bonus: payments[i].bonus,
                    reportFee: reportFees[i],
                    paymentType: payments[i].paymentType,
                    description: payments[i].description
                })
            );
        }

        jobToSettlement[jobId] = settlementId;
    }

    /// @dev Executes a GUARD token transfer via the HTS precompile. Reverts on failure,
    ///      guaranteeing atomic settlement (all-or-nothing).
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "PaymentSettlement: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "PaymentSettlement: HTS transfer failed");
    }
}
