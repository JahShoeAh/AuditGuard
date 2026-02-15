// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @title AuditGuard Audit Auction
/// @notice Manages audit job posting, bid collection, and per-job collateral escrow on Hedera HSCS.
/// @dev Registration/reputation remain in AgentRegistry; this contract only reads those values.
contract AuditAuction is ReentrancyGuard, Pausable {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code constants.
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    /// @notice Minimum per-bid collateral amount (50 GUARD, 8 decimals).
    uint256 public constant MIN_BID_COLLATERAL = 50 * 10 ** 8;

    /// @notice Lifecycle status for an audit job.
    enum JobStatus {
        AUCTION_OPEN,
        BIDDING_CLOSED,
        AUDITING_IN_PROGRESS,
        REPORT_PENDING,
        COMPLETED,
        CANCELLED
    }

    /// @notice Lifecycle status for an agent bid.
    enum BidStatus {
        PENDING,
        ACCEPTED,
        REJECTED,
        REFUNDED
    }

    /// @notice Auction job metadata tracked on-chain.
    struct AuditJob {
        uint256 jobId;
        address contractAddress;
        string contractChain;
        uint256 discoveryTimestamp;
        uint256 auctionDeadline;
        uint256 initialRiskScore;
        uint256 budgetAvailable;
        uint256 lineCount;
        string contractType;
        JobStatus status;
        address[] winningAgents;
        uint256 totalEscrowedAmount;
        uint256 bidCount;
    }

    /// @notice Agent bid payload with escrow and snapshot metadata.
    struct AgentBid {
        address agent;
        uint256 jobId;
        uint256 bidAmount;
        uint256 collateralLocked;
        uint256 reputationAtBid;
        uint256 estimatedCompletionTime;
        string specialization;
        BidStatus status;
        uint256 timestamp;
    }

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AgentRegistry contract address.
    address public agentRegistry;

    /// @notice Off-chain orchestrator signer that can post new jobs.
    address public orchestrator;

    /// @notice Platform treasury address for future fee settlement.
    address public treasury;

    /// @notice Platform fee percent retained by orchestrator flow (5% default).
    uint256 public platformFeePercent = 5;

    /// @notice Auto-incrementing job counter (starts at 1).
    uint256 public nextJobId;

    /// @notice Job storage by id.
    mapping(uint256 => AuditJob) public jobs;

    /// @dev Bid storage by job id.
    mapping(uint256 => AgentBid[]) internal _jobBids;

    /// @notice Tracks whether an agent has already submitted a bid for a job.
    mapping(uint256 => mapping(address => bool)) public hasAgentBid;

    /// @notice Active job id list for simple enumeration.
    uint256[] public activeJobIds;

    /// @notice Emitted when a new job auction is opened.
    event JobPosted(
        uint256 indexed jobId,
        address contractAddress,
        string contractChain,
        string contractType,
        uint256 budgetAvailable,
        uint256 auctionDeadline,
        uint256 initialRiskScore,
        uint256 lineCount
    );

    /// @notice Emitted when an active agent submits a bid and collateral is escrowed.
    event BidSubmitted(
        uint256 indexed jobId,
        address indexed agent,
        uint256 bidAmount,
        uint256 collateralLocked,
        uint256 reputationAtBid,
        string specialization,
        uint256 estimatedCompletionTime
    );

    /// @dev Restricts execution to the configured orchestrator.
    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "AuditAuction: caller is not orchestrator");
        _;
    }

    /// @notice Deploys the auction contract and associates it with GUARD through HTS.
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract address.
    /// @param _orchestrator Authorized orchestrator address.
    /// @param _treasury Treasury address for platform fee routing.
    constructor(
        address _guardToken,
        address _agentRegistry,
        address _orchestrator,
        address _treasury
    ) {
        require(_guardToken != address(0), "AuditAuction: guard token is zero");
        require(_agentRegistry != address(0), "AuditAuction: registry is zero");
        require(_orchestrator != address(0), "AuditAuction: orchestrator is zero");
        require(_treasury != address(0), "AuditAuction: treasury is zero");

        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        orchestrator = _orchestrator;
        treasury = _treasury;
        nextJobId = 1;

        int64 responseCode = HTS.tokenAssociate(address(this), _guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "AuditAuction: token association failed"
        );
    }

    /// @notice Creates a new audit job and opens the auction window.
    /// @dev Called by the orchestrator after scanner discovery is ingested from HCS.
    /// @param contractAddress Smart contract address being audited.
    /// @param contractChain Chain identifier for target contract (hedera, ethereum, etc.).
    /// @param contractType Contract archetype used for auction context.
    /// @param initialRiskScore Scanner-provided risk score (0..100).
    /// @param budgetAvailable GUARD budget allocated for this job.
    /// @param lineCount Estimated lines of code.
    /// @param auctionDurationSeconds Auction duration from now, in seconds.
    /// @return jobId Newly created job id.
    function createAuditJob(
        address contractAddress,
        string calldata contractChain,
        string calldata contractType,
        uint256 initialRiskScore,
        uint256 budgetAvailable,
        uint256 lineCount,
        uint256 auctionDurationSeconds
    ) external onlyOrchestrator whenNotPaused returns (uint256 jobId) {
        require(contractAddress != address(0), "AuditAuction: contract address is zero");
        require(bytes(contractChain).length > 0, "AuditAuction: empty contract chain");
        require(bytes(contractType).length > 0, "AuditAuction: empty contract type");
        require(initialRiskScore <= 100, "AuditAuction: risk score out of range");
        require(budgetAvailable > 0, "AuditAuction: budget is zero");
        require(auctionDurationSeconds > 0, "AuditAuction: duration is zero");

        jobId = nextJobId;
        nextJobId += 1;

        AuditJob storage job = jobs[jobId];
        job.jobId = jobId;
        job.contractAddress = contractAddress;
        job.contractChain = contractChain;
        job.discoveryTimestamp = block.timestamp;
        job.auctionDeadline = block.timestamp + auctionDurationSeconds;
        job.initialRiskScore = initialRiskScore;
        job.budgetAvailable = budgetAvailable;
        job.lineCount = lineCount;
        job.contractType = contractType;
        job.status = JobStatus.AUCTION_OPEN;

        activeJobIds.push(jobId);

        emit JobPosted(
            jobId,
            contractAddress,
            contractChain,
            contractType,
            budgetAvailable,
            job.auctionDeadline,
            initialRiskScore,
            lineCount
        );
    }

    /// @notice Submits a bid and escrows per-job collateral in GUARD.
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function.
    /// @param jobId Target job id.
    /// @param bidAmount Requested GUARD payment.
    /// @param collateralAmount GUARD collateral locked for this bid.
    /// @param estimatedCompletionTime Estimated completion time in seconds.
    /// @param specialization Bid specialization label.
    function submitBid(
        uint256 jobId,
        uint256 bidAmount,
        uint256 collateralAmount,
        uint256 estimatedCompletionTime,
        string calldata specialization
    ) external nonReentrant whenNotPaused {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(job.status == JobStatus.AUCTION_OPEN, "AuditAuction: job not open");
        require(block.timestamp < job.auctionDeadline, "AuditAuction: auction expired");
        require(!hasAgentBid[jobId][msg.sender], "AuditAuction: bid already submitted");
        require(collateralAmount >= MIN_BID_COLLATERAL, "AuditAuction: collateral below minimum");
        require(bidAmount <= job.budgetAvailable, "AuditAuction: bid exceeds budget");
        require(bytes(specialization).length > 0, "AuditAuction: empty specialization");

        IAgentRegistry registry = IAgentRegistry(agentRegistry);
        require(registry.isActiveAgent(msg.sender), "AuditAuction: inactive agent");

        // Read tier for downstream off-chain scoring workflows; no hard gate by tier.
        registry.getAgentTier(msg.sender);
        uint256 reputationAtBid = registry.getAgentReputation(msg.sender);

        _transferGuard(msg.sender, address(this), collateralAmount);

        _jobBids[jobId].push(
            AgentBid({
                agent: msg.sender,
                jobId: jobId,
                bidAmount: bidAmount,
                collateralLocked: collateralAmount,
                reputationAtBid: reputationAtBid,
                estimatedCompletionTime: estimatedCompletionTime,
                specialization: specialization,
                status: BidStatus.PENDING,
                timestamp: block.timestamp
            })
        );

        hasAgentBid[jobId][msg.sender] = true;
        job.bidCount += 1;
        job.totalEscrowedAmount += collateralAmount;

        emit BidSubmitted(
            jobId,
            msg.sender,
            bidAmount,
            collateralAmount,
            reputationAtBid,
            specialization,
            estimatedCompletionTime
        );
    }

    /// @notice Returns a job by id.
    /// @param jobId Job id.
    /// @return job Full job payload.
    function getJob(uint256 jobId) external view returns (AuditJob memory job) {
        job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
    }

    /// @notice Returns all bids for a given job.
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function.
    /// @param jobId Job id.
    /// @return bids Array of bid payloads.
    function getBidsForJob(uint256 jobId) external view returns (AgentBid[] memory bids) {
        require(jobs[jobId].jobId != 0, "AuditAuction: job does not exist");
        return _jobBids[jobId];
    }

    /// @notice Returns the number of bids submitted for a job.
    /// @param jobId Job id.
    /// @return count Bid count.
    function getBidCount(uint256 jobId) external view returns (uint256 count) {
        require(jobs[jobId].jobId != 0, "AuditAuction: job does not exist");
        return _jobBids[jobId].length;
    }

    /// @notice Returns all currently tracked active job ids.
    /// @return jobIds Active job ids.
    function getActiveJobs() external view returns (uint256[] memory jobIds) {
        return activeJobIds;
    }

    /// @notice Returns status for a job.
    /// @param jobId Job id.
    /// @return status Current job status.
    function getJobStatus(uint256 jobId) external view returns (JobStatus status) {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        return job.status;
    }

    /// @notice Returns a specific agent's bid for a job by linear scan.
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function.
    /// @param jobId Job id.
    /// @param agent Agent address.
    /// @return bid Agent bid payload.
    function getAgentBid(uint256 jobId, address agent) external view returns (AgentBid memory bid) {
        require(jobs[jobId].jobId != 0, "AuditAuction: job does not exist");
        AgentBid[] storage bids = _jobBids[jobId];
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].agent == agent) {
                return bids[i];
            }
        }
        revert("AuditAuction: bid not found");
    }

    /// @notice Pauses mutating functions in emergency scenarios.
    function pause() external onlyOrchestrator {
        _pause();
    }

    /// @notice Unpauses mutating functions after incident handling.
    function unpause() external onlyOrchestrator {
        _unpause();
    }

    /// @dev Calls HTS precompile to transfer GUARD between accounts.
    /// @param from Sender address.
    /// @param to Receiver address.
    /// @param amount Token amount in smallest units.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "AuditAuction: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "AuditAuction: HTS transfer failed");
    }
}
