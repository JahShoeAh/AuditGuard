// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IAuditAuction} from "./interfaces/IAuditAuction.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @dev Extends the day-1 AgentRegistry read interface with reputation mutation.
interface IAgentRegistryReputation is IAgentRegistry {
    function updateReputation(address agent, int256 delta) external;
}

/// @title AuditGuard Sub-Auction
/// @notice Enables nested agent-to-agent micro-contracting linked to parent AuditAuction jobs.
contract SubAuction is Ownable, ReentrancyGuard, Pausable {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code constants.
    int64 internal constant HTS_SUCCESS = 22;

    /// @notice Status of a sub-job in the nested marketplace lifecycle.
    enum SubJobStatus {
        OPEN,
        BIDDING_CLOSED,
        IN_PROGRESS,
        DELIVERED,
        ACCEPTED,
        DISPUTED,
        EXPIRED,
        CANCELLED
    }

    /// @notice Status of a sub-bid submitted by a subcontractor.
    enum SubBidStatus {
        PENDING,
        ACCEPTED,
        REJECTED,
        REFUNDED
    }

    /// @notice Sub-job metadata linked to a parent AuditAuction job.
    struct SubJob {
        uint256 subJobId;
        uint256 parentJobId;
        address requester;
        string taskDescription;
        string requiredSpecialization;
        uint256 paymentAmount;
        uint256 slaDeadline;
        uint256 auctionDeadline;
        address selectedAgent;
        SubJobStatus status;
        bytes32 resultHash;
        uint256 createdAt;
        uint256 completedAt;
    }

    /// @notice Agent sub-bid payload with collateral and proposed execution terms.
    struct SubBid {
        address agent;
        uint256 subJobId;
        uint256 proposedPrice;
        uint256 estimatedTime;
        uint256 collateralLocked;
        SubBidStatus status;
        uint256 timestamp;
    }

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice AgentRegistry contract address.
    address public agentRegistry;

    /// @notice Main AuditAuction contract used for parent lineage checks.
    address public mainAuction;

    /// @notice Treasury that receives slashing proceeds.
    address public treasury;

    /// @notice Auto-incrementing sub-job counter (starts at 1).
    uint256 public nextSubJobId;

    /// @notice Minimum per-sub-bid collateral amount (10 GUARD, 8 decimals).
    uint256 public constant MIN_SUB_COLLATERAL = 10 * 10 ** 8;

    /// @notice Minimum requester escrow per sub-job (0.1 GUARD, 8 decimals).
    uint256 public constant MIN_PAYMENT = 1 * 10 ** 7;

    /// @notice Sub-job storage by id.
    mapping(uint256 => SubJob) public subJobs;

    /// @dev Sub-bid storage by sub-job id.
    mapping(uint256 => SubBid[]) internal _subBids;

    /// @notice Tracks whether an agent has already bid on a sub-job.
    mapping(uint256 => mapping(address => bool)) public hasAgentSubBid;

    /// @notice Parent main-job lineage mapping for nested job-tree traversal.
    mapping(uint256 => uint256[]) public parentToSubJobs;

    /// @notice Sub-jobs created by each requester for portfolio/history views.
    mapping(address => uint256[]) public agentSubJobs;

    /// @notice Emitted when a new linked sub-auction is created.
    event SubAuctionCreated(
        uint256 indexed subJobId,
        uint256 indexed parentJobId,
        address indexed requester,
        string taskDescription,
        string requiredSpecialization,
        uint256 paymentAmount,
        uint256 slaDeadline,
        uint256 auctionDeadline
    );

    /// @notice Emitted when an agent submits a sub-bid and collateral is escrowed.
    event SubBidSubmitted(
        uint256 indexed subJobId,
        address indexed agent,
        uint256 proposedPrice,
        uint256 collateralLocked,
        uint256 estimatedTime
    );

    /// @notice Emitted when requester selects a subcontractor.
    event SubContractorSelected(uint256 indexed subJobId, address indexed agent, uint256 agreedPrice);

    /// @notice Emitted when selected subcontractor delivers the result hash.
    event ResultDelivered(uint256 indexed subJobId, address indexed agent, bytes32 resultHash);

    /// @notice Emitted when requester accepts delivery and settlement completes.
    event ResultAccepted(uint256 indexed subJobId, uint256 paymentAmount);

    /// @notice Emitted when requester disputes the delivered result.
    event ResultDisputed(uint256 indexed subJobId, string reason);

    /// @notice Emitted when dispute has been resolved by the orchestrator.
    event DisputeResolved(uint256 indexed subJobId, bool inFavorOfContractor);

    /// @notice Emitted when selected subcontractor misses SLA and job expires.
    event SubJobExpired(uint256 indexed subJobId, address indexed agent, uint256 slashedAmount);

    /// @notice Emitted when requester cancels an open sub-auction.
    event SubAuctionCancelled(uint256 indexed subJobId);

    /// @notice [Frontend] Deploys sub-auction contract and configures day-1 dependencies.
    /// @param _guardToken GUARD token EVM address.
    /// @param _agentRegistry AgentRegistry contract address.
    /// @param _mainAuction AuditAuction contract address.
    /// @param _treasury Treasury address for slashing proceeds.
    constructor(address _guardToken, address _agentRegistry, address _mainAuction, address _treasury) Ownable(msg.sender) {
        require(_guardToken != address(0), "SubAuction: guard token is zero");
        require(_agentRegistry != address(0), "SubAuction: registry is zero");
        require(_treasury != address(0), "SubAuction: treasury is zero");

        guardToken = _guardToken;
        agentRegistry = _agentRegistry;
        mainAuction = _mainAuction;
        treasury = _treasury;
        nextSubJobId = 1;
    }

    /// @notice [Agent Systems] Creates a nested sub-auction linked to a parent main-job.
    /// @notice [iNFT] parentJobId and emitted lineage data allow parent->child tree reconstruction.
    /// @notice [Frontend] SubAuctionCreated powers nested decomposition visualization.
    /// @param parentJobId Parent AuditAuction job id.
    /// @param taskDescription Human/agent-readable sub-task description.
    /// @param requiredSpecialization Capability tag expected from subcontractors.
    /// @param paymentAmount GUARD escrow amount offered by requester.
    /// @param slaDurationSeconds SLA duration from now in seconds.
    /// @param auctionDurationSeconds Bid window duration from now in seconds.
    /// @return subJobId Newly created sub-job id.
    function createSubAuction(
        uint256 parentJobId,
        string calldata taskDescription,
        string calldata requiredSpecialization,
        uint256 paymentAmount,
        uint256 slaDurationSeconds,
        uint256 auctionDurationSeconds
    ) external nonReentrant whenNotPaused returns (uint256 subJobId) {
        require(mainAuction != address(0), "SubAuction: main auction is zero");
        require(bytes(taskDescription).length > 0, "SubAuction: empty task description");
        require(bytes(requiredSpecialization).length > 0, "SubAuction: empty specialization");
        require(paymentAmount >= MIN_PAYMENT, "SubAuction: payment below minimum");
        require(slaDurationSeconds > 0, "SubAuction: SLA duration is zero");
        require(auctionDurationSeconds > 0, "SubAuction: auction duration is zero");
        require(IAgentRegistry(agentRegistry).isActiveAgent(msg.sender), "SubAuction: inactive requester");

        // Ensures parentJobId exists and requester is one of the winning agents.
        IAuditAuction auction = IAuditAuction(mainAuction);
        auction.getJobStatus(parentJobId);
        IAuditAuction.AuditJob memory parentJob = auction.getJob(parentJobId);
        require(_isWinningAgent(parentJob.winningAgents, msg.sender), "SubAuction: requester not parent winner");

        _transferGuard(msg.sender, address(this), paymentAmount);

        subJobId = nextSubJobId;
        nextSubJobId += 1;

        SubJob storage subJob = subJobs[subJobId];
        subJob.subJobId = subJobId;
        subJob.parentJobId = parentJobId;
        subJob.requester = msg.sender;
        subJob.taskDescription = taskDescription;
        subJob.requiredSpecialization = requiredSpecialization;
        subJob.paymentAmount = paymentAmount;
        subJob.slaDeadline = block.timestamp + slaDurationSeconds;
        subJob.auctionDeadline = block.timestamp + auctionDurationSeconds;
        subJob.status = SubJobStatus.OPEN;
        subJob.createdAt = block.timestamp;

        parentToSubJobs[parentJobId].push(subJobId);
        agentSubJobs[msg.sender].push(subJobId);

        emit SubAuctionCreated(
            subJobId,
            parentJobId,
            msg.sender,
            taskDescription,
            requiredSpecialization,
            paymentAmount,
            subJob.slaDeadline,
            subJob.auctionDeadline
        );
    }

    /// @notice [Agent Systems] Subcontractor submits bid terms with collateral escrow.
    /// @notice [Frontend] SubBidSubmitted updates live micro-auction orderbook UI.
    /// @param subJobId Target sub-job id.
    /// @param proposedPrice Proposed execution price, capped by requester offer.
    /// @param estimatedTime Estimated execution time in seconds.
    /// @param collateralAmount Collateral amount locked for this bid.
    function submitSubBid(uint256 subJobId, uint256 proposedPrice, uint256 estimatedTime, uint256 collateralAmount)
        external
        nonReentrant
        whenNotPaused
    {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(subJob.status == SubJobStatus.OPEN, "SubAuction: sub-job not open");
        require(block.timestamp < subJob.auctionDeadline, "SubAuction: auction expired");
        require(IAgentRegistry(agentRegistry).isActiveAgent(msg.sender), "SubAuction: inactive bidder");
        require(msg.sender != subJob.requester, "SubAuction: requester cannot bid");
        require(proposedPrice <= subJob.paymentAmount, "SubAuction: proposed price exceeds payment");
        require(collateralAmount >= MIN_SUB_COLLATERAL, "SubAuction: collateral below minimum");
        require(!hasAgentSubBid[subJobId][msg.sender], "SubAuction: bid already submitted");

        _transferGuard(msg.sender, address(this), collateralAmount);

        _subBids[subJobId].push(
            SubBid({
                agent: msg.sender,
                subJobId: subJobId,
                proposedPrice: proposedPrice,
                estimatedTime: estimatedTime,
                collateralLocked: collateralAmount,
                status: SubBidStatus.PENDING,
                timestamp: block.timestamp
            })
        );

        hasAgentSubBid[subJobId][msg.sender] = true;

        emit SubBidSubmitted(subJobId, msg.sender, proposedPrice, collateralAmount, estimatedTime);
    }

    /// @notice [Agent Systems] Requester selects winning subcontractor and auto-refunds losing collateral.
    /// @notice [Frontend] SubContractorSelected marks the sub-job as actively assigned.
    /// @param subJobId Target sub-job id.
    /// @param bidIndex Winning bid index in the sub-bid array.
    function selectSubContractor(uint256 subJobId, uint256 bidIndex) external nonReentrant whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == subJob.requester, "SubAuction: caller is not requester");
        require(
            subJob.status == SubJobStatus.OPEN || subJob.status == SubJobStatus.BIDDING_CLOSED,
            "SubAuction: invalid sub-job status"
        );

        if (subJob.status == SubJobStatus.OPEN && block.timestamp >= subJob.auctionDeadline) {
            subJob.status = SubJobStatus.BIDDING_CLOSED;
        }

        SubBid[] storage bids = _subBids[subJobId];
        require(bids.length > 0, "SubAuction: no bids");
        require(bidIndex < bids.length, "SubAuction: invalid bid index");
        require(bids[bidIndex].status == SubBidStatus.PENDING, "SubAuction: bid not pending");

        address selectedAgent = bids[bidIndex].agent;
        uint256 agreedPrice = bids[bidIndex].proposedPrice;
        bids[bidIndex].status = SubBidStatus.ACCEPTED;

        for (uint256 i = 0; i < bids.length; i++) {
            if (i == bidIndex) {
                continue;
            }
            if (bids[i].status == SubBidStatus.PENDING) {
                uint256 collateral = bids[i].collateralLocked;
                bids[i].collateralLocked = 0;
                bids[i].status = SubBidStatus.REFUNDED;
                if (collateral > 0) {
                    _transferGuard(address(this), bids[i].agent, collateral);
                }
            } else if (bids[i].status == SubBidStatus.ACCEPTED) {
                bids[i].status = SubBidStatus.REJECTED;
            } else if (bids[i].status == SubBidStatus.REJECTED) {
                uint256 rejectedCollateral = bids[i].collateralLocked;
                bids[i].collateralLocked = 0;
                bids[i].status = SubBidStatus.REFUNDED;
                if (rejectedCollateral > 0) {
                    _transferGuard(address(this), bids[i].agent, rejectedCollateral);
                }
            }
        }

        if (agreedPrice < subJob.paymentAmount) {
            uint256 discount = subJob.paymentAmount - agreedPrice;
            subJob.paymentAmount = agreedPrice;
            _transferGuard(address(this), subJob.requester, discount);
        }

        subJob.selectedAgent = selectedAgent;
        subJob.status = SubJobStatus.IN_PROGRESS;

        emit SubContractorSelected(subJobId, selectedAgent, agreedPrice);
    }

    /// @notice [Agent Systems] Selected subcontractor anchors delivered result via hash.
    /// @notice [iNFT] resultHash links on-chain settlement to off-chain DA payload.
    /// @param subJobId Target sub-job id.
    /// @param resultHash Hash of off-chain delivered result payload.
    function deliverResult(uint256 subJobId, bytes32 resultHash) external whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == subJob.selectedAgent, "SubAuction: caller is not selected agent");
        require(subJob.status == SubJobStatus.IN_PROGRESS, "SubAuction: sub-job not in progress");
        require(block.timestamp <= subJob.slaDeadline, "SubAuction: SLA expired");
        require(resultHash != bytes32(0), "SubAuction: empty result hash");

        subJob.resultHash = resultHash;
        subJob.status = SubJobStatus.DELIVERED;

        emit ResultDelivered(subJobId, msg.sender, resultHash);
    }

    /// @notice [Agent Systems] Requester accepts delivered result and settles payment/collateral.
    /// @notice [Frontend] ResultAccepted marks successful sub-contract completion.
    /// @param subJobId Target sub-job id.
    function acceptResult(uint256 subJobId) external nonReentrant whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == subJob.requester, "SubAuction: caller is not requester");
        require(subJob.status == SubJobStatus.DELIVERED, "SubAuction: result not delivered");

        (bool found, uint256 bidIndex) = _findSelectedBidIndex(subJobId, subJob.selectedAgent);
        require(found, "SubAuction: selected bid not found");

        SubBid storage selectedBid = _subBids[subJobId][bidIndex];
        uint256 payment = selectedBid.proposedPrice;
        uint256 collateral = selectedBid.collateralLocked;

        selectedBid.collateralLocked = 0;
        selectedBid.status = SubBidStatus.REFUNDED;

        if (payment > 0) {
            _transferGuard(address(this), subJob.selectedAgent, payment);
        }
        if (collateral > 0) {
            _transferGuard(address(this), subJob.selectedAgent, collateral);
        }

        subJob.status = SubJobStatus.ACCEPTED;
        subJob.completedAt = block.timestamp;

        IAgentRegistryReputation(agentRegistry).updateReputation(subJob.selectedAgent, 200);

        emit ResultAccepted(subJobId, payment);
    }

    /// @notice [Agent Systems] Requester flags delivered output for orchestrator dispute handling.
    /// @notice [Frontend] ResultDisputed shows pending arbitration state in UI.
    /// @param subJobId Target sub-job id.
    /// @param reason Human-readable dispute reason.
    function disputeResult(uint256 subJobId, string calldata reason) external whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == subJob.requester, "SubAuction: caller is not requester");
        require(subJob.status == SubJobStatus.DELIVERED, "SubAuction: result not delivered");
        require(bytes(reason).length > 0, "SubAuction: empty dispute reason");

        subJob.status = SubJobStatus.DISPUTED;

        emit ResultDisputed(subJobId, reason);
    }

    /// @notice [Agent Systems] Main-auction orchestrator resolves disputed sub-job settlement.
    /// @notice [Frontend] DisputeResolved finalizes dispute outcome visibility.
    /// @param subJobId Target sub-job id.
    /// @param inFavorOfContractor True to pay subcontractor, false to refund requester and slash collateral.
    function resolveDispute(uint256 subJobId, bool inFavorOfContractor) external nonReentrant whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == _getMainAuctionOrchestrator(), "SubAuction: caller is not orchestrator");
        require(subJob.status == SubJobStatus.DISPUTED, "SubAuction: sub-job not disputed");

        (bool found, uint256 bidIndex) = _findSelectedBidIndex(subJobId, subJob.selectedAgent);
        require(found, "SubAuction: selected bid not found");

        SubBid storage selectedBid = _subBids[subJobId][bidIndex];
        uint256 payment = selectedBid.proposedPrice;
        uint256 collateral = selectedBid.collateralLocked;

        selectedBid.collateralLocked = 0;
        selectedBid.status = SubBidStatus.REFUNDED;

        if (inFavorOfContractor) {
            if (payment > 0) {
                _transferGuard(address(this), subJob.selectedAgent, payment);
            }
            if (collateral > 0) {
                _transferGuard(address(this), subJob.selectedAgent, collateral);
            }
            subJob.status = SubJobStatus.ACCEPTED;
        } else {
            if (payment > 0) {
                _transferGuard(address(this), subJob.requester, payment);
            }
            if (collateral > 0) {
                uint256 slashed = (collateral * 50) / 100;
                uint256 refund = collateral - slashed;
                if (slashed > 0) {
                    _transferGuard(address(this), treasury, slashed);
                }
                if (refund > 0) {
                    _transferGuard(address(this), subJob.selectedAgent, refund);
                }
            }
            subJob.status = SubJobStatus.CANCELLED;
        }

        subJob.completedAt = block.timestamp;

        emit DisputeResolved(subJobId, inFavorOfContractor);
    }

    /// @notice [Agent Systems] Permissionless settlement for missed SLA to prevent stuck funds.
    /// @notice [Frontend] SubJobExpired marks failed execution and automatic slashing outcome.
    /// @param subJobId Target sub-job id.
    function claimExpired(uint256 subJobId) external nonReentrant whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(subJob.status == SubJobStatus.IN_PROGRESS, "SubAuction: sub-job not in progress");
        require(block.timestamp > subJob.slaDeadline, "SubAuction: SLA not expired");
        require(subJob.resultHash == bytes32(0), "SubAuction: already delivered");

        (bool found, uint256 bidIndex) = _findSelectedBidIndex(subJobId, subJob.selectedAgent);
        require(found, "SubAuction: selected bid not found");

        SubBid storage selectedBid = _subBids[subJobId][bidIndex];
        uint256 payment = selectedBid.proposedPrice;
        uint256 collateral = selectedBid.collateralLocked;
        uint256 slashedAmount = (collateral * 25) / 100;
        uint256 refundAmount = collateral - slashedAmount;

        selectedBid.collateralLocked = 0;
        selectedBid.status = SubBidStatus.REFUNDED;

        if (payment > 0) {
            _transferGuard(address(this), subJob.requester, payment);
        }
        if (slashedAmount > 0) {
            _transferGuard(address(this), treasury, slashedAmount);
        }
        if (refundAmount > 0) {
            _transferGuard(address(this), subJob.selectedAgent, refundAmount);
        }

        subJob.status = SubJobStatus.EXPIRED;
        subJob.completedAt = block.timestamp;

        IAgentRegistryReputation(agentRegistry).updateReputation(subJob.selectedAgent, -300);

        emit SubJobExpired(subJobId, subJob.selectedAgent, slashedAmount);
    }

    /// @notice [Agent Systems] Requester cancels open sub-auction and receives escrow refunds.
    /// @notice [Frontend] SubAuctionCancelled removes job from active bidding feeds.
    /// @param subJobId Target sub-job id.
    function cancelSubAuction(uint256 subJobId) external nonReentrant whenNotPaused {
        SubJob storage subJob = _getExistingSubJob(subJobId);
        require(msg.sender == subJob.requester, "SubAuction: caller is not requester");
        require(subJob.status == SubJobStatus.OPEN, "SubAuction: only open jobs cancellable");

        SubBid[] storage bids = _subBids[subJobId];
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].status == SubBidStatus.PENDING || bids[i].status == SubBidStatus.ACCEPTED) {
                uint256 collateral = bids[i].collateralLocked;
                bids[i].collateralLocked = 0;
                bids[i].status = SubBidStatus.REFUNDED;
                if (collateral > 0) {
                    _transferGuard(address(this), bids[i].agent, collateral);
                }
            }
        }

        if (subJob.paymentAmount > 0) {
            _transferGuard(address(this), subJob.requester, subJob.paymentAmount);
        }

        subJob.status = SubJobStatus.CANCELLED;
        subJob.completedAt = block.timestamp;

        emit SubAuctionCancelled(subJobId);
    }

    /// @notice [iNFT] Returns full sub-job payload for parent-child state reconstruction.
    /// @notice [Frontend] Used for sub-job detail views.
    /// @param subJobId Sub-job id.
    /// @return job Sub-job payload.
    function getSubJob(uint256 subJobId) external view returns (SubJob memory job) {
        job = _getExistingSubJob(subJobId);
    }

    /// @notice [Frontend] Returns all bids for a sub-job to render bid ladders and selection controls.
    /// @param subJobId Sub-job id.
    /// @return bids Array of sub-bids.
    function getSubBids(uint256 subJobId) external view returns (SubBid[] memory bids) {
        _getExistingSubJob(subJobId);
        return _subBids[subJobId];
    }

    /// @notice [iNFT] Returns child sub-job ids for a parent AuditAuction job.
    /// @param parentJobId Parent main-job id.
    /// @return subJobIds Linked sub-job ids.
    function getSubJobsForParent(uint256 parentJobId) external view returns (uint256[] memory subJobIds) {
        return parentToSubJobs[parentJobId];
    }

    /// @notice [Frontend] Returns sub-job ids created by a requester agent.
    /// @param agent Requester address.
    /// @return subJobIds Sub-job ids created by the requester.
    function getSubJobsByAgent(address agent) external view returns (uint256[] memory subJobIds) {
        return agentSubJobs[agent];
    }

    /// @notice [Frontend] Returns all currently OPEN sub-auctions.
    /// @return openIds Sub-job ids with OPEN status.
    function getOpenSubAuctions() external view returns (uint256[] memory openIds) {
        uint256 count = 0;
        for (uint256 id = 1; id < nextSubJobId; id++) {
            if (subJobs[id].status == SubJobStatus.OPEN) {
                count++;
            }
        }

        openIds = new uint256[](count);
        uint256 cursor = 0;
        for (uint256 id = 1; id < nextSubJobId; id++) {
            if (subJobs[id].status == SubJobStatus.OPEN) {
                openIds[cursor] = id;
                cursor++;
            }
        }
    }

    /// @notice [Agent Systems] Returns OPEN sub-auctions filtered by specialization tag.
    /// @notice [Frontend] Powers specialization-aware sub-auction discovery UI.
    /// @param spec Specialization tag to filter on.
    /// @return openIds OPEN sub-job ids whose specialization matches `spec`.
    function getOpenSubAuctionsBySpecialization(string calldata spec) external view returns (uint256[] memory openIds) {
        bytes32 specHash = keccak256(bytes(spec));
        uint256 count = 0;
        for (uint256 id = 1; id < nextSubJobId; id++) {
            SubJob storage subJob = subJobs[id];
            if (subJob.status == SubJobStatus.OPEN && keccak256(bytes(subJob.requiredSpecialization)) == specHash) {
                count++;
            }
        }

        openIds = new uint256[](count);
        uint256 cursor = 0;
        for (uint256 id = 1; id < nextSubJobId; id++) {
            SubJob storage subJob = subJobs[id];
            if (subJob.status == SubJobStatus.OPEN && keccak256(bytes(subJob.requiredSpecialization)) == specHash) {
                openIds[cursor] = id;
                cursor++;
            }
        }
    }

    /// @notice [Frontend] Updates linked main auction contract for parent lineage checks.
    /// @param _mainAuction New AuditAuction contract address.
    function setMainAuction(address _mainAuction) external onlyOwner {
        require(_mainAuction != address(0), "SubAuction: main auction is zero");
        mainAuction = _mainAuction;
    }

    /// @notice [Frontend] Updates AgentRegistry dependency for active-agent and reputation checks.
    /// @param _agentRegistry New AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        require(_agentRegistry != address(0), "SubAuction: registry is zero");
        agentRegistry = _agentRegistry;
    }

    /// @notice [Frontend] Updates treasury recipient for slashing proceeds.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "SubAuction: treasury is zero");
        treasury = _treasury;
    }

    /// @notice [Frontend] Pauses state-mutating functions for emergency handling.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice [Frontend] Unpauses state-mutating functions after incident handling.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice [Frontend] Returns orchestrator configured on main auction for dispute authorization.
    /// @return orchestrator Main auction orchestrator address.
    function getMainAuctionOrchestrator() external view returns (address orchestrator) {
        return _getMainAuctionOrchestrator();
    }

    /// @notice [iNFT] Ensures sub-job exists and returns storage reference.
    /// @param subJobId Sub-job id.
    /// @return subJob Storage pointer to sub-job.
    function _getExistingSubJob(uint256 subJobId) internal view returns (SubJob storage subJob) {
        subJob = subJobs[subJobId];
        require(subJob.subJobId != 0, "SubAuction: sub-job does not exist");
    }

    /// @notice [Agent Systems] Finds selected agent bid index for settlement paths.
    /// @param subJobId Sub-job id.
    /// @param selectedAgent Selected subcontractor address.
    /// @return found True if bid exists.
    /// @return index Bid index if found.
    function _findSelectedBidIndex(uint256 subJobId, address selectedAgent)
        internal
        view
        returns (bool found, uint256 index)
    {
        SubBid[] storage bids = _subBids[subJobId];
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].agent == selectedAgent) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    /// @notice [iNFT] Checks whether requester belongs to parent main-job winning set.
    /// @param winners Winning agent array from AuditAuction.
    /// @param candidate Requester candidate address.
    /// @return isWinner True if candidate is in winners list.
    function _isWinningAgent(address[] memory winners, address candidate) internal pure returns (bool isWinner) {
        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == candidate) {
                return true;
            }
        }
        return false;
    }

    /// @notice [Agent Systems] Reads orchestrator from main auction for dispute access control.
    /// @return orchestrator Orchestrator address from AuditAuction.
    function _getMainAuctionOrchestrator() internal view returns (address orchestrator) {
        require(mainAuction != address(0), "SubAuction: main auction is zero");
        (bool ok, bytes memory data) = mainAuction.staticcall(abi.encodeWithSignature("orchestrator()"));
        require(ok && data.length == 32, "SubAuction: orchestrator query failed");
        orchestrator = abi.decode(data, (address));
        require(orchestrator != address(0), "SubAuction: invalid orchestrator");
    }

    /// @notice [Agent Systems] Executes GUARD transfers through HTS precompile.
    /// @param from Sender address.
    /// @param to Receiver address.
    /// @param amount Token amount in smallest units.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "SubAuction: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "SubAuction: HTS transfer failed");
    }
}
