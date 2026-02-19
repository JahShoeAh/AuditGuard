// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VulnerableVault1
/// @notice Basic ETH vault with owner-managed emergency controls.
/// @dev Deposits are tracked per account for straightforward accounting.
contract VulnerableVault1 {
    address public owner;
    uint256 public totalDeposited;

    mapping(address => uint256) private balances;

    event Deposited(address indexed account, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed account, uint256 amount, uint256 remainingBalance);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event EmergencyWithdrawal(address indexed receiver, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "VulnerableVault1: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnerUpdated(address(0), msg.sender);
    }

    /// @notice Returns the tracked vault balance for an account.
    /// @param account User account.
    /// @return amount Tracked balance in wei.
    function balanceOf(address account) external view returns (uint256 amount) {
        amount = balances[account];
    }

    /// @notice Returns the contract's native balance.
    /// @return amount ETH held by the vault.
    function vaultBalance() external view returns (uint256 amount) {
        amount = address(this).balance;
    }

    /// @notice Deposits ETH and credits sender balance.
    function deposit() external payable {
        require(msg.value > 0, "VulnerableVault1: value is zero");
        balances[msg.sender] += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    /// @notice Supports direct ETH transfers.
    receive() external payable {
        require(msg.value > 0, "VulnerableVault1: value is zero");
        balances[msg.sender] += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    /// @notice Withdraws a requested amount of ETH from sender balance.
    /// @param amount Amount to withdraw in wei.
    function withdraw(uint256 amount) external {
        require(amount > 0, "VulnerableVault1: amount is zero");
        uint256 currentBalance = balances[msg.sender];
        require(currentBalance >= amount, "VulnerableVault1: insufficient balance");

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "VulnerableVault1: transfer failed");

        unchecked {
            balances[msg.sender] = currentBalance - amount;
            totalDeposited -= amount;
        }

        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Updates the owner account used by emergency operations.
    /// @param newOwner New owner address.
    function setOwner(address newOwner) external {
        require(newOwner != address(0), "VulnerableVault1: zero owner");
        address previous = owner;
        owner = newOwner;
        emit OwnerUpdated(previous, newOwner);
    }

    /// @notice Withdraws the full vault balance to owner for emergency handling.
    function emergencyWithdraw() external onlyOwner {
        uint256 amount = address(this).balance;
        require(amount > 0, "VulnerableVault1: vault empty");

        (bool sent, ) = payable(owner).call{value: amount}("");
        require(sent, "VulnerableVault1: emergency transfer failed");

        emit EmergencyWithdrawal(owner, amount);
    }
}

