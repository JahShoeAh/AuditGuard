// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// @notice Minimal read interface for StakingManager effective stake queries.
/// @dev Used by Treasury.calculateAgentFeeDiscount to check discount eligibility.
interface IStakingManager {
    function getEffectiveStake(address agent) external view returns (uint256);
}

/// @title AuditGuard Treasury
/// @notice Aggregates revenue from all five fee sources across the AuditGuard protocol,
///         provides transparent per-source accounting, distributes to UCP validators /
///         protocol reserve / burn, and centralises fee-discount logic for high-stake
///         high-reputation agents.
/// @dev Replaces the Day 1–2 deployer EOA "treasury" with a proper contract. All
///      governance-adjustable parameters are owner-gated for MVP; the spec envisions
///      agent-weighted DAO voting in production ("Agents vote on: Orchestrator Agent
///      fee structures").
///      Emits rich events consumed by the iNFT system (economic metrics), Frontend
///      (dashboard economics panel), and Agent Systems (discount eligibility).
contract Treasury is ReentrancyGuard, Ownable {
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

    /// @notice Origin category for incoming fee revenue.
    enum FeeSource {
        AUDIT_PLATFORM_FEE,
        DATA_MARKETPLACE_FEE,
        REPORT_AGENT_FEE,
        SLASHING_PROCEEDS,
        SUB_AUCTION_FEE
    }

    /// @notice Target bucket for outgoing distribution.
    enum DistributionTarget {
        UCP_VALIDATORS,
        PROTOCOL_RESERVE,
        BURN
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    /// @notice Immutable log entry for an incoming fee payment.
    struct RevenueRecord {
        /// @notice Which fee stream this revenue came from.
        FeeSource source;
        /// @notice GUARD amount received.
        uint256 amount;
        /// @notice Block timestamp of receipt.
        uint256 timestamp;
        /// @notice AuditAuction jobId context (0 if not job-specific).
        uint256 jobId;
        /// @notice Contract that sent the fee.
        address fromContract;
    }

    /// @notice Percentage split for distribution across the three targets.
    /// @dev Must sum to exactly 100.
    struct DistributionConfig {
        /// @notice Percentage allocated to UCP validators (e.g., 40).
        uint256 ucpValidatorsPercent;
        /// @notice Percentage allocated to protocol reserve (e.g., 50).
        uint256 protocolReservePercent;
        /// @notice Percentage allocated to burn / deflation (e.g., 10).
        uint256 burnPercent;
    }

    /// @notice Immutable log entry for a completed distribution event.
    struct DistributionRecord {
        /// @notice Auto-incrementing distribution identifier.
        uint256 distributionId;
        /// @notice Total GUARD distributed in this event.
        uint256 totalDistributed;
        /// @notice GUARD sent to UCP validators.
        uint256 ucpAmount;
        /// @notice GUARD sent to protocol reserve.
        uint256 reserveAmount;
        /// @notice GUARD sent to burn address.
        uint256 burnAmount;
        /// @notice Block timestamp of distribution.
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────
    //  State — Token & External Contracts
    // ──────────────────────────────────────────────

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice StakingManager contract for effective stake reads (discount eligibility).
    address public stakingManager;

    /// @notice AgentRegistry contract for reputation reads (discount eligibility).
    address public agentRegistry;

    // ──────────────────────────────────────────────
    //  State — Authorization
    // ──────────────────────────────────────────────

    /// @notice Contracts allowed to deposit fees: PaymentSettlement, DataMarketplace,
    ///         StakingManager, SubAuction, AuditAuction.
    mapping(address => bool) public authorizedSources;

    // ──────────────────────────────────────────────
    //  State — Distribution Configuration
    // ──────────────────────────────────────────────

    /// @notice Current percentage split across distribution targets.
    DistributionConfig public distributionConfig;

    /// @notice Address where UCP validator rewards accumulate (multisig or EOA for MVP).
    address public ucpValidatorPool;

    /// @notice Address for protocol reserve funds (development, bounties, grants).
    address public protocolReserve;

    /// @notice Address for token burn (0x...dead or equivalent; removes GUARD from
    ///         circulation for deflationary pressure).
    address public burnAddress;

    /// @notice Minimum pending balance that allows permissionless distribution.
    ///         100 GUARD (8 decimals) by default.
    uint256 public autoDistributeThreshold = 100 * 10 ** 8;

    // ──────────────────────────────────────────────
    //  State — Accounting
    // ──────────────────────────────────────────────

    /// @notice Lifetime GUARD received across all fee sources.
    uint256 public totalRevenue;

    /// @notice Lifetime GUARD distributed to targets.
    uint256 public totalDistributed;

    /// @notice GUARD waiting to be distributed.
    uint256 public pendingBalance;

    /// @notice Lifetime GUARD sent to the burn address.
    uint256 public totalBurned;

    /// @notice Running total of GUARD received per fee source.
    mapping(FeeSource => uint256) public revenueBySource;

    /// @notice Full chronological log of incoming fee payments.
    RevenueRecord[] internal _revenueHistory;

    /// @notice Next auto-incrementing distribution ID (starts at 1).
    uint256 public nextDistributionId = 1;

    /// @notice Distribution ID → full record.
    mapping(uint256 => DistributionRecord) public distributions;

    // ──────────────────────────────────────────────
    //  State — Discount Parameters
    // ──────────────────────────────────────────────

    /// @notice Minimum effective stake (GUARD, 8 decimals) for fee discount eligibility.
    ///         500 GUARD by default.
    uint256 public highStakeThreshold = 500 * 10 ** 8;

    /// @notice Minimum reputation score (basis points, 8500 = 85.00) for fee discount.
    uint256 public highReputationThreshold = 8500;

    /// @notice Discount magnitude in basis points (5000 = 50% off base fee).
    uint256 public discountBasisPoints = 5000;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when a fee payment is received from an authorized source.
    /// @dev [iNFT] Updates economic metrics on contract/agent iNFTs.
    ///      [Frontend] Live fee ticker on the dashboard economics panel.
    event FeeReceived(
        FeeSource indexed source,
        uint256 amount,
        uint256 jobId,
        address indexed fromContract
    );

    /// @notice Emitted when accumulated fees are distributed to targets.
    /// @dev [Frontend] Distribution event row in the economics panel history.
    event FeeDistributed(
        uint256 indexed distributionId,
        uint256 totalDistributed,
        uint256 ucpAmount,
        uint256 reserveAmount,
        uint256 burnAmount
    );

    /// @notice Emitted when the distribution percentage split is updated.
    event DistributionConfigUpdated(
        uint256 ucpPercent,
        uint256 reservePercent,
        uint256 burnPercent
    );

    /// @notice Emitted when distribution target addresses are updated.
    event DistributionTargetsUpdated(address ucpPool, address reserve, address burn);

    /// @notice Emitted when fee discount parameters are updated.
    event DiscountParametersUpdated(
        uint256 stakeThreshold,
        uint256 reputationThreshold,
        uint256 discountBasisPoints
    );

    /// @notice Emitted when a fee source contract is authorized.
    event SourceAuthorized(address indexed source);

    /// @notice Emitted when a fee source contract is revoked.
    event SourceRevoked(address indexed source);

    /// @notice Emitted when an emergency withdrawal is executed.
    event EmergencyWithdraw(address indexed to, uint256 amount);

    /// @notice Emitted when this contract is associated with the GUARD token on HTS.
    event GuardTokenAssociated(address indexed token);

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /// @notice Deploys the Treasury with initial distribution config (40/50/10).
    /// @param _guardToken GUARD token EVM address.
    /// @param _ucpValidatorPool Address for UCP validator reward accumulation.
    /// @param _protocolReserve Address for protocol reserve funds.
    /// @param _burnAddress Address for token burn (dead address).
    constructor(
        address _guardToken,
        address _ucpValidatorPool,
        address _protocolReserve,
        address _burnAddress
    ) Ownable(msg.sender) {
        require(_guardToken != address(0), "Treasury: guard token is zero");
        require(_ucpValidatorPool != address(0), "Treasury: ucp pool is zero");
        require(_protocolReserve != address(0), "Treasury: reserve is zero");
        require(_burnAddress != address(0), "Treasury: burn address is zero");

        guardToken = _guardToken;
        ucpValidatorPool = _ucpValidatorPool;
        protocolReserve = _protocolReserve;
        burnAddress = _burnAddress;

        // Default split: 40% validators, 50% reserve, 10% burn
        distributionConfig = DistributionConfig({
            ucpValidatorsPercent: 40,
            protocolReservePercent: 50,
            burnPercent: 10
        });
    }

    // ──────────────────────────────────────────────
    //  Fee Collection
    // ──────────────────────────────────────────────

    /// @notice Receives a fee payment from an authorized source contract.
    /// @dev [Frontend] FeeReceived event feeds the live fee ticker on the dashboard.
    ///      [iNFT] Updates economic metrics on contract and agent iNFTs.
    ///      The calling contract must have already approved or be the HTS sender.
    /// @param source Which fee stream this payment belongs to.
    /// @param amount GUARD amount in smallest units.
    /// @param jobId AuditAuction jobId context (0 if not job-specific).
    function receiveFee(
        FeeSource source,
        uint256 amount,
        uint256 jobId
    ) external nonReentrant {
        require(authorizedSources[msg.sender], "Treasury: not authorized source");
        require(amount > 0, "Treasury: amount is zero");

        _transferGuard(msg.sender, address(this), amount);

        totalRevenue += amount;
        pendingBalance += amount;
        revenueBySource[source] += amount;

        _revenueHistory.push(
            RevenueRecord({
                source: source,
                amount: amount,
                timestamp: block.timestamp,
                jobId: jobId,
                fromContract: msg.sender
            })
        );

        emit FeeReceived(source, amount, jobId, msg.sender);
    }

    // ──────────────────────────────────────────────
    //  Distribution
    // ──────────────────────────────────────────────

    /// @notice Distributes accumulated fees to UCP validators, protocol reserve, and burn.
    /// @dev Callable by owner at any time, or permissionlessly when pendingBalance exceeds
    ///      autoDistributeThreshold. This implements the spec's "5% platform fee distributed
    ///      to UCP validators and protocol treasury."
    ///      [Frontend] FeeDistributed event populates the distribution history table.
    function distribute() external nonReentrant {
        require(pendingBalance > 0, "Treasury: nothing to distribute");
        require(
            msg.sender == owner() || pendingBalance >= autoDistributeThreshold,
            "Treasury: below auto-distribute threshold"
        );

        uint256 amount = pendingBalance;

        uint256 ucpAmount = (amount * distributionConfig.ucpValidatorsPercent) / 100;
        uint256 reserveAmount = (amount * distributionConfig.protocolReservePercent) / 100;
        // Remainder to burn to avoid rounding dust loss
        uint256 burnAmt = amount - ucpAmount - reserveAmount;

        // Transfer to each target
        if (ucpAmount > 0) {
            _transferGuard(address(this), ucpValidatorPool, ucpAmount);
        }
        if (reserveAmount > 0) {
            _transferGuard(address(this), protocolReserve, reserveAmount);
        }
        if (burnAmt > 0) {
            _transferGuard(address(this), burnAddress, burnAmt);
            totalBurned += burnAmt;
        }

        totalDistributed += amount;
        pendingBalance = 0;

        uint256 distId = nextDistributionId++;
        distributions[distId] = DistributionRecord({
            distributionId: distId,
            totalDistributed: amount,
            ucpAmount: ucpAmount,
            reserveAmount: reserveAmount,
            burnAmount: burnAmt,
            timestamp: block.timestamp
        });

        emit FeeDistributed(distId, amount, ucpAmount, reserveAmount, burnAmt);
    }

    // ──────────────────────────────────────────────
    //  Fee Discount Calculation
    // ──────────────────────────────────────────────

    /// @notice Calculates a discounted fee for agents meeting stake + reputation thresholds.
    /// @dev [Agent Systems] PaymentSettlement and DataMarketplace call this to determine
    ///      fee reductions. Centralises discount logic so all contracts use consistent rules.
    ///      Per the spec: "High-stake, high-reputation agents get fee reductions on Report
    ///      Agent and Orchestrator services."
    ///      This is a read-only helper — the calling contract applies the discount.
    /// @param agent Agent wallet address to evaluate.
    /// @param baseFee Original fee amount before any discount.
    /// @return discountedFee Fee after discount (equals baseFee if agent doesn't qualify).
    function calculateAgentFeeDiscount(
        address agent,
        uint256 baseFee
    ) external view returns (uint256 discountedFee) {
        if (stakingManager == address(0) || agentRegistry == address(0)) {
            return baseFee;
        }

        uint256 effectiveStake = IStakingManager(stakingManager).getEffectiveStake(agent);
        uint256 reputation = IAgentRegistry(agentRegistry).getAgentReputation(agent);

        if (effectiveStake >= highStakeThreshold && reputation >= highReputationThreshold) {
            uint256 discount = (baseFee * discountBasisPoints) / 10000;
            return baseFee - discount;
        }

        return baseFee;
    }

    /// @notice Checks whether an agent qualifies for the fee discount tier.
    /// @dev [Frontend] Agent profile page shows discount eligibility status and
    ///      progress toward thresholds.
    /// @param agent Agent wallet address.
    /// @return eligible True if the agent meets both stake and reputation thresholds.
    /// @return currentStake Agent's current effective stake (GUARD).
    /// @return currentReputation Agent's current reputation score (basis points).
    function getDiscountEligibility(
        address agent
    )
        external
        view
        returns (bool eligible, uint256 currentStake, uint256 currentReputation)
    {
        if (stakingManager != address(0)) {
            currentStake = IStakingManager(stakingManager).getEffectiveStake(agent);
        }
        if (agentRegistry != address(0)) {
            currentReputation = IAgentRegistry(agentRegistry).getAgentReputation(agent);
        }

        eligible = currentStake >= highStakeThreshold &&
            currentReputation >= highReputationThreshold;
    }

    // ──────────────────────────────────────────────
    //  Governance / Admin
    // ──────────────────────────────────────────────

    /// @notice Sets the distribution percentage split across the three targets.
    /// @dev Must sum to exactly 100. For MVP, only callable by owner. In production,
    ///      this is the function DAO governance calls per the spec: "Agents vote on
    ///      Orchestrator Agent fee structures."
    /// @param ucpPercent Percentage for UCP validators.
    /// @param reservePercent Percentage for protocol reserve.
    /// @param burnPercent Percentage for burn.
    function setDistributionConfig(
        uint256 ucpPercent,
        uint256 reservePercent,
        uint256 burnPercent
    ) external onlyOwner {
        require(
            ucpPercent + reservePercent + burnPercent == 100,
            "Treasury: must sum to 100"
        );

        distributionConfig = DistributionConfig({
            ucpValidatorsPercent: ucpPercent,
            protocolReservePercent: reservePercent,
            burnPercent: burnPercent
        });

        emit DistributionConfigUpdated(ucpPercent, reservePercent, burnPercent);
    }

    /// @notice Sets the target addresses for distribution.
    /// @param _ucpValidatorPool UCP validator reward address.
    /// @param _protocolReserve Protocol reserve address.
    /// @param _burnAddress Burn / dead address.
    function setDistributionTargets(
        address _ucpValidatorPool,
        address _protocolReserve,
        address _burnAddress
    ) external onlyOwner {
        require(_ucpValidatorPool != address(0), "Treasury: ucp pool is zero");
        require(_protocolReserve != address(0), "Treasury: reserve is zero");
        require(_burnAddress != address(0), "Treasury: burn address is zero");

        ucpValidatorPool = _ucpValidatorPool;
        protocolReserve = _protocolReserve;
        burnAddress = _burnAddress;

        emit DistributionTargetsUpdated(_ucpValidatorPool, _protocolReserve, _burnAddress);
    }

    /// @notice Sets the fee discount eligibility parameters.
    /// @dev Per the spec: "High-stake, high-reputation agents get fee reductions."
    ///      Governance-adjustable for MVP (owner-gated).
    /// @param _stakeThreshold Minimum effective stake for discount eligibility.
    /// @param _reputationThreshold Minimum reputation for discount eligibility.
    /// @param _discountBasisPoints Discount magnitude (5000 = 50% off base fee).
    function setDiscountParameters(
        uint256 _stakeThreshold,
        uint256 _reputationThreshold,
        uint256 _discountBasisPoints
    ) external onlyOwner {
        require(_discountBasisPoints <= 10000, "Treasury: discount exceeds 100%");

        highStakeThreshold = _stakeThreshold;
        highReputationThreshold = _reputationThreshold;
        discountBasisPoints = _discountBasisPoints;

        emit DiscountParametersUpdated(_stakeThreshold, _reputationThreshold, _discountBasisPoints);
    }

    /// @notice Sets the threshold for permissionless auto-distribution.
    /// @param threshold Minimum pendingBalance (GUARD) that enables anyone to call distribute().
    function setAutoDistributeThreshold(uint256 threshold) external onlyOwner {
        autoDistributeThreshold = threshold;
    }

    /// @notice Authorises a contract to deposit fees via receiveFee().
    /// @param source Contract address to authorise.
    function addAuthorizedSource(address source) external onlyOwner {
        require(source != address(0), "Treasury: address is zero");
        authorizedSources[source] = true;
        emit SourceAuthorized(source);
    }

    /// @notice Revokes a contract's authorisation to deposit fees.
    /// @param source Contract address to revoke.
    function removeAuthorizedSource(address source) external onlyOwner {
        authorizedSources[source] = false;
        emit SourceRevoked(source);
    }

    /// @notice Sets the StakingManager contract address for discount calculations.
    /// @param _stakingManager StakingManager contract address.
    function setStakingManager(address _stakingManager) external onlyOwner {
        stakingManager = _stakingManager;
    }

    /// @notice Sets the AgentRegistry contract address for discount calculations.
    /// @param _agentRegistry AgentRegistry contract address.
    function setAgentRegistry(address _agentRegistry) external onlyOwner {
        agentRegistry = _agentRegistry;
    }

    /// @notice Emergency withdrawal for hackathon safety — recovers stuck funds.
    /// @param to Recipient address.
    /// @param amount GUARD to withdraw.
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Treasury: recipient is zero");
        require(amount > 0, "Treasury: amount is zero");

        _transferGuard(address(this), to, amount);

        // Adjust accounting to keep state consistent
        if (amount <= pendingBalance) {
            pendingBalance -= amount;
        } else {
            pendingBalance = 0;
        }

        emit EmergencyWithdraw(to, amount);
    }

    /// @notice Associates this contract with the GUARD token through HTS precompile.
    /// @dev Call post-deployment on Hedera JSON-RPC flows where constructor precompile
    ///      calls can revert.
    function associateGuardToken() external onlyOwner nonReentrant {
        int64 responseCode = HTS.tokenAssociate(address(this), guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "Treasury: token association failed"
        );
        emit GuardTokenAssociated(guardToken);
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    /// @notice Returns a full revenue breakdown by source.
    /// @dev [Frontend] THE function for the dashboard economics panel. Powers the
    ///      revenue pie chart showing contribution from each fee stream.
    /// @return total Lifetime total revenue.
    /// @return auditFees Revenue from audit platform fees.
    /// @return marketplaceFees Revenue from data marketplace fees.
    /// @return reportFees Revenue from report agent fees.
    /// @return slashingProceeds Revenue from slashing proceeds.
    /// @return subAuctionFees Revenue from sub-auction fees.
    function getRevenueBreakdown()
        external
        view
        returns (
            uint256 total,
            uint256 auditFees,
            uint256 marketplaceFees,
            uint256 reportFees,
            uint256 slashingProceeds,
            uint256 subAuctionFees
        )
    {
        total = totalRevenue;
        auditFees = revenueBySource[FeeSource.AUDIT_PLATFORM_FEE];
        marketplaceFees = revenueBySource[FeeSource.DATA_MARKETPLACE_FEE];
        reportFees = revenueBySource[FeeSource.REPORT_AGENT_FEE];
        slashingProceeds = revenueBySource[FeeSource.SLASHING_PROCEEDS];
        subAuctionFees = revenueBySource[FeeSource.SUB_AUCTION_FEE];
    }

    /// @notice Returns the current pending balance awaiting distribution.
    /// @return pending GUARD balance not yet distributed.
    function getPendingBalance() external view returns (uint256 pending) {
        return pendingBalance;
    }

    /// @notice Returns the current distribution configuration.
    /// @return config Current DistributionConfig struct.
    function getDistributionConfig()
        external
        view
        returns (DistributionConfig memory config)
    {
        return distributionConfig;
    }

    /// @notice Returns a paginated slice of distribution history.
    /// @dev [Frontend] Distribution history table in the economics panel.
    /// @param fromId Starting distribution ID (inclusive).
    /// @param count Maximum number of records to return.
    /// @return records Array of DistributionRecord structs.
    function getDistributionHistory(
        uint256 fromId,
        uint256 count
    ) external view returns (DistributionRecord[] memory records) {
        uint256 maxId = nextDistributionId - 1;
        if (fromId == 0 || fromId > maxId) {
            return new DistributionRecord[](0);
        }

        uint256 end = fromId + count;
        if (end > maxId + 1) end = maxId + 1;
        uint256 len = end - fromId;

        records = new DistributionRecord[](len);
        for (uint256 i = 0; i < len; i++) {
            records[i] = distributions[fromId + i];
        }
    }

    /// @notice Returns a paginated slice of the revenue event log.
    /// @dev [Frontend] Revenue event log with pagination support.
    /// @param fromIndex Starting array index (inclusive).
    /// @param count Maximum number of records to return.
    /// @return records Array of RevenueRecord structs.
    function getRevenueHistory(
        uint256 fromIndex,
        uint256 count
    ) external view returns (RevenueRecord[] memory records) {
        uint256 total = _revenueHistory.length;
        if (fromIndex >= total) {
            return new RevenueRecord[](0);
        }

        uint256 end = fromIndex + count;
        if (end > total) end = total;
        uint256 len = end - fromIndex;

        records = new RevenueRecord[](len);
        for (uint256 i = 0; i < len; i++) {
            records[i] = _revenueHistory[fromIndex + i];
        }
    }

    /// @notice Returns the lifetime total GUARD revenue.
    /// @return total Lifetime revenue.
    function getTotalRevenue() external view returns (uint256 total) {
        return totalRevenue;
    }

    /// @notice Returns the lifetime total GUARD distributed.
    /// @return total Lifetime distributed amount.
    function getTotalDistributed() external view returns (uint256 total) {
        return totalDistributed;
    }

    /// @notice Returns the lifetime total GUARD sent to the burn address.
    /// @dev [Frontend] Deflationary metric display on the dashboard.
    /// @return total Lifetime burned amount.
    function getTotalBurned() external view returns (uint256 total) {
        return totalBurned;
    }

    /// @notice Returns total revenue received within a time period.
    /// @dev [Frontend] Revenue chart with time-series data. Iterates the full revenue
    ///      history — suitable for off-chain eth_call but not for on-chain use with
    ///      very large histories.
    /// @param fromTimestamp Start of the period (inclusive).
    /// @param toTimestamp End of the period (inclusive).
    /// @return total GUARD received in the period.
    function getRevenueForPeriod(
        uint256 fromTimestamp,
        uint256 toTimestamp
    ) external view returns (uint256 total) {
        uint256 len = _revenueHistory.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 ts = _revenueHistory[i].timestamp;
            if (ts >= fromTimestamp && ts <= toTimestamp) {
                total += _revenueHistory[i].amount;
            }
        }
    }

    /// @notice Returns the total number of revenue records.
    /// @dev Useful for pagination — call before getRevenueHistory().
    /// @return count Number of revenue records.
    function getRevenueHistoryCount() external view returns (uint256 count) {
        return _revenueHistory.length;
    }

    // ──────────────────────────────────────────────
    //  Internal Helpers
    // ──────────────────────────────────────────────

    /// @dev Transfers GUARD via HTS precompile with int64 safety check.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(
            amount <= uint256(uint64(type(int64).max)),
            "Treasury: amount exceeds int64"
        );
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "Treasury: HTS transfer failed");
    }
}
