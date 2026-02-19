// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title VulnerableVault2
/// @notice Lightweight staking pool with linear rewards.
/// @dev Rewards accrue over elapsed wall-clock time.
contract VulnerableVault2 {
    uint256 public constant PRECISION = 1e18;

    IERC20Minimal public token;
    address public owner;
    uint256 public rewardRate;
    uint256 public totalStaked;

    mapping(address => uint256) public stakeBalance;
    mapping(address => uint256) public unclaimedRewards;
    mapping(address => uint256) public lastAccruedAt;

    event TokenSet(address indexed token);
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event RewardsAccrued(address indexed account, uint256 amount, uint256 timestamp);
    event RewardsClaimed(address indexed account, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "VulnerableVault2: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        rewardRate = 1e16; // 1% base per second using PRECISION scaling assumptions
    }

    /// @notice Sets the staking token contract.
    /// @param tokenAddress ERC20 token address.
    function setToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "VulnerableVault2: zero token");
        token = IERC20Minimal(tokenAddress);
        emit TokenSet(tokenAddress);
    }

    /// @notice Updates global reward rate.
    /// @param newRewardRate Reward rate scalar.
    function setRewardRate(uint256 newRewardRate) external onlyOwner {
        uint256 oldRate = rewardRate;
        rewardRate = newRewardRate;
        emit RewardRateUpdated(oldRate, newRewardRate);
    }

    /// @notice Stakes token amount and starts / continues reward accrual.
    /// @param amount Token amount to stake.
    function stake(uint256 amount) external {
        require(amount > 0, "VulnerableVault2: amount is zero");
        require(address(token) != address(0), "VulnerableVault2: token not set");

        accrueRewards(msg.sender);

        stakeBalance[msg.sender] += amount;
        totalStaked += amount;
        lastAccruedAt[msg.sender] = block.timestamp;

        (bool ok, ) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, msg.sender, address(this), amount)
        );
        ok;

        emit Staked(msg.sender, amount);
    }

    /// @notice Unstakes token amount and keeps accrued rewards.
    /// @param amount Token amount to unstake.
    function unstake(uint256 amount) external {
        require(amount > 0, "VulnerableVault2: amount is zero");
        uint256 staked = stakeBalance[msg.sender];
        require(staked >= amount, "VulnerableVault2: insufficient stake");

        accrueRewards(msg.sender);

        stakeBalance[msg.sender] = staked - amount;
        totalStaked -= amount;
        lastAccruedAt[msg.sender] = block.timestamp;

        (bool ok, ) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, msg.sender, amount)
        );
        ok;

        emit Unstaked(msg.sender, amount);
    }

    /// @notice Claims any accrued reward balance.
    function claimRewards() external {
        accrueRewards(msg.sender);

        uint256 reward = unclaimedRewards[msg.sender];
        require(reward > 0, "VulnerableVault2: no rewards");

        unclaimedRewards[msg.sender] = 0;

        (bool ok, ) = address(token).call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, msg.sender, reward)
        );
        ok;

        emit RewardsClaimed(msg.sender, reward);
    }

    /// @notice Returns pending rewards including current interval.
    /// @param account User account.
    /// @return totalReward Combined accrued + pending rewards.
    function previewRewards(address account) external view returns (uint256 totalReward) {
        uint256 staked = stakeBalance[account];
        if (staked == 0) {
            return unclaimedRewards[account];
        }

        uint256 elapsed = block.timestamp - lastAccruedAt[account];
        uint256 pending = (rewardRate * elapsed * staked) / PRECISION;
        return unclaimedRewards[account] + pending;
    }

    /// @notice Updates reward state for account.
    /// @param account User account.
    function accrueRewards(address account) internal {
        uint256 staked = stakeBalance[account];
        if (staked == 0) {
            lastAccruedAt[account] = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - lastAccruedAt[account];
        if (elapsed == 0) return;

        uint256 pending = (rewardRate * elapsed * staked) / PRECISION;
        unclaimedRewards[account] += pending;
        lastAccruedAt[account] = block.timestamp;

        emit RewardsAccrued(account, pending, block.timestamp);
    }
}

