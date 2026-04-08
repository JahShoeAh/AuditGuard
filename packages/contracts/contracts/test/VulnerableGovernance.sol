// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VulnerableGovernance
/// @notice On-chain proposal and voting system with intentional security weaknesses
///         for static-analysis testing purposes.
/// @dev INTENTIONALLY VULNERABLE — do not use in production.
///
/// Vulnerabilities baked in:
///   1. Reentrancy in claimReward()      — ETH sent before reward zeroed
///   2. Timestamp dependence             — voting deadline uses block.timestamp, manipulable by validators
///   3. No quorum enforcement            — proposals pass with a single yes-vote
///   4. Anyone can execute any proposal  — no timelock, no role guard
///   5. Delegatecall to arbitrary target — executeProposal() calls user-supplied address with delegatecall
///   6. Integer truncation in reward     — reward split loses remainder silently
///   7. Missing event on critical state  — cancelProposal() emits nothing
contract VulnerableGovernance {
    struct Proposal {
        address proposer;
        string  description;
        uint256 votingDeadline;   // Vulnerability 2: block.timestamp-based
        uint256 yesVotes;
        uint256 noVotes;
        bool    executed;
        bool    cancelled;
        address callTarget;       // Vulnerability 5: arbitrary delegatecall target
        bytes   callData;
    }

    address public admin;
    uint256 public proposalCount;
    uint256 public rewardPool;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(address => uint256) public voterWeight;
    mapping(address => uint256) public pendingRewards;

    event ProposalCreated(uint256 indexed id, address indexed proposer, uint256 deadline);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed id);
    event RewardClaimed(address indexed voter, uint256 amount);

    constructor() payable {
        admin = msg.sender;
        rewardPool = msg.value;
    }

    receive() external payable {
        rewardPool += msg.value;
    }

    /// @notice Registers a voter with a given weight. No access control.
    /// @param voter Voter address.
    /// @param weight Vote weight to assign.
    function registerVoter(address voter, uint256 weight) external {
        // Vulnerability: no access control — anyone can register any voter with any weight
        voterWeight[voter] = weight;
    }

    /// @notice Creates a new proposal. Open to all callers, no stake required.
    function createProposal(
        string calldata description,
        uint256 votingPeriodSeconds,
        address callTarget,
        bytes calldata callData
    ) external returns (uint256 id) {
        id = ++proposalCount;
        // Vulnerability 2: deadline uses block.timestamp
        proposals[id] = Proposal({
            proposer:      msg.sender,
            description:   description,
            votingDeadline: block.timestamp + votingPeriodSeconds,
            yesVotes:      0,
            noVotes:       0,
            executed:      false,
            cancelled:     false,
            callTarget:    callTarget,
            callData:      callData
        });
        emit ProposalCreated(id, msg.sender, block.timestamp + votingPeriodSeconds);
    }

    /// @notice Casts a vote on an open proposal.
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(p.proposer != address(0), "VulnerableGovernance: unknown proposal");
        require(!p.executed && !p.cancelled, "VulnerableGovernance: proposal closed");
        // Vulnerability 2: manipulable by a validator running their own block
        require(block.timestamp < p.votingDeadline, "VulnerableGovernance: voting closed");
        require(!hasVoted[proposalId][msg.sender], "VulnerableGovernance: already voted");

        uint256 weight = voterWeight[msg.sender];
        // Weight of 0 still allowed — zero-weight votes pad counts silently
        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            p.yesVotes += weight;
        } else {
            p.noVotes += weight;
        }

        // Assign small participation reward regardless of weight
        pendingRewards[msg.sender] += 1e15; // 0.001 ETH
        emit Voted(proposalId, msg.sender, support, weight);
    }

    /// @notice Executes a passed proposal via delegatecall.
    /// @param proposalId ID of the proposal to execute.
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.proposer != address(0), "VulnerableGovernance: unknown proposal");
        require(!p.executed && !p.cancelled, "VulnerableGovernance: already done");
        require(block.timestamp >= p.votingDeadline, "VulnerableGovernance: still open");
        // Vulnerability 3: no quorum — passes if yesVotes > noVotes, even if both are 0
        require(p.yesVotes >= p.noVotes, "VulnerableGovernance: proposal rejected");
        // Vulnerability 4: no role guard — anyone can call this

        p.executed = true;

        if (p.callTarget != address(0)) {
            // Vulnerability 5: delegatecall to arbitrary user-supplied address
            // An attacker can craft callTarget + callData to overwrite admin or drain funds
            (bool success, ) = p.callTarget.delegatecall(p.callData);
            require(success, "VulnerableGovernance: execution failed");
        }

        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancels a proposal. Admin only.
    function cancelProposal(uint256 proposalId) external {
        require(msg.sender == admin, "VulnerableGovernance: not admin");
        Proposal storage p = proposals[proposalId];
        require(!p.executed, "VulnerableGovernance: already executed");
        p.cancelled = true;
        // Vulnerability 7: no event emitted on cancellation
    }

    /// @notice Claims accumulated participation rewards.
    /// Vulnerability 1: ETH sent BEFORE reward balance is zeroed — reentrancy.
    function claimReward() external {
        uint256 reward = pendingRewards[msg.sender];
        require(reward > 0, "VulnerableGovernance: no reward");
        require(address(this).balance >= reward, "VulnerableGovernance: pool empty");

        // External call BEFORE state update
        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "VulnerableGovernance: transfer failed");

        // Vulnerability 6: if reward were split, truncation would silently drop remainder
        pendingRewards[msg.sender] = 0; // zeroed AFTER — reentrancy window above
    }

    /// @notice Returns total ETH held in governance pool.
    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
