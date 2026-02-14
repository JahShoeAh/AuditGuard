// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title AuditGuard Agent Registry
/// @notice On-chain marketplace "front door" for open agent registration compatible with OpenClaw UCP.
/// @dev Any external agent can register by staking GUARD; seeded agents can still be boosted for demo flow.
contract AgentRegistry is Ownable, ReentrancyGuard, Pausable {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code constants.
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    /// @notice Marketplace tier for an agent profile.
    enum AgentTier {
        UNREGISTERED,
        COMMODITY,
        SPECIALIZED,
        PREMIUM
    }

    /// @notice Operational status for an agent in the marketplace.
    enum AgentStatus {
        INACTIVE,
        ACTIVE,
        SUSPENDED,
        SLASHED
    }

    /// @notice On-chain Agent Interface Standard used by AuditGuard and OpenClaw UCP dispatching.
    struct AgentProfile {
        address agentAddress;
        string agentId;
        string ucpEndpoint;
        string[] specializations;
        AgentTier tier;
        AgentStatus status;
        uint256 stakedAmount;
        uint256 reputationScore;
        uint256 completedJobs;
        uint256 successfulFindings;
        uint256 falsePositives;
        uint256 falseNegatives;
        uint256 registeredAt;
        uint256 lastActiveAt;
    }

    /// @notice GUARD token EVM address (HTS token address).
    address public guardToken;

    /// @notice AuditGuard orchestrator address allowed to score and slash agents.
    address public orchestrator;

    /// @notice Auction contract address allowed to score agents from auction outcomes.
    address public auctionContract;

    /// @notice Agent profile lookup by wallet address.
    mapping(address => AgentProfile) public agents;

    /// @notice Agent addresses in registration order (leaderboard/enumeration source).
    address[] public agentList;

    /// @dev Tracks whether an address has already been inserted into agentList.
    mapping(address => bool) private inAgentList;

    /// @notice Commodity tier minimum stake.
    uint256 public constant COMMODITY_MIN_STAKE = 100 * 10 ** 8;

    /// @notice Specialized tier minimum stake.
    uint256 public constant SPECIALIZED_MIN_STAKE = 300 * 10 ** 8;

    /// @notice Premium tier minimum stake.
    uint256 public constant PREMIUM_MIN_STAKE = 500 * 10 ** 8;

    /// @notice Minimum reputation for promotion to Specialized tier (70.00).
    uint256 public constant SPECIALIZED_MIN_REPUTATION = 7000;

    /// @notice Minimum reputation for promotion to Premium tier (85.00).
    uint256 public constant PREMIUM_MIN_REPUTATION = 8500;

    /// @notice Neutral default reputation for newly registered agents (50.00).
    uint256 public constant NEW_AGENT_INITIAL_REPUTATION = 5000;

    /// @notice Emitted when an external or seeded agent joins the open registry.
    event AgentRegistered(address indexed agent, string agentId, string ucpEndpoint, uint256 stakedAmount);

    /// @notice Emitted when an existing agent increases staked collateral.
    event StakeAdded(address indexed agent, uint256 amount, uint256 newTotal);

    /// @notice Emitted when an agent is promoted to a higher marketplace tier.
    event AgentPromoted(address indexed agent, AgentTier from, AgentTier to);

    /// @notice Emitted when reputation changes from orchestrator/auction updates.
    event ReputationUpdated(address indexed agent, int256 delta, uint256 newReputation);

    /// @notice Emitted when owner seeds demo-specific initial reputation for fresh agents.
    event ReputationSeeded(address indexed agent, uint256 reputation);

    /// @notice Emitted when a completed job contributes outcome metrics.
    event JobRecorded(address indexed agent, uint256 validFindings, uint256 falsePositives, uint256 falseNegatives);

    /// @notice Emitted when collateral is slashed after poor or malicious behavior.
    event AgentSlashed(address indexed agent, uint256 slashedAmount, uint256 slashBasisPoints);

    /// @notice Emitted when an agent exits and receives remaining stake.
    event AgentDeregistered(address indexed agent, uint256 returnedStake);

    /// @dev Restricts a function to orchestrator only.
    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "AgentRegistry: caller is not orchestrator");
        _;
    }

    /// @dev Restricts a function to orchestrator or auction contract.
    modifier onlyOrchestratorOrAuction() {
        require(
            msg.sender == orchestrator || msg.sender == auctionContract,
            "AgentRegistry: caller is not authorized scorer"
        );
        _;
    }

    /// @notice Deploys the registry and associates it to GUARD token via HTS precompile.
    /// @param _guardToken GUARD token EVM address used for all staking/slashing flows.
    constructor(address _guardToken) Ownable(msg.sender) {
        require(_guardToken != address(0), "AgentRegistry: guard token is zero");
        guardToken = _guardToken;

        int64 responseCode = HTS.tokenAssociate(address(this), _guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "AgentRegistry: token association failed"
        );
    }

    /// @notice Registers any external OpenClaw-compatible agent into AuditGuard's open marketplace.
    /// @dev New agents always start in Commodity tier to enforce reputation-gated progression.
    /// @param agentId Human-readable UCP-aligned agent identifier.
    /// @param ucpEndpoint OpenClaw UCP endpoint used by the orchestrator for dispatch.
    /// @param specializations Capability tags (static analysis, fuzzing, etc.).
    /// @param stakeAmount Initial GUARD collateral stake.
    function registerAgent(
        string calldata agentId,
        string calldata ucpEndpoint,
        string[] calldata specializations,
        uint256 stakeAmount
    ) external nonReentrant whenNotPaused {
        require(bytes(agentId).length > 0, "AgentRegistry: empty agentId");
        require(bytes(ucpEndpoint).length > 0, "AgentRegistry: empty endpoint");
        require(stakeAmount >= COMMODITY_MIN_STAKE, "AgentRegistry: insufficient commodity stake");

        AgentProfile storage existing = agents[msg.sender];
        require(
            existing.agentAddress == address(0) || existing.status == AgentStatus.INACTIVE,
            "AgentRegistry: already registered"
        );

        _transferGuard(msg.sender, address(this), stakeAmount);

        AgentProfile storage profile = agents[msg.sender];
        delete profile.specializations;
        for (uint256 i = 0; i < specializations.length; i++) {
            profile.specializations.push(specializations[i]);
        }

        profile.agentAddress = msg.sender;
        profile.agentId = agentId;
        profile.ucpEndpoint = ucpEndpoint;
        profile.tier = AgentTier.COMMODITY;
        profile.status = AgentStatus.ACTIVE;
        profile.stakedAmount = stakeAmount;
        profile.reputationScore = NEW_AGENT_INITIAL_REPUTATION;
        profile.completedJobs = 0;
        profile.successfulFindings = 0;
        profile.falsePositives = 0;
        profile.falseNegatives = 0;
        profile.registeredAt = block.timestamp;
        profile.lastActiveAt = block.timestamp;

        if (!inAgentList[msg.sender]) {
            inAgentList[msg.sender] = true;
            agentList.push(msg.sender);
        }

        emit AgentRegistered(msg.sender, agentId, ucpEndpoint, stakeAmount);
    }

    /// @notice Adds more GUARD collateral for an already registered marketplace agent.
    /// @dev Does not auto-promote tier; promotion remains explicit and reputation-gated.
    /// @param amount Additional GUARD to stake.
    function addStake(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "AgentRegistry: amount is zero");
        AgentProfile storage profile = _getExistingProfile(msg.sender);
        require(profile.status != AgentStatus.INACTIVE && profile.status != AgentStatus.SLASHED, "AgentRegistry: inactive");

        _transferGuard(msg.sender, address(this), amount);
        profile.stakedAmount += amount;
        profile.lastActiveAt = block.timestamp;

        if (profile.status == AgentStatus.SUSPENDED && profile.stakedAmount >= COMMODITY_MIN_STAKE) {
            profile.status = AgentStatus.ACTIVE;
        }

        emit StakeAdded(msg.sender, amount, profile.stakedAmount);
    }

    /// @notice Requests tier promotion after proving quality in the open, reputation-driven market.
    /// @dev Promotion path is COMMODITY->SPECIALIZED->PREMIUM only.
    function requestPromotion() external whenNotPaused {
        AgentProfile storage profile = _getExistingProfile(msg.sender);
        require(profile.status == AgentStatus.ACTIVE, "AgentRegistry: agent not active");

        AgentTier fromTier = profile.tier;
        if (fromTier == AgentTier.COMMODITY) {
            require(
                profile.reputationScore >= SPECIALIZED_MIN_REPUTATION &&
                    profile.stakedAmount >= SPECIALIZED_MIN_STAKE,
                "AgentRegistry: specialized requirements unmet"
            );
            profile.tier = AgentTier.SPECIALIZED;
            emit AgentPromoted(msg.sender, fromTier, AgentTier.SPECIALIZED);
            return;
        }

        if (fromTier == AgentTier.SPECIALIZED) {
            require(
                profile.reputationScore >= PREMIUM_MIN_REPUTATION && profile.stakedAmount >= PREMIUM_MIN_STAKE,
                "AgentRegistry: premium requirements unmet"
            );
            profile.tier = AgentTier.PREMIUM;
            emit AgentPromoted(msg.sender, fromTier, AgentTier.PREMIUM);
            return;
        }

        revert("AgentRegistry: no promotion path");
    }

    /// @notice Applies reputation delta from orchestrator/auction scoring in the hybrid agent ecosystem.
    /// @dev Positive values reward valid findings, negative values penalize misses/errors.
    /// @param agent Agent wallet to update.
    /// @param delta Reputation delta in basis points.
    function updateReputation(address agent, int256 delta) external onlyOrchestratorOrAuction whenNotPaused {
        _updateReputation(agent, delta);
    }

    /// @notice Records finalized job outcomes and adjusts reputation using AuditGuard scoring rules.
    /// @dev Called by orchestrator/auction after result validation and settlement.
    /// @param agent Agent wallet that completed the job.
    /// @param validFindings Count of validated vulnerabilities.
    /// @param falsePos Count of false positives.
    /// @param falseNeg Count of false negatives.
    function recordJobCompletion(
        address agent,
        uint256 validFindings,
        uint256 falsePos,
        uint256 falseNeg
    ) external onlyOrchestratorOrAuction whenNotPaused {
        AgentProfile storage profile = _getExistingProfile(agent);

        profile.completedJobs += 1;
        profile.successfulFindings += validFindings;
        profile.falsePositives += falsePos;
        profile.falseNegatives += falseNeg;
        profile.lastActiveAt = block.timestamp;

        int256 delta = int256(validFindings * 50) - int256(falsePos * 100) - int256(falseNeg * 200);
        _updateReputation(agent, delta);

        emit JobRecorded(agent, validFindings, falsePos, falseNeg);
    }

    /// @notice Slashes staked collateral for policy violations (false reports or malicious behavior).
    /// @dev Uses slash basis points: 500 (5%), 1000 (10%), 10000 (100%).
    /// @param agent Agent wallet to slash.
    /// @param slashBasisPoints Slash magnitude in basis points.
    function slashAgent(address agent, uint256 slashBasisPoints) external onlyOrchestrator nonReentrant whenNotPaused {
        require(slashBasisPoints > 0 && slashBasisPoints <= 10_000, "AgentRegistry: invalid slash bps");

        AgentProfile storage profile = _getExistingProfile(agent);
        require(profile.stakedAmount > 0, "AgentRegistry: no stake");

        uint256 slashedAmount = (profile.stakedAmount * slashBasisPoints) / 10_000;
        require(slashedAmount > 0, "AgentRegistry: slash amount is zero");

        profile.stakedAmount -= slashedAmount;
        _transferGuard(address(this), owner(), slashedAmount);

        if (slashBasisPoints == 10_000) {
            profile.status = AgentStatus.SLASHED;
        } else if (profile.stakedAmount < COMMODITY_MIN_STAKE) {
            profile.status = AgentStatus.SUSPENDED;
        }

        emit AgentSlashed(agent, slashedAmount, slashBasisPoints);
    }

    /// @notice Withdraws excess collateral while preserving active-tier minimum stake requirements.
    /// @dev Active agents must keep at least their current tier minimum stake.
    /// @param amount GUARD amount to withdraw.
    function withdrawStake(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "AgentRegistry: amount is zero");
        AgentProfile storage profile = _getExistingProfile(msg.sender);
        require(amount <= profile.stakedAmount, "AgentRegistry: insufficient stake");

        if (profile.status == AgentStatus.ACTIVE) {
            uint256 tierMinimum = _tierMinimumStake(profile.tier);
            require(profile.stakedAmount - amount >= tierMinimum, "AgentRegistry: below tier minimum");
        }

        profile.stakedAmount -= amount;
        _transferGuard(address(this), msg.sender, amount);
    }

    /// @notice Voluntarily exits the marketplace and returns all remaining collateral.
    /// @dev Keeps profile history on-chain but marks the agent inactive.
    function deregisterAgent() external nonReentrant whenNotPaused {
        AgentProfile storage profile = _getExistingProfile(msg.sender);
        require(profile.status != AgentStatus.INACTIVE, "AgentRegistry: already inactive");

        uint256 returnedStake = profile.stakedAmount;
        profile.stakedAmount = 0;
        profile.status = AgentStatus.INACTIVE;

        if (returnedStake > 0) {
            _transferGuard(address(this), msg.sender, returnedStake);
        }

        emit AgentDeregistered(msg.sender, returnedStake);
    }

    /// @notice One-time owner setup for orchestrator and auction authorized callers.
    /// @dev These addresses can update reputation and job metrics in hybrid off-chain/on-chain flow.
    /// @param _orchestrator Orchestrator contract/account.
    /// @param _auction Auction contract/account.
    function setOrchestratorAndAuction(address _orchestrator, address _auction) external onlyOwner {
        require(orchestrator == address(0) && auctionContract == address(0), "AgentRegistry: already configured");
        require(_orchestrator != address(0) && _auction != address(0), "AgentRegistry: zero address");
        orchestrator = _orchestrator;
        auctionContract = _auction;
    }

    /// @notice Seeds initial reputation for fresh demo agents before they build live job history.
    /// @dev Enables hackathon seeding so pre-built agents can be promoted immediately.
    /// @param agent Agent wallet to seed.
    /// @param reputation Reputation score in basis points (0..10000).
    function seedAgentReputation(address agent, uint256 reputation) external onlyOwner {
        require(reputation <= 10_000, "AgentRegistry: reputation out of range");
        AgentProfile storage profile = _getExistingProfile(agent);
        require(profile.completedJobs == 0, "AgentRegistry: agent already has jobs");
        profile.reputationScore = reputation;
        emit ReputationSeeded(agent, reputation);
    }

    /// @notice Pauses mutation flows to handle emergencies in the open marketplace.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses mutation flows after incident handling.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Returns the full on-chain interface profile for an agent.
    /// @param agent Agent wallet address.
    /// @return profile Agent profile payload.
    function getAgent(address agent) external view returns (AgentProfile memory profile) {
        return agents[agent];
    }

    /// @notice Returns current tier for a given agent.
    /// @param agent Agent wallet address.
    /// @return tier Agent tier.
    function getAgentTier(address agent) external view returns (AgentTier tier) {
        return agents[agent].tier;
    }

    /// @notice Checks if an active agent can participate in a requested tier.
    /// @dev Eligibility uses active status, current promoted tier, stake, and reputation thresholds.
    /// @param agent Agent wallet address.
    /// @param tier Tier to evaluate.
    /// @return eligible True if eligible.
    function isEligibleForTier(address agent, AgentTier tier) public view returns (bool eligible) {
        AgentProfile storage profile = agents[agent];
        if (profile.status != AgentStatus.ACTIVE) {
            return false;
        }

        if (tier == AgentTier.COMMODITY) {
            return profile.stakedAmount >= COMMODITY_MIN_STAKE && profile.tier != AgentTier.UNREGISTERED;
        }
        if (tier == AgentTier.SPECIALIZED) {
            bool tierOk = profile.tier == AgentTier.SPECIALIZED || profile.tier == AgentTier.PREMIUM;
            return
                tierOk &&
                profile.stakedAmount >= SPECIALIZED_MIN_STAKE &&
                profile.reputationScore >= SPECIALIZED_MIN_REPUTATION;
        }
        if (tier == AgentTier.PREMIUM) {
            return
                profile.tier == AgentTier.PREMIUM &&
                profile.stakedAmount >= PREMIUM_MIN_STAKE &&
                profile.reputationScore >= PREMIUM_MIN_REPUTATION;
        }

        return false;
    }

    /// @notice Returns active agent addresses eligible in a target tier for leaderboard/selection.
    /// @param tier Tier to filter.
    /// @return tierAgents Filtered agent address list.
    function getAgentsByTier(AgentTier tier) external view returns (address[] memory tierAgents) {
        uint256 count = 0;
        for (uint256 i = 0; i < agentList.length; i++) {
            if (isEligibleForTier(agentList[i], tier)) {
                count++;
            }
        }

        tierAgents = new address[](count);
        uint256 cursor = 0;
        for (uint256 i = 0; i < agentList.length; i++) {
            if (isEligibleForTier(agentList[i], tier)) {
                tierAgents[cursor] = agentList[i];
                cursor++;
            }
        }
    }

    /// @notice Returns total count of unique agent addresses ever added to the registry list.
    /// @return count Number of addresses in agentList.
    function getAgentCount() external view returns (uint256 count) {
        return agentList.length;
    }

    /// @notice Returns current reputation score for an agent.
    /// @param agent Agent wallet address.
    /// @return reputation Reputation basis points (0..10000).
    function getAgentReputation(address agent) external view returns (uint256 reputation) {
        return agents[agent].reputationScore;
    }

    /// @notice Returns whether the agent is active and allowed to participate.
    /// @param agent Agent wallet address.
    /// @return active True if status is ACTIVE.
    function isActiveAgent(address agent) external view returns (bool active) {
        return agents[agent].status == AgentStatus.ACTIVE;
    }

    /// @notice Returns full agent address list for off-chain indexing and analytics.
    /// @return allAgents Full array of registered addresses.
    function getAllAgents() external view returns (address[] memory allAgents) {
        return agentList;
    }

    /// @dev Returns an existing profile for an address or reverts if unregistered.
    function _getExistingProfile(address agent) internal view returns (AgentProfile storage profile) {
        profile = agents[agent];
        require(profile.agentAddress != address(0), "AgentRegistry: agent not registered");
    }

    /// @dev Applies clamped reputation deltas and emits ReputationUpdated.
    function _updateReputation(address agent, int256 delta) internal {
        AgentProfile storage profile = _getExistingProfile(agent);

        int256 updated = int256(profile.reputationScore) + delta;
        if (updated < 0) {
            updated = 0;
        } else if (updated > 10_000) {
            updated = 10_000;
        }

        profile.reputationScore = uint256(updated);
        emit ReputationUpdated(agent, delta, profile.reputationScore);
    }

    /// @dev Returns minimum stake needed for a given tier.
    function _tierMinimumStake(AgentTier tier) internal pure returns (uint256 minimum) {
        if (tier == AgentTier.PREMIUM) {
            return PREMIUM_MIN_STAKE;
        }
        if (tier == AgentTier.SPECIALIZED) {
            return SPECIALIZED_MIN_STAKE;
        }
        if (tier == AgentTier.COMMODITY) {
            return COMMODITY_MIN_STAKE;
        }
        return 0;
    }

    /// @dev Calls HTS precompile to transfer GUARD between accounts.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "AgentRegistry: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "AgentRegistry: HTS transfer failed");
    }
}
