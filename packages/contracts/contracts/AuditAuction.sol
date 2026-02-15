// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @title AuditGuard Audit Auction
/// @notice Manages audit job posting, bid collection, and per-job collateral escrow on Hedera HSCS.
/// @dev Registration/reputation remain in AgentRegistry; this contract only reads those values.
contract AuditAuction is ReentrancyGuard, Pausable, Ownable {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code constants.
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    /// @notice Minimum per-bid collateral amount (50 GUARD, 8 decimals).
    uint256 public constant MIN_BID_COLLATERAL = 50 * 10 ** 8;
    uint256 internal constant MAX_SPEED_TIME = 86_400;

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

    /// @notice Tracks whether a winning agent has had escrow released for a job.
    mapping(uint256 => mapping(address => bool)) public isWinnerPaid;

    /// @notice Count of winners paid per job.
    mapping(uint256 => uint256) public paidWinnerCount;

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

    /// @notice Emitted when winning bids are selected and auction moves to execution.
    event WinnersSelected(uint256 indexed jobId, address[] winners, uint256 totalEscrowed, uint256 platformFee);

    /// @notice Emitted when a losing or cancelled bid's collateral is refunded.
    event BidRefunded(uint256 indexed jobId, address indexed agent, uint256 refundedCollateral);

    /// @notice Emitted when payment/bonus and collateral are released to a winner.
    event EscrowReleased(
        uint256 indexed jobId,
        address indexed agent,
        uint256 payment,
        uint256 bonus,
        uint256 collateralReturned
    );

    /// @notice Emitted when a winning bid collateral is slashed for poor/malicious outcomes.
    event AgentSlashed(uint256 indexed jobId, address indexed agent, uint256 slashedAmount, uint256 slashBasisPoints);

    /// @notice Emitted when a job is fully settled and finalized.
    event JobCompleted(uint256 indexed jobId);

    /// @notice Emitted when an open job is cancelled.
    event JobCancelled(uint256 indexed jobId);

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
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "AuditAuction: guard token is zero");
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

    /// @notice Calculates transparent bid score for ranking (0..10000+ with tier bonus).
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function.
    /// @param jobId Job id.
    /// @param bidIndex Bid index in the job bid array.
    /// @return score Bid score where higher is better.
    function calculateBidScore(uint256 jobId, uint256 bidIndex) public view returns (uint256 score) {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(bidIndex < _jobBids[jobId].length, "AuditAuction: invalid bid index");

        AgentBid storage bid = _jobBids[jobId][bidIndex];
        uint256 reputationComponent = (bid.reputationAtBid * 55) / 100;
        uint256 priceComponent = ((job.budgetAvailable - bid.bidAmount) * 25 * 100) / job.budgetAvailable;

        uint256 cappedEta = bid.estimatedCompletionTime > MAX_SPEED_TIME ? MAX_SPEED_TIME : bid.estimatedCompletionTime;
        uint256 speedComponent = ((MAX_SPEED_TIME - cappedEta) * 15 * 100) / MAX_SPEED_TIME;

        IAgentRegistry.AgentTier tier = IAgentRegistry(agentRegistry).getAgentTier(bid.agent);
        uint256 tierBonus = 0;
        if (tier == IAgentRegistry.AgentTier.SPECIALIZED) {
            tierBonus = 250;
        } else if (tier == IAgentRegistry.AgentTier.PREMIUM) {
            tierBonus = 500;
        }

        return reputationComponent + priceComponent + speedComponent + tierBonus;
    }

    /// @notice Returns bid indices sorted by descending score.
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function.
    /// @param jobId Job id.
    /// @return rankedIndices Bid indices sorted from highest score to lowest score.
    function rankBids(uint256 jobId) external view returns (uint256[] memory rankedIndices) {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");

        uint256 bidLength = _jobBids[jobId].length;
        rankedIndices = new uint256[](bidLength);
        for (uint256 i = 0; i < bidLength; i++) {
            rankedIndices[i] = i;
        }

        for (uint256 i = 1; i < bidLength; i++) {
            uint256 key = rankedIndices[i];
            uint256 keyScore = calculateBidScore(jobId, key);
            uint256 j = i;
            while (j > 0) {
                uint256 prev = rankedIndices[j - 1];
                uint256 prevScore = calculateBidScore(jobId, prev);
                if (prevScore >= keyScore) {
                    break;
                }
                rankedIndices[j] = prev;
                j--;
            }
            rankedIndices[j] = key;
        }
    }

    /// @notice Selects one or more winning bids and transitions to auditing phase.
    /// @param jobId Job id.
    /// @param winningBidIndices Bid indices chosen as winners.
    function selectWinners(uint256 jobId, uint256[] calldata winningBidIndices)
        external
        onlyOrchestrator
        nonReentrant
        whenNotPaused
    {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(
            job.status == JobStatus.AUCTION_OPEN || job.status == JobStatus.BIDDING_CLOSED,
            "AuditAuction: invalid job status"
        );
        require(winningBidIndices.length > 0, "AuditAuction: no winners provided");

        AgentBid[] storage bids = _jobBids[jobId];
        bool[] memory seenIndex = new bool[](bids.length);
        uint256 totalWinningBidAmount = 0;

        for (uint256 i = 0; i < winningBidIndices.length; i++) {
            uint256 bidIndex = winningBidIndices[i];
            require(bidIndex < bids.length, "AuditAuction: invalid bid index");
            require(!seenIndex[bidIndex], "AuditAuction: duplicate winning index");
            seenIndex[bidIndex] = true;

            AgentBid storage bid = bids[bidIndex];
            require(bid.status == BidStatus.PENDING, "AuditAuction: bid not pending");

            bid.status = BidStatus.ACCEPTED;
            job.winningAgents.push(bid.agent);
            totalWinningBidAmount += bid.bidAmount;
        }

        require(totalWinningBidAmount <= job.budgetAvailable, "AuditAuction: total exceeds budget");

        uint256 platformFee = (totalWinningBidAmount * platformFeePercent) / 100;
        if (platformFee > 0) {
            _transferGuard(address(this), treasury, platformFee);
        }

        job.totalEscrowedAmount = totalWinningBidAmount - platformFee;
        job.status = JobStatus.AUDITING_IN_PROGRESS;

        for (uint256 i = 0; i < bids.length; i++) {
            AgentBid storage bid = bids[i];
            if (bid.status == BidStatus.PENDING) {
                uint256 collateral = bid.collateralLocked;
                bid.status = BidStatus.REFUNDED;
                if (collateral > 0) {
                    bid.collateralLocked = 0;
                    _transferGuard(address(this), bid.agent, collateral);
                    emit BidRefunded(jobId, bid.agent, collateral);
                }
            }
        }

        emit WinnersSelected(jobId, job.winningAgents, job.totalEscrowedAmount, platformFee);
    }

    /// @notice Releases payment, bonus, and collateral to a winning agent.
    /// @dev Any agent registered via AgentRegistry (including third-party agents following the OpenClaw UCP interface) can call this function through orchestrator settlement flow.
    /// @param jobId Job id.
    /// @param agent Winning agent address.
    /// @param payment Base GUARD payment.
    /// @param bonus Bonus GUARD payment.
    /// @param validFindings Count of validated vulnerabilities for reputation updates.
    /// @param falsePos Count of false positives for reputation updates.
    /// @param falseNeg Count of false negatives for reputation updates.
    function releaseEscrow(
        uint256 jobId,
        address agent,
        uint256 payment,
        uint256 bonus,
        uint256 validFindings,
        uint256 falsePos,
        uint256 falseNeg
    ) external onlyOrchestrator nonReentrant whenNotPaused {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(
            job.status == JobStatus.AUDITING_IN_PROGRESS || job.status == JobStatus.REPORT_PENDING,
            "AuditAuction: invalid job status"
        );
        require(!isWinnerPaid[jobId][agent], "AuditAuction: winner already paid");

        (bool found, uint256 bidIndex) = _findBidIndex(jobId, agent);
        require(found, "AuditAuction: bid not found");
        AgentBid storage bid = _jobBids[jobId][bidIndex];
        require(bid.status == BidStatus.ACCEPTED, "AuditAuction: bid not accepted");

        uint256 payout = payment + bonus;
        require(payout <= job.totalEscrowedAmount, "AuditAuction: insufficient escrow");

        if (payout > 0) {
            _transferGuard(address(this), agent, payout);
            job.totalEscrowedAmount -= payout;
        }

        uint256 collateralReturned = bid.collateralLocked;
        if (collateralReturned > 0) {
            bid.collateralLocked = 0;
            _transferGuard(address(this), agent, collateralReturned);
        }

        isWinnerPaid[jobId][agent] = true;
        paidWinnerCount[jobId] += 1;

        IAgentRegistry(agentRegistry).recordJobCompletion(agent, validFindings, falsePos, falseNeg);

        emit EscrowReleased(jobId, agent, payment, bonus, collateralReturned);
    }

    /// @notice Slashes winning bid collateral and registry stake for low-quality or malicious behavior.
    /// @param jobId Job id.
    /// @param agent Winning agent address.
    /// @param slashBasisPoints Slash basis points (500, 1000, or 10000).
    function slashAgentBid(uint256 jobId, address agent, uint256 slashBasisPoints)
        external
        onlyOrchestrator
        nonReentrant
        whenNotPaused
    {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(
            job.status == JobStatus.AUDITING_IN_PROGRESS || job.status == JobStatus.REPORT_PENDING,
            "AuditAuction: invalid job status"
        );
        require(
            slashBasisPoints == 500 || slashBasisPoints == 1000 || slashBasisPoints == 10_000,
            "AuditAuction: invalid slash bps"
        );
        require(!isWinnerPaid[jobId][agent], "AuditAuction: winner already paid");

        (bool found, uint256 bidIndex) = _findBidIndex(jobId, agent);
        require(found, "AuditAuction: bid not found");
        AgentBid storage bid = _jobBids[jobId][bidIndex];
        require(bid.status == BidStatus.ACCEPTED, "AuditAuction: bid not accepted");

        uint256 collateral = bid.collateralLocked;
        require(collateral > 0, "AuditAuction: no collateral to slash");

        uint256 slashedAmount = (collateral * slashBasisPoints) / 10_000;
        uint256 remainder = collateral - slashedAmount;

        bid.collateralLocked = 0;
        bid.status = BidStatus.REFUNDED;

        if (slashedAmount > 0) {
            _transferGuard(address(this), treasury, slashedAmount);
        }
        if (remainder > 0) {
            _transferGuard(address(this), agent, remainder);
        }

        IAgentRegistry(agentRegistry).slashAgent(agent, slashBasisPoints);

        emit AgentSlashed(jobId, agent, slashedAmount, slashBasisPoints);
    }

    /// @notice Completes a job once all winners are settled and escrow is fully distributed.
    /// @param jobId Job id.
    function completeJob(uint256 jobId) external onlyOrchestrator whenNotPaused {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(
            job.status == JobStatus.AUDITING_IN_PROGRESS || job.status == JobStatus.REPORT_PENDING,
            "AuditAuction: invalid job status"
        );
        require(job.winningAgents.length > 0, "AuditAuction: no winners selected");
        require(paidWinnerCount[jobId] == job.winningAgents.length, "AuditAuction: unpaid winners remain");
        require(job.totalEscrowedAmount == 0, "AuditAuction: escrow not fully distributed");

        job.status = JobStatus.COMPLETED;
        _removeActiveJob(jobId);

        emit JobCompleted(jobId);
    }

    /// @notice Cancels an open job and refunds all existing bidder collateral.
    /// @param jobId Job id.
    function cancelJob(uint256 jobId) external onlyOrchestrator nonReentrant whenNotPaused {
        AuditJob storage job = jobs[jobId];
        require(job.jobId != 0, "AuditAuction: job does not exist");
        require(job.status == JobStatus.AUCTION_OPEN, "AuditAuction: only open jobs cancellable");

        AgentBid[] storage bids = _jobBids[jobId];
        for (uint256 i = 0; i < bids.length; i++) {
            AgentBid storage bid = bids[i];
            if (bid.status == BidStatus.PENDING) {
                uint256 collateral = bid.collateralLocked;
                bid.status = BidStatus.REFUNDED;
                if (collateral > 0) {
                    bid.collateralLocked = 0;
                    _transferGuard(address(this), bid.agent, collateral);
                    emit BidRefunded(jobId, bid.agent, collateral);
                }
            }
        }

        job.status = JobStatus.CANCELLED;
        _removeActiveJob(jobId);

        emit JobCancelled(jobId);
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

    /// @notice Sets the AgentRegistry address once after deployment if not already configured.
    /// @param _agentRegistry AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        require(_agentRegistry != address(0), "AuditAuction: registry is zero");
        require(agentRegistry == address(0), "AuditAuction: registry already set");
        agentRegistry = _agentRegistry;
    }

    /// @notice Updates orchestrator address used for privileged lifecycle actions.
    /// @param _orchestrator New orchestrator address.
    function setOrchestrator(address _orchestrator) external onlyOwner {
        require(_orchestrator != address(0), "AuditAuction: orchestrator is zero");
        orchestrator = _orchestrator;
    }

    /// @notice Updates treasury address used for platform fee and slashing proceeds.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "AuditAuction: treasury is zero");
        treasury = _treasury;
    }

    /// @notice Updates platform fee percent for successful audit payouts.
    /// @param feePercent New fee percent (max 10).
    function setPlatformFeePercent(uint256 feePercent) external onlyOwner {
        require(feePercent <= 10, "AuditAuction: fee exceeds maximum");
        platformFeePercent = feePercent;
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

    /// @dev Finds an agent bid index for a given job.
    function _findBidIndex(uint256 jobId, address agent) internal view returns (bool found, uint256 index) {
        AgentBid[] storage bids = _jobBids[jobId];
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].agent == agent) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    /// @dev Removes a job id from activeJobIds by swap-and-pop.
    function _removeActiveJob(uint256 jobId) internal {
        for (uint256 i = 0; i < activeJobIds.length; i++) {
            if (activeJobIds[i] == jobId) {
                activeJobIds[i] = activeJobIds[activeJobIds.length - 1];
                activeJobIds.pop();
                return;
            }
        }
    }
}
