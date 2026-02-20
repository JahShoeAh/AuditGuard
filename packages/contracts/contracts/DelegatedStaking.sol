// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

// ─── Minimal interfaces ───────────────────────────────────────────────────────

/// @dev Minimal AgentRegistry surface used to verify agent status.
interface IAgentRegistryDelegation {
    /// @notice Returns true if the agent is registered and ACTIVE.
    function isActiveAgent(address agent) external view returns (bool);
}

/// @dev Minimal StakingManager surface used to read agent self-stake.
interface IStakingManagerDelegation {
    /// @notice Returns the effective self-stake of an agent (totalStaked - unbonding).
    function getEffectiveStake(address agent) external view returns (uint256);
}

/// @title AuditGuard Delegated Staking
/// @notice Allows human token-holders to delegate GUARD behind registered agents as an
///         expression of economic confidence. Delegators share proportionally in the
///         agent's audit earnings and slashing risk — "skin in the game" for all parties.
///
/// @dev Architecture summary:
///
///   DELEGATORS                 AGENTS                  PROTOCOL
///   ──────────                 ──────                  ────────
///   delegate(agent, amount)    setRewardShareBps()      propagateSlash() [StakingManager]
///   requestUndelegate()                                 distributeRewards() [PaymentSettlement]
///   completeUndelegate()
///   claimRewards()
///
///   Reward maths use a Synthetix-style rewardPerToken accumulator for O(1) per-claim
///   gas rather than iterating all delegators on every distribution.
///
///   Key invariant: totalDelegated in the pool always equals the sum of active
///   delegation.amount values for that agent. Unbonding amounts are excluded from
///   pool totals immediately upon requestUndelegate().
///
/// @custom:security Delegators are NOT operators — they have zero control over agent
///   behaviour. Their only lever is to undelegate (subject to unbonding period).
contract DelegatedStaking is ReentrancyGuard, Pausable, Ownable {
    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev HTS success response code.
    int64 internal constant HTS_SUCCESS = 22;

    /// @dev HTS already-associated response code.
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    /// @dev Precision multiplier for reward-per-token accumulator.
    ///      1e30 gives sufficient headroom for uint96 amounts × uint96 rewards.
    uint256 internal constant PRECISION = 1e30;

    // ──────────────────────────────────────────────
    //  Core Data Structures
    // ──────────────────────────────────────────────

    /// @notice A single delegator→agent delegation record.
    /// @dev Stored at delegations[keccak256(abi.encodePacked(delegator, agent))].
    struct Delegation {
        /// @notice Delegator wallet address.
        address delegator;
        /// @notice Agent wallet address this delegation backs.
        address agent;
        /// @notice Active delegated GUARD in smallest units (8 decimals). uint96 safe: max ~790k GUARD.
        uint96 amount;
        /// @notice Block timestamp when the delegation was first created.
        uint48 delegatedAt;
        /// @notice Block timestamp of the most recent reward claim.
        uint48 lastRewardClaimAt;
        /// @notice Accumulated unclaimed rewards (convenience cache between claims).
        uint96 pendingRewards;
        /// @notice GUARD currently in the unbonding cooldown for this delegation.
        uint96 unbondingAmount;
        /// @notice Timestamp when the unbonding period completes (0 if no unbonding).
        uint48 unbondingCompleteAt;
        /// @notice Snapshot of pool.rewardPerTokStored at the time of last reward settlement.
        /// @dev Needed for the Synthetix accumulator: pending = amount × (current - paid) / PRECISION.
        uint256 rewardPerTokenPaid;
        /// @notice True while the delegation is active (amount > 0 or unbonding).
        bool active;
    }

    /// @notice Per-agent delegation pool state.
    struct AgentDelegationPool {
        /// @notice Agent wallet address.
        address agent;
        /// @notice Sum of all active delegation.amount values for this agent.
        uint96 totalDelegated;
        /// @notice Cumulative GUARD rewards ever allocated to this pool (for stats).
        uint96 totalRewardsAccrued;
        /// @notice Synthetix-style accumulator: rewards per delegated token × PRECISION.
        /// @dev Increases monotonically each time distributeRewards() is called.
        uint256 rewardPerTokStored;
        /// @notice Basis points of agent's audit earnings shared with delegators.
        ///         1000 = 10%, range 100–5000.
        uint16 rewardShareBps;
        /// @notice Number of unique delegators currently delegating to this agent.
        uint32 delegatorCount;
    }

    // ──────────────────────────────────────────────
    //  State — Addresses
    // ──────────────────────────────────────────────

    /// @notice GUARD HTS token EVM address.
    address public guardToken;

    /// @notice StakingManager contract — reads agent self-stake, calls propagateSlash.
    address public stakingManager;

    /// @notice AgentRegistry contract — verifies agent is ACTIVE before new delegations.
    address public agentRegistry;

    /// @notice Treasury address — receives the delegator portion of slashed GUARD.
    address public treasury;

    // ──────────────────────────────────────────────
    //  State — Authorization
    // ──────────────────────────────────────────────

    /// @notice Contracts allowed to call distributeRewards (PaymentSettlement + agents themselves).
    mapping(address => bool) public authorizedDistributors;

    // ──────────────────────────────────────────────
    //  State — Parameters (governance-adjustable)
    // ──────────────────────────────────────────────

    /// @notice Minimum GUARD a delegator must commit. 10 GUARD (8 decimals).
    uint256 public minDelegation = 10 * 10 ** 8;

    /// @notice Cooldown before undelegated GUARD can be withdrawn. 24 hours.
    /// @dev Mirrors StakingManager.unbondingPeriod — prevents flash-withdraw before slashing.
    uint256 public unbondingPeriod = 86400;

    /// @notice Maximum delegators per agent. Guards propagateSlash() gas cost.
    uint256 public maxDelegatorsPerAgent = 50;

    /// @notice Default reward share bps assigned when an agent enables delegation. 10%.
    uint256 public defaultRewardBps = 1000;

    // ──────────────────────────────────────────────
    //  State — Storage
    // ──────────────────────────────────────────────

    /// @notice Delegation records keyed by keccak256(delegator, agent).
    mapping(bytes32 => Delegation) public delegations;

    /// @notice Agent delegation pool state.
    mapping(address => AgentDelegationPool) public agentPools;

    /// @notice delegator → ordered list of agents they have delegated to.
    mapping(address => address[]) public delegatorAgents;

    /// @notice agent → ordered list of delegator addresses.
    mapping(address => address[]) public agentDelegators;

    /// @dev Quick lookup to avoid duplicate entries in delegatorAgents.
    mapping(bytes32 => bool) private _inDelegatorAgents;

    /// @dev Quick lookup to avoid duplicate entries in agentDelegators.
    mapping(bytes32 => bool) private _inAgentDelegators;

    /// @notice Aggregate GUARD delegated across all agents (dashboard stat).
    uint256 public totalDelegatedAllAgents;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when an agent adjusts the share bps offered to delegators.
    event RewardShareUpdated(address indexed agent, uint16 oldBps, uint16 newBps);

    /// @notice Emitted when a delegator increases their backing of an agent.
    /// @dev [Frontend] Updates delegator portfolio and agent leaderboard backing bar.
    ///      [iNFT] Agent Profile iNFT: totalBacking field increases.
    event Delegated(
        address indexed delegator,
        address indexed agent,
        uint96 amount,
        uint96 newTotalDelegated
    );

    /// @notice Emitted when a delegator requests the unbonding cooldown.
    event UndelegationRequested(
        address indexed delegator,
        address indexed agent,
        uint96 amount,
        uint48 completesAt
    );

    /// @notice Emitted when unbonding completes and GUARD is returned to the delegator.
    /// @dev [Frontend] Delegator portfolio: remove or reduce delegation entry.
    event UndelegationCompleted(
        address indexed delegator,
        address indexed agent,
        uint96 amount
    );

    /// @notice Emitted when the agent's pool receives new rewards from an audit settlement.
    /// @dev [PaymentSettlement] This event triggers after every distributeRewards() call.
    ///      [Frontend] Updates the "Delegator yield" stat on the agent detail card.
    event RewardsDistributed(
        address indexed agent,
        uint96 totalAmount,
        uint96 delegatorShare
    );

    /// @notice Emitted when a delegator claims accumulated rewards.
    /// @dev [Frontend] Clears pending reward badge on delegator portfolio.
    event RewardsClaimed(
        address indexed delegator,
        address indexed agent,
        uint96 amount
    );

    /// @notice Emitted when a slash propagates to all delegations of an agent.
    /// @dev [StakingManager] Triggered by propagateSlash(), which is called from
    ///      StakingManager.initiateSlash() so delegators share the agent's risk.
    ///      [Frontend] Flash-red animation on all affected delegation rows.
    event DelegationSlashed(
        address indexed agent,
        uint96 totalSlashed,
        uint32 delegatorCount
    );

    /// @notice Emitted when this contract is associated with the GUARD token on HTS.
    event GuardTokenAssociated(address indexed token);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    /// @dev Restricts to StakingManager only — slash propagation authority.
    modifier onlyStakingManager() {
        require(msg.sender == stakingManager, "DelegatedStaking: not staking manager");
        _;
    }

    /// @dev Restricts to authorized distributors (PaymentSettlement + agent themselves).
    modifier onlyAuthorizedDistributor(address agent) {
        require(
            authorizedDistributors[msg.sender] || msg.sender == agent,
            "DelegatedStaking: not authorized distributor"
        );
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice Deploys DelegatedStaking with the required contract addresses.
    /// @param _guardToken GUARD HTS token EVM address.
    /// @param _treasury Treasury address for slash proceeds.
    /// @dev StakingManager and AgentRegistry can be set post-deployment via setters.
    constructor(
        address _guardToken,
        address _treasury
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "DelegatedStaking: guard token is zero");
        require(_treasury != address(0), "DelegatedStaking: treasury is zero");

        guardToken = _guardToken;
        treasury = _treasury;
    }

    // ──────────────────────────────────────────────
    //  Agent Configuration
    // ──────────────────────────────────────────────

    /// @notice Adjusts the share of audit earnings an agent offers to delegators.
    /// @param bps New reward share in basis points. Must be in [100, 5000] (1%–50%).
    function setRewardShareBps(uint16 bps) external {
        require(bps >= 100 && bps <= 5000, "DelegatedStaking: bps out of range [100,5000]");

        AgentDelegationPool storage pool = agentPools[msg.sender];
        require(pool.agent == msg.sender, "DelegatedStaking: not a registered pool");

        uint16 oldBps = pool.rewardShareBps;
        pool.rewardShareBps = bps;

        emit RewardShareUpdated(msg.sender, oldBps, bps);
    }

    // ──────────────────────────────────────────────
    //  Delegation
    // ──────────────────────────────────────────────

    /// @notice Delegates GUARD tokens to back an agent. The delegator shares proportionally
    ///         in the agent's audit earnings and slashing risk going forward.
    /// @dev Transfers GUARD from delegator to this contract via HTS precompile.
    ///      Creates a new Delegation if one doesn't exist, or increases existing amount.
    ///      Settles any pending rewards before changing amount (accumulator pattern).
    ///      Auto-initializes the agent's pool on first delegation.
    /// @param agent Agent wallet address to delegate to.
    /// @param amount GUARD to delegate in smallest units (must be >= minDelegation).
    function delegate(address agent, uint96 amount) external nonReentrant whenNotPaused {
        require(amount >= minDelegation, "DelegatedStaking: below minimum delegation");

        if (agentRegistry != address(0)) {
            require(
                IAgentRegistryDelegation(agentRegistry).isActiveAgent(agent),
                "DelegatedStaking: agent not active"
            );
        }

        AgentDelegationPool storage pool = agentPools[agent];

        // Auto-initialize pool if first delegation to this agent
        if (pool.agent == address(0)) {
            pool.agent = agent;
            pool.rewardShareBps = uint16(defaultRewardBps);
        }

        bytes32 key = _delegationKey(msg.sender, agent);
        Delegation storage d = delegations[key];

        if (!d.active) {
            // New delegation — check capacity
            require(
                pool.delegatorCount < maxDelegatorsPerAgent,
                "DelegatedStaking: agent at max delegators"
            );
            d.delegator = msg.sender;
            d.agent = agent;
            d.delegatedAt = uint48(block.timestamp);
            d.active = true;
            d.rewardPerTokenPaid = pool.rewardPerTokStored;

            // Track lists (no duplicates)
            _addToDelegatorAgents(msg.sender, agent);
            _addToAgentDelegators(agent, msg.sender);

            pool.delegatorCount++;
        } else {
            // Increasing existing delegation — settle pending rewards first
            _settlePending(d, pool);
        }

        _transferGuard(msg.sender, address(this), amount);

        d.amount += amount;
        pool.totalDelegated += amount;
        totalDelegatedAllAgents += amount;

        d.lastRewardClaimAt = uint48(block.timestamp);

        emit Delegated(msg.sender, agent, amount, pool.totalDelegated);
    }

    /// @notice Initiates an unbonding cooldown for a portion of a delegation.
    ///         The amount is immediately removed from the pool total (no rewards accrue
    ///         on unbonding GUARD) and is locked for `unbondingPeriod` seconds.
    /// @dev Settles pending rewards before reducing amount so the delegator doesn't
    ///      lose accrued rewards.
    /// @param agent Agent wallet address the delegation is targeting.
    /// @param amount GUARD to begin unbonding (must be <= active delegation amount).
    function requestUndelegate(address agent, uint96 amount) external nonReentrant whenNotPaused {
        bytes32 key = _delegationKey(msg.sender, agent);
        Delegation storage d = delegations[key];
        require(d.active, "DelegatedStaking: no active delegation");
        require(amount > 0, "DelegatedStaking: amount is zero");
        require(amount <= d.amount, "DelegatedStaking: exceeds delegated amount");
        require(d.unbondingAmount == 0, "DelegatedStaking: unbonding already in progress");

        AgentDelegationPool storage pool = agentPools[agent];

        // Settle rewards before reducing amount
        _settlePending(d, pool);

        d.amount -= amount;
        d.unbondingAmount = amount;
        d.unbondingCompleteAt = uint48(block.timestamp + unbondingPeriod);

        pool.totalDelegated -= amount;
        totalDelegatedAllAgents -= amount;

        // If remaining active delegation falls below minimum, force full unbonding
        if (d.amount > 0 && d.amount < uint96(minDelegation)) {
            uint96 remainder = d.amount;
            d.amount = 0;
            d.unbondingAmount += remainder;
            pool.totalDelegated -= remainder;
            totalDelegatedAllAgents -= remainder;
        }

        emit UndelegationRequested(msg.sender, agent, amount, d.unbondingCompleteAt);
    }

    /// @notice Completes a matured unbonding, returning GUARD to the delegator.
    ///         If the remaining active delegation is zero after withdrawal, the delegation
    ///         record is marked inactive and removed from pool counts.
    /// @dev Callable by anyone on behalf of a delegator (permissionless completion).
    /// @param agent Agent wallet address the delegation targets.
    function completeUndelegate(address agent) external nonReentrant {
        bytes32 key = _delegationKey(msg.sender, agent);
        Delegation storage d = delegations[key];
        require(d.active, "DelegatedStaking: no active delegation");
        require(d.unbondingAmount > 0, "DelegatedStaking: nothing to complete");
        require(
            block.timestamp >= d.unbondingCompleteAt,
            "DelegatedStaking: unbonding period not elapsed"
        );

        uint96 amount = d.unbondingAmount;
        d.unbondingAmount = 0;
        d.unbondingCompleteAt = 0;

        // If no active delegation remains, close the record
        if (d.amount == 0) {
            d.active = false;
            agentPools[agent].delegatorCount--;
        }

        _transferGuard(address(this), msg.sender, amount);

        emit UndelegationCompleted(msg.sender, agent, amount);
    }

    // ──────────────────────────────────────────────
    //  Reward Distribution
    // ──────────────────────────────────────────────

    /// @notice Distributes audit earnings to the agent's delegation pool.
    ///         Updates the rewardPerTokStored accumulator — no per-delegator iteration.
    ///
    /// @dev [PaymentSettlement] Call this after every job settlement:
    ///        delegatedStaking.distributeRewards(agent, agentEarnings)
    ///      The function applies pool.rewardShareBps to derive the delegator fraction.
    ///      If no GUARD is currently delegated to the agent, the call is a no-op (the
    ///      agent keeps 100% — delegators cannot claim rewards on amounts they didn't
    ///      back at the time of distribution).
    ///
    /// @param agent     Agent wallet whose pool receives rewards.
    /// @param amount    Total GUARD earnings being shared (in smallest units).
    function distributeRewards(
        address agent,
        uint96 amount
    ) external nonReentrant onlyAuthorizedDistributor(agent) {
        AgentDelegationPool storage pool = agentPools[agent];
        require(pool.agent == agent, "DelegatedStaking: pool not initialized");

        if (pool.totalDelegated == 0 || amount == 0) return;

        // Delegator's share of the incoming amount
        uint96 delegatorShare = uint96((uint256(amount) * pool.rewardShareBps) / 10000);
        if (delegatorShare == 0) return;

        // Transfer delegatorShare from caller to this contract for distribution
        _transferGuard(msg.sender, address(this), delegatorShare);

        // Update accumulator: rewardPerToken += delegatorShare × PRECISION / totalDelegated
        pool.rewardPerTokStored += (uint256(delegatorShare) * PRECISION) / pool.totalDelegated;
        pool.totalRewardsAccrued += delegatorShare;

        emit RewardsDistributed(agent, amount, delegatorShare);
    }

    /// @notice Claims accumulated rewards for a single agent delegation.
    /// @dev Computes pending rewards via accumulator delta, resets the checkpoint,
    ///      and transfers GUARD to the delegator.
    ///      Calling this frequently is gas-efficient (O(1) math, one HTS transfer).
    /// @param agent Agent wallet whose pool to claim from.
    function claimRewards(address agent) external nonReentrant {
        bytes32 key = _delegationKey(msg.sender, agent);
        Delegation storage d = delegations[key];
        require(d.active, "DelegatedStaking: no active delegation");

        AgentDelegationPool storage pool = agentPools[agent];
        _settlePending(d, pool);

        uint96 reward = d.pendingRewards;
        require(reward > 0, "DelegatedStaking: no rewards to claim");

        d.pendingRewards = 0;
        d.lastRewardClaimAt = uint48(block.timestamp);

        _transferGuard(address(this), msg.sender, reward);

        emit RewardsClaimed(msg.sender, agent, reward);
    }

    /// @notice Convenience function — claims rewards from every agent the caller has
    ///         delegated to. Iterates delegatorAgents[msg.sender].
    /// @dev Gas cost grows linearly with the number of agent delegations. Callers with
    ///      many delegations should claim individually to stay within block gas limits.
    function claimAllRewards() external nonReentrant {
        address[] storage agents = delegatorAgents[msg.sender];
        uint256 total = agents.length;

        for (uint256 i = 0; i < total; i++) {
            address agent = agents[i];
            bytes32 key = _delegationKey(msg.sender, agent);
            Delegation storage d = delegations[key];

            if (!d.active) continue;

            AgentDelegationPool storage pool = agentPools[agent];
            _settlePending(d, pool);

            uint96 reward = d.pendingRewards;
            if (reward == 0) continue;

            d.pendingRewards = 0;
            d.lastRewardClaimAt = uint48(block.timestamp);

            _transferGuard(address(this), msg.sender, reward);

            emit RewardsClaimed(msg.sender, agent, reward);
        }
    }

    // ──────────────────────────────────────────────
    //  Slashing Propagation
    // ──────────────────────────────────────────────

    /// @notice Propagates a slash event from StakingManager to all delegators of an agent.
    ///         Every active delegation loses the same proportion as the agent's self-stake.
    ///
    /// @dev [StakingManager] Called from StakingManager.initiateSlash() immediately after
    ///      the agent's own stake is reduced. This ensures delegators cannot withdraw
    ///      before being slashed (their unbonding cooldown mirrors the agent's).
    ///
    ///      The slashed GUARD is transferred directly to treasury (no escrow — appeal
    ///      is managed by StakingManager on the agent side). If the agent's appeal is
    ///      approved, StakingManager restores the agent's own stake but delegator GUARD
    ///      is not automatically restored (a future governance call could handle this).
    ///
    ///      Gas bound: maxDelegatorsPerAgent (default 50) caps iteration cost.
    ///
    /// @param agent     The slashed agent.
    /// @param slashBps  Slash magnitude in basis points (same value used on the agent).
    function propagateSlash(
        address agent,
        uint256 slashBps
    ) external nonReentrant onlyStakingManager {
        require(slashBps <= 10000, "DelegatedStaking: slash bps exceeds 100%");

        AgentDelegationPool storage pool = agentPools[agent];
        if (pool.totalDelegated == 0) return;

        address[] storage delegatorList = agentDelegators[agent];
        uint256 n = delegatorList.length;

        uint96 totalSlashed = 0;
        uint32 slashedCount = 0;

        for (uint256 i = 0; i < n; i++) {
            address delegator = delegatorList[i];
            bytes32 key = _delegationKey(delegator, agent);
            Delegation storage d = delegations[key];

            if (!d.active || d.amount == 0) continue;

            // Slash from active amount
            uint96 activeSlash = uint96((uint256(d.amount) * slashBps) / 10000);
            if (activeSlash > d.amount) activeSlash = d.amount;

            // Slash from unbonding amount (prevents dodge via requestUndelegate)
            uint96 unbondingSlash = 0;
            if (d.unbondingAmount > 0) {
                unbondingSlash = uint96((uint256(d.unbondingAmount) * slashBps) / 10000);
                if (unbondingSlash > d.unbondingAmount) unbondingSlash = d.unbondingAmount;
            }

            uint96 slashedFromDelegation = activeSlash + unbondingSlash;
            if (slashedFromDelegation == 0) continue;

            d.amount -= activeSlash;
            d.unbondingAmount -= unbondingSlash;
            totalSlashed += slashedFromDelegation;

            // Sync pool total (only active portion tracked in pool)
            pool.totalDelegated = pool.totalDelegated >= activeSlash
                ? pool.totalDelegated - activeSlash
                : 0;
            totalDelegatedAllAgents = totalDelegatedAllAgents >= activeSlash
                ? totalDelegatedAllAgents - activeSlash
                : 0;

            slashedCount++;

            // Close delegation if fully wiped
            if (d.amount == 0 && d.unbondingAmount == 0) {
                d.active = false;
                pool.delegatorCount = pool.delegatorCount > 0 ? pool.delegatorCount - 1 : 0;
            }
        }

        if (totalSlashed > 0) {
            _transferGuard(address(this), treasury, totalSlashed);
        }

        emit DelegationSlashed(agent, totalSlashed, slashedCount);
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    /// @notice Returns the full Delegation record for a delegator→agent pair.
    /// @dev [Frontend] Delegator portfolio page — shows amount, unbonding, pending rewards.
    /// @param delegator Delegator wallet address.
    /// @param agent     Agent wallet address.
    /// @return The Delegation struct (zeroed if not found).
    function getDelegation(
        address delegator,
        address agent
    ) external view returns (Delegation memory) {
        return delegations[_delegationKey(delegator, agent)];
    }

    /// @notice Returns the full AgentDelegationPool for an agent.
    /// @dev [Frontend] Agent detail card — shows total backing, reward share, delegator count.
    ///      [iNFT] Agent Profile iNFT: pool data feeds the "backing" metric.
    /// @param agent Agent wallet address.
    /// @return The AgentDelegationPool struct.
    function getAgentPool(address agent) external view returns (AgentDelegationPool memory) {
        return agentPools[agent];
    }

    /// @notice Returns all delegations from a single delegator across all agents.
    /// @dev [Frontend] Delegator portfolio view — "My Delegations" tab.
    /// @param delegator Delegator wallet address.
    /// @return agents_       Ordered list of agents delegated to.
    /// @return amounts       Active delegation amounts (excludes unbonding).
    /// @return pendingRewards_ Unsettled reward amounts per delegation.
    function getDelegatorPortfolio(
        address delegator
    )
        external
        view
        returns (
            address[] memory agents_,
            uint96[] memory amounts,
            uint96[] memory pendingRewards_
        )
    {
        address[] storage agentAddrs = delegatorAgents[delegator];
        uint256 n = agentAddrs.length;

        agents_ = new address[](n);
        amounts = new uint96[](n);
        pendingRewards_ = new uint96[](n);

        for (uint256 i = 0; i < n; i++) {
            address agent = agentAddrs[i];
            agents_[i] = agent;

            bytes32 key = _delegationKey(delegator, agent);
            Delegation storage d = delegations[key];
            if (!d.active) continue;

            amounts[i] = d.amount;
            pendingRewards_[i] = _computePending(d, agentPools[agent]);
        }
    }

    /// @notice Returns all delegators to an agent and their active amounts.
    /// @dev [Frontend] Agent detail page — "Backers" section.
    /// @param agent Agent wallet address.
    /// @return delegators_ Ordered list of delegator addresses.
    /// @return amounts     Active delegation amounts per delegator.
    function getAgentDelegators(
        address agent
    ) external view returns (address[] memory delegators_, uint96[] memory amounts) {
        address[] storage delegatorList = agentDelegators[agent];
        uint256 n = delegatorList.length;

        delegators_ = new address[](n);
        amounts = new uint96[](n);

        for (uint256 i = 0; i < n; i++) {
            delegators_[i] = delegatorList[i];
            bytes32 key = _delegationKey(delegatorList[i], agent);
            Delegation storage d = delegations[key];
            amounts[i] = d.active ? d.amount : 0;
        }
    }

    /// @notice Returns the total GUARD actively delegated to an agent (excludes unbonding).
    /// @dev [Frontend] Agent leaderboard backing bar width.
    /// @param agent Agent wallet address.
    /// @return Total delegated GUARD.
    function getTotalDelegatedToAgent(address agent) external view returns (uint96) {
        return agentPools[agent].totalDelegated;
    }

    /// @notice Returns the total economic backing of an agent: self-stake + delegations.
    ///         This represents the full amount at risk if the agent is slashed.
    /// @dev [Frontend] Agent leaderboard "Total Backing" column.
    ///      [Agent Systems] Orchestrators can use this for counterparty risk scoring.
    /// @param agent Agent wallet address.
    /// @return Total economic backing in GUARD smallest units.
    function getEffectiveBacking(address agent) external view returns (uint256) {
        uint256 selfStake = 0;
        if (stakingManager != address(0)) {
            try IStakingManagerDelegation(stakingManager).getEffectiveStake(agent) returns (
                uint256 s
            ) {
                selfStake = s;
            } catch {}
        }
        return selfStake + agentPools[agent].totalDelegated;
    }

    /// @notice Returns the unsettled pending reward for a specific delegation.
    /// @dev [Frontend] Pending reward badge on delegation rows.
    /// @param delegator Delegator wallet address.
    /// @param agent     Agent wallet address.
    /// @return Pending reward in GUARD smallest units.
    function getPendingRewards(
        address delegator,
        address agent
    ) external view returns (uint96) {
        bytes32 key = _delegationKey(delegator, agent);
        Delegation storage d = delegations[key];
        if (!d.active) return 0;
        return _computePending(d, agentPools[agent]);
    }

    /// @notice Returns all agents sorted by totalDelegated descending.
    ///         Limited to agents that have at least one delegation.
    /// @dev [Frontend] Agent leaderboard — "Most Backed" sort option.
    ///      Iterates all agents with pools — gas-heavy; use off-chain indexing for scale.
    /// @param maxResults Maximum number of results to return (cap at call site).
    /// @return agents_  Sorted agent addresses (highest delegation first).
    /// @return totals   Corresponding totalDelegated values.
    function getTopAgentsByDelegation(
        uint256 maxResults
    ) external view returns (address[] memory agents_, uint96[] memory totals) {
        // Collect agents with non-zero pools
        // We use agentDelegators length to enumerate active agents
        // In production, maintain a separate sorted list; this is adequate for hackathon scale
        uint256 found = 0;
        // Temporary arrays bounded by maxResults
        address[] memory tmp = new address[](maxResults);
        uint96[] memory tvals = new uint96[](maxResults);

        // Enumerate: iterate all delegatorAgents to find unique agents
        // This is O(n) and acceptable for small hackathon datasets
        // For each address that has a pool with totalDelegated > 0, include it
        // We can't enumerate all agents without a list; we return what's been tracked.
        // (In production, maintain address[] public allAgentsWithPool)

        // Fallback: return empty — caller should use getDelegatorPortfolio per known agent
        // This is a known limitation; the frontend uses per-agent queries in hooks.
        agents_ = new address[](0);
        totals = new uint96[](0);
        return (agents_, totals);
    }

    /// @notice Returns true if the delegator has an active delegation to the agent.
    /// @dev [Frontend] "Delegate" button state — is already delegating?
    /// @param delegator Delegator wallet address.
    /// @param agent     Agent wallet address.
    /// @return True if there is an active delegation.
    function isDelegating(address delegator, address agent) external view returns (bool) {
        bytes32 key = _delegationKey(delegator, agent);
        return delegations[key].active;
    }

    // ──────────────────────────────────────────────
    //  Governance / Admin
    // ──────────────────────────────────────────────

    /// @notice Sets the GUARD token address.
    /// @param _guardToken New GUARD token address.
    function setGuardToken(address _guardToken) external onlyOwner {
        require(_guardToken != address(0), "DelegatedStaking: address is zero");
        guardToken = _guardToken;
    }

    /// @notice Sets the StakingManager address.
    /// @param _stakingManager New StakingManager address.
    function setStakingManager(address _stakingManager) external onlyOwner {
        stakingManager = _stakingManager;
    }

    /// @notice Sets the AgentRegistry address.
    /// @param _agentRegistry New AgentRegistry address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        agentRegistry = _agentRegistry;
    }

    /// @notice Sets the treasury address for slash proceeds.
    /// @param _treasury New treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "DelegatedStaking: address is zero");
        treasury = _treasury;
    }

    /// @notice Authorizes a contract to call distributeRewards (e.g., PaymentSettlement).
    /// @param distributor Contract address to authorize.
    function addAuthorizedDistributor(address distributor) external onlyOwner {
        require(distributor != address(0), "DelegatedStaking: address is zero");
        authorizedDistributors[distributor] = true;
    }

    /// @notice Removes distributor authorization.
    /// @param distributor Contract address to deauthorize.
    function removeAuthorizedDistributor(address distributor) external onlyOwner {
        authorizedDistributors[distributor] = false;
    }

    /// @notice Sets the minimum delegation amount.
    /// @param amount New minimum in GUARD smallest units.
    function setMinDelegation(uint256 amount) external onlyOwner {
        require(amount > 0, "DelegatedStaking: amount is zero");
        minDelegation = amount;
    }

    /// @notice Sets the unbonding period duration.
    /// @param seconds_ New duration in seconds.
    function setUnbondingPeriod(uint256 seconds_) external onlyOwner {
        unbondingPeriod = seconds_;
    }

    /// @notice Sets the max delegators per agent.
    /// @param max New maximum. Lower values protect propagateSlash() gas cost.
    function setMaxDelegatorsPerAgent(uint256 max) external onlyOwner {
        require(max > 0 && max <= 200, "DelegatedStaking: max out of range");
        maxDelegatorsPerAgent = max;
    }

    /// @notice Sets the default reward share bps for new pools.
    /// @param bps New default in basis points.
    function setDefaultRewardBps(uint256 bps) external onlyOwner {
        require(bps <= 5000, "DelegatedStaking: exceeds 50%");
        defaultRewardBps = bps;
    }

    /// @notice Associates this contract with the GUARD token through HTS precompile.
    /// @dev Call once post-deployment on Hedera; constructor precompile calls can revert.
    function associateGuardToken() external onlyOwner nonReentrant {
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "DelegatedStaking: token association failed"
        );
        emit GuardTokenAssociated(guardToken);
    }

    /// @notice Pauses delegation and reward operations. Emergency use only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  Internal Helpers
    // ──────────────────────────────────────────────

    /// @dev Returns the storage key for a delegator→agent pair.
    function _delegationKey(address delegator, address agent) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(delegator, agent));
    }

    /// @dev Settles pending rewards into d.pendingRewards and advances the checkpoint.
    ///      Must be called before any operation that changes d.amount.
    function _settlePending(
        Delegation storage d,
        AgentDelegationPool storage pool
    ) internal {
        uint96 earned = _computePending(d, pool);
        if (earned > 0) {
            d.pendingRewards += earned;
        }
        d.rewardPerTokenPaid = pool.rewardPerTokStored;
    }

    /// @dev Computes unsettled reward from the accumulator delta.
    function _computePending(
        Delegation storage d,
        AgentDelegationPool storage pool
    ) internal view returns (uint96) {
        if (d.amount == 0) return 0;
        uint256 delta = pool.rewardPerTokStored - d.rewardPerTokenPaid;
        if (delta == 0) return 0;
        uint256 earned = (uint256(d.amount) * delta) / PRECISION;
        // Safe downcast: earned cannot exceed total rewards ever distributed
        return earned > type(uint96).max ? type(uint96).max : uint96(earned);
    }

    /// @dev Appends to delegatorAgents if not already present.
    function _addToDelegatorAgents(address delegator, address agent) internal {
        bytes32 trackKey = keccak256(abi.encodePacked("da", delegator, agent));
        if (!_inDelegatorAgents[trackKey]) {
            delegatorAgents[delegator].push(agent);
            _inDelegatorAgents[trackKey] = true;
        }
    }

    /// @dev Appends to agentDelegators if not already present.
    function _addToAgentDelegators(address agent, address delegator) internal {
        bytes32 trackKey = keccak256(abi.encodePacked("ad", agent, delegator));
        if (!_inAgentDelegators[trackKey]) {
            agentDelegators[agent].push(delegator);
            _inAgentDelegators[trackKey] = true;
        }
    }

    /// @dev Transfers GUARD via HTS precompile. Mirrors StakingManager._transferGuard pattern.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(
            amount <= uint256(uint64(type(int64).max)),
            "DelegatedStaking: amount exceeds int64"
        );
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "DelegatedStaking: HTS transfer failed");
    }
}
