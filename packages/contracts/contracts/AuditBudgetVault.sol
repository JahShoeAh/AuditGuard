// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title AuditGuard Audit Budget Vault
/// @notice Developer-facing vault that funds autonomous auctions and audit payouts.
/// @dev The authorized drawer is expected to be the AuditAuction contract.
contract AuditBudgetVault is ReentrancyGuard, Ownable {
    /// @notice Hedera Token Service precompile address.
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    /// @dev Hedera response code constants.
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;
    uint256 internal constant WEEK = 7 days;

    /// @notice Vault configuration and accounting for a covered contract.
    struct VaultInfo {
        address contractAddress;
        address depositor;
        uint256 totalDeposited;
        uint256 currentBalance;
        uint256 weeklyMonitoringBudget;
        uint256 weeklyMonitoringSpent;
        uint256 weeklyResetTimestamp;
        uint256 criticalBountyAllocation;
        uint256 criticalBountySpent;
        uint256 lastAuditTimestamp;
        bool active;
    }

    /// @notice Vault storage by covered contract address.
    mapping(address => VaultInfo) public vaults;

    /// @notice GUARD token EVM address.
    address public guardToken;

    /// @notice Authorized drawer contract (AuditAuction).
    address public authorizedDrawer;

    /// @notice List of all vault contract addresses for enumeration.
    address[] public vaultList;

    /// @notice Emitted when a vault is created for a contract.
    event VaultCreated(
        address indexed contractAddress,
        address indexed depositor,
        uint256 weeklyMonitoringBudget,
        uint256 criticalBountyAllocation
    );

    /// @notice Emitted when new funds are added to a vault.
    event VaultDeposited(address indexed contractAddress, uint256 amount, uint256 newBalance);

    /// @notice Emitted when a standard audit payment is drawn.
    event PaymentDrawn(address indexed contractAddress, address indexed agent, uint256 amount);

    /// @notice Emitted when a monitoring payment is drawn under weekly limits.
    event MonitoringPaymentDrawn(
        address indexed contractAddress,
        address indexed agent,
        uint256 amount,
        uint256 weeklyRemaining
    );

    /// @notice Emitted when a critical bounty payment is drawn.
    event BountyDrawn(address indexed contractAddress, address indexed agent, uint256 amount, uint256 bountyRemaining);

    /// @notice Emitted when the depositor withdraws available funds.
    event VaultWithdrawal(address indexed contractAddress, uint256 amount);

    /// @notice Emitted when a vault's policy parameters are changed.
    event VaultRulesUpdated(address indexed contractAddress);

    /// @dev Restricts execution to the configured drawer contract.
    modifier onlyAuthorizedDrawer() {
        require(msg.sender == authorizedDrawer, "AuditBudgetVault: caller is not authorized drawer");
        _;
    }

    /// @notice Deploys vault contract and associates it to GUARD via HTS.
    /// @param _guardToken GUARD token EVM address.
    constructor(address _guardToken) Ownable(msg.sender) {
        require(_guardToken != address(0), "AuditBudgetVault: guard token is zero");
        guardToken = _guardToken;

        int64 responseCode = HTS.tokenAssociate(address(this), _guardToken);
        require(
            responseCode == HTS_SUCCESS || responseCode == HTS_TOKEN_ALREADY_ASSOCIATED,
            "AuditBudgetVault: token association failed"
        );
    }

    /// @notice Creates a vault for a covered smart contract.
    /// @dev This is the developer's primary human interaction in AuditGuard.
    /// @param contractAddress Smart contract address to cover.
    /// @param weeklyMonitoringBudget Max GUARD per 7-day window for monitoring.
    /// @param criticalBountyAllocation Reserved GUARD allocation for critical bounties.
    function createVault(address contractAddress, uint256 weeklyMonitoringBudget, uint256 criticalBountyAllocation) external {
        require(contractAddress != address(0), "AuditBudgetVault: contract is zero");
        require(vaults[contractAddress].depositor == address(0), "AuditBudgetVault: vault already exists");

        vaults[contractAddress] = VaultInfo({
            contractAddress: contractAddress,
            depositor: msg.sender,
            totalDeposited: 0,
            currentBalance: 0,
            weeklyMonitoringBudget: weeklyMonitoringBudget,
            weeklyMonitoringSpent: 0,
            weeklyResetTimestamp: block.timestamp,
            criticalBountyAllocation: criticalBountyAllocation,
            criticalBountySpent: 0,
            lastAuditTimestamp: 0,
            active: true
        });

        vaultList.push(contractAddress);

        emit VaultCreated(contractAddress, msg.sender, weeklyMonitoringBudget, criticalBountyAllocation);
    }

    /// @notice Deposits GUARD into a contract's vault.
    /// @dev Scanner agents can watch VaultDeposited to detect budget increases.
    /// @param contractAddress Covered contract address.
    /// @param amount GUARD amount in smallest units.
    function deposit(address contractAddress, uint256 amount) external nonReentrant {
        require(amount > 0, "AuditBudgetVault: amount is zero");
        VaultInfo storage vault = _getActiveVault(contractAddress);

        _transferGuard(msg.sender, address(this), amount);

        vault.totalDeposited += amount;
        vault.currentBalance += amount;

        // Route deposits to the configured critical bucket first conceptually (accounted by spend cap).
        if (vault.criticalBountyAllocation > vault.criticalBountySpent) {
            uint256 remainingCritical = vault.criticalBountyAllocation - vault.criticalBountySpent;
            if (amount >= remainingCritical) {
                // Remaining amount naturally contributes to general balance.
            }
        }

        emit VaultDeposited(contractAddress, amount, vault.currentBalance);
    }

    /// @notice Draws standard audit payment to an agent.
    /// @param contractAddress Covered contract address.
    /// @param agent Agent recipient.
    /// @param amount GUARD amount to draw.
    function drawPayment(address contractAddress, address agent, uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
    {
        require(agent != address(0), "AuditBudgetVault: agent is zero");
        require(amount > 0, "AuditBudgetVault: amount is zero");
        VaultInfo storage vault = _getActiveVault(contractAddress);
        require(vault.currentBalance >= amount, "AuditBudgetVault: insufficient balance");

        vault.currentBalance -= amount;
        vault.lastAuditTimestamp = block.timestamp;
        _transferGuard(address(this), agent, amount);

        emit PaymentDrawn(contractAddress, agent, amount);
    }

    /// @notice Draws monitoring payment subject to weekly policy limits.
    /// @param contractAddress Covered contract address.
    /// @param agent Agent recipient.
    /// @param amount GUARD amount to draw.
    function drawMonitoringPayment(address contractAddress, address agent, uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
    {
        require(agent != address(0), "AuditBudgetVault: agent is zero");
        require(amount > 0, "AuditBudgetVault: amount is zero");
        VaultInfo storage vault = _getActiveVault(contractAddress);
        require(vault.currentBalance >= amount, "AuditBudgetVault: insufficient balance");

        _resetWeeklyIfNeeded(vault);
        if (vault.weeklyMonitoringBudget != 0) {
            require(
                vault.weeklyMonitoringSpent + amount <= vault.weeklyMonitoringBudget,
                "AuditBudgetVault: weekly budget exceeded"
            );
        }

        vault.currentBalance -= amount;
        vault.weeklyMonitoringSpent += amount;
        vault.lastAuditTimestamp = block.timestamp;
        _transferGuard(address(this), agent, amount);

        emit MonitoringPaymentDrawn(contractAddress, agent, amount, _monitoringBudgetRemaining(vault));
    }

    /// @notice Draws a critical bounty payout subject to configured bounty allocation.
    /// @param contractAddress Covered contract address.
    /// @param agent Agent recipient.
    /// @param amount GUARD amount to draw.
    function drawBounty(address contractAddress, address agent, uint256 amount)
        external
        onlyAuthorizedDrawer
        nonReentrant
    {
        require(agent != address(0), "AuditBudgetVault: agent is zero");
        require(amount > 0, "AuditBudgetVault: amount is zero");
        VaultInfo storage vault = _getActiveVault(contractAddress);
        require(vault.currentBalance >= amount, "AuditBudgetVault: insufficient balance");
        require(
            vault.criticalBountySpent + amount <= vault.criticalBountyAllocation,
            "AuditBudgetVault: bounty allocation exceeded"
        );

        vault.currentBalance -= amount;
        vault.criticalBountySpent += amount;
        vault.lastAuditTimestamp = block.timestamp;
        _transferGuard(address(this), agent, amount);

        emit BountyDrawn(contractAddress, agent, amount, _bountyRemaining(vault));
    }

    /// @notice Withdraws excess vault funds back to the original depositor.
    /// @param contractAddress Covered contract address.
    /// @param amount GUARD amount to withdraw.
    function withdrawExcess(address contractAddress, uint256 amount) external nonReentrant {
        require(amount > 0, "AuditBudgetVault: amount is zero");
        VaultInfo storage vault = _getActiveVault(contractAddress);
        require(msg.sender == vault.depositor, "AuditBudgetVault: caller is not depositor");
        require(vault.currentBalance >= amount, "AuditBudgetVault: insufficient balance");

        vault.currentBalance -= amount;
        _transferGuard(address(this), vault.depositor, amount);

        emit VaultWithdrawal(contractAddress, amount);
    }

    /// @notice Updates monitoring and bounty policy parameters for a vault.
    /// @param contractAddress Covered contract address.
    /// @param newWeeklyMonitoringBudget Updated weekly monitoring budget.
    /// @param newCriticalBountyAllocation Updated critical bounty allocation.
    function updateVaultRules(
        address contractAddress,
        uint256 newWeeklyMonitoringBudget,
        uint256 newCriticalBountyAllocation
    ) external {
        VaultInfo storage vault = _getActiveVault(contractAddress);
        require(msg.sender == vault.depositor, "AuditBudgetVault: caller is not depositor");
        require(newCriticalBountyAllocation >= vault.criticalBountySpent, "AuditBudgetVault: below bounty spent");

        _resetWeeklyIfNeeded(vault);
        vault.weeklyMonitoringBudget = newWeeklyMonitoringBudget;
        vault.criticalBountyAllocation = newCriticalBountyAllocation;

        emit VaultRulesUpdated(contractAddress);
    }

    /// @notice Sets the authorized drawer contract (expected AuditAuction).
    /// @param _auctionContract Auction contract address.
    function setAuthorizedDrawer(address _auctionContract) external onlyOwner {
        require(_auctionContract != address(0), "AuditBudgetVault: drawer is zero");
        authorizedDrawer = _auctionContract;
    }

    /// @notice Returns the currently available vault balance.
    /// @param contractAddress Covered contract address.
    /// @return balance Current available GUARD balance.
    function getVaultBalance(address contractAddress) external view returns (uint256 balance) {
        return _getActiveVault(contractAddress).currentBalance;
    }

    /// @notice Returns full vault info for a covered contract.
    /// @param contractAddress Covered contract address.
    /// @return info Vault information.
    function getVaultInfo(address contractAddress) external view returns (VaultInfo memory info) {
        return _getActiveVault(contractAddress);
    }

    /// @notice Returns remaining weekly monitoring budget.
    /// @param contractAddress Covered contract address.
    /// @return remaining Remaining budget in current window.
    function getMonitoringBudgetRemaining(address contractAddress) external view returns (uint256 remaining) {
        VaultInfo storage vault = _getActiveVault(contractAddress);
        if (block.timestamp >= vault.weeklyResetTimestamp + WEEK) {
            return vault.weeklyMonitoringBudget;
        }
        return _monitoringBudgetRemaining(vault);
    }

    /// @notice Returns remaining critical bounty allocation.
    /// @param contractAddress Covered contract address.
    /// @return remaining Remaining bounty allocation.
    function getBountyRemaining(address contractAddress) external view returns (uint256 remaining) {
        return _bountyRemaining(_getActiveVault(contractAddress));
    }

    /// @notice Returns all created vault contract addresses.
    /// @return allVaults List of covered contract addresses with vaults.
    function getAllVaults() external view returns (address[] memory allVaults) {
        return vaultList;
    }

    /// @dev Returns active vault reference or reverts.
    function _getActiveVault(address contractAddress) internal view returns (VaultInfo storage vault) {
        vault = vaults[contractAddress];
        require(vault.active, "AuditBudgetVault: vault not active");
    }

    /// @dev Resets weekly monitoring accounting when window elapsed.
    function _resetWeeklyIfNeeded(VaultInfo storage vault) internal {
        if (block.timestamp >= vault.weeklyResetTimestamp + WEEK) {
            vault.weeklyMonitoringSpent = 0;
            vault.weeklyResetTimestamp = block.timestamp;
        }
    }

    /// @dev Computes monitoring budget remaining in current weekly window.
    function _monitoringBudgetRemaining(VaultInfo storage vault) internal view returns (uint256 remaining) {
        if (vault.weeklyMonitoringBudget == 0) {
            return vault.currentBalance;
        }
        if (vault.weeklyMonitoringSpent >= vault.weeklyMonitoringBudget) {
            return 0;
        }
        return vault.weeklyMonitoringBudget - vault.weeklyMonitoringSpent;
    }

    /// @dev Computes bounty allocation remaining.
    function _bountyRemaining(VaultInfo storage vault) internal view returns (uint256 remaining) {
        if (vault.criticalBountySpent >= vault.criticalBountyAllocation) {
            return 0;
        }
        return vault.criticalBountyAllocation - vault.criticalBountySpent;
    }

    /// @dev Calls HTS precompile to transfer GUARD between accounts.
    function _transferGuard(address from, address to, uint256 amount) internal {
        require(amount <= uint256(uint64(type(int64).max)), "AuditBudgetVault: amount exceeds int64");
        int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
        require(responseCode == HTS_SUCCESS, "AuditBudgetVault: HTS transfer failed");
    }
}
