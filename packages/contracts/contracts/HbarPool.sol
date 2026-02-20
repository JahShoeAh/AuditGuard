// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title HbarPool — Fixed-rate HBAR/GUARD conversion pool
/// @notice Users deposit HBAR and receive GUARD internally (or vice versa).
///         GUARD is never held by users — this pool acts as the mint/burn layer.
/// @dev Fixed rate: 1 HBAR (1e8 tinybars) = RATE GUARD (in 8-decimal base units).
///      Pre-funded with GUARD tokens from the treasury. Holds HBAR as backing.
contract HbarPool is Ownable, ReentrancyGuard {
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));
    int64 internal constant HTS_SUCCESS = 22;
    int64 internal constant HTS_TOKEN_ALREADY_ASSOCIATED = 194;

    IERC20 public immutable guardToken;

    /// @notice Conversion rate: 1 HBAR = RATE GUARD (in human terms).
    ///         Both use 8 decimals on Hedera, so 1e8 tinybars = RATE * 1e8 GUARD base units.
    uint256 public constant RATE = 100;

    event HbarToGuard(address indexed caller, uint256 hbarAmount, uint256 guardAmount);
    event GuardToHbar(address indexed caller, address indexed recipient, uint256 guardAmount, uint256 hbarAmount);

    constructor(address _guardToken) Ownable(msg.sender) {
        require(_guardToken != address(0), "HbarPool: zero address");
        guardToken = IERC20(_guardToken);

        // Associate with GUARD token via HTS (required on Hedera before receiving tokens)
        int64 code = HTS.associateToken(address(this), _guardToken);
        require(
            code == HTS_SUCCESS || code == HTS_TOKEN_ALREADY_ASSOCIATED,
            "HbarPool: HTS association failed"
        );
    }

    // ── Conversion Functions ──────────────────────────────────

    /// @notice Deposit HBAR, receive GUARD tokens back to caller.
    /// @return guardAmount The GUARD amount sent to caller.
    function hbarToGuard() external payable nonReentrant returns (uint256 guardAmount) {
        require(msg.value > 0, "HbarPool: zero hbar");

        // msg.value is in tinybars (8 decimals) on Hedera
        guardAmount = msg.value * RATE;

        require(
            guardToken.balanceOf(address(this)) >= guardAmount,
            "HbarPool: insufficient GUARD reserve"
        );

        require(guardToken.transfer(msg.sender, guardAmount), "HbarPool: GUARD transfer failed");
        emit HbarToGuard(msg.sender, msg.value, guardAmount);
    }

    /// @notice Send GUARD, receive HBAR back to caller.
    /// @param guardAmount GUARD to convert (in 8-decimal base units).
    /// @return hbarAmount HBAR returned (in tinybars).
    function guardToHbar(uint256 guardAmount) external nonReentrant returns (uint256 hbarAmount) {
        require(guardAmount > 0, "HbarPool: zero guard");

        hbarAmount = guardAmount / RATE;
        require(hbarAmount > 0, "HbarPool: amount too small");
        require(address(this).balance >= hbarAmount, "HbarPool: insufficient HBAR reserve");

        require(
            guardToken.transferFrom(msg.sender, address(this), guardAmount),
            "HbarPool: GUARD transferFrom failed"
        );

        payable(msg.sender).transfer(hbarAmount);
        emit GuardToHbar(msg.sender, msg.sender, guardAmount, hbarAmount);
    }

    /// @notice Convert GUARD to HBAR and send to a specific recipient.
    ///         Used by DelegatedStaking to return HBAR directly to delegators.
    /// @param guardAmount GUARD to convert.
    /// @param recipient Address to receive the HBAR.
    /// @return hbarAmount HBAR sent to recipient.
    function guardToHbarFor(uint256 guardAmount, address recipient) external nonReentrant returns (uint256 hbarAmount) {
        require(guardAmount > 0, "HbarPool: zero guard");
        require(recipient != address(0), "HbarPool: zero recipient");

        hbarAmount = guardAmount / RATE;
        require(hbarAmount > 0, "HbarPool: amount too small");
        require(address(this).balance >= hbarAmount, "HbarPool: insufficient HBAR reserve");

        require(
            guardToken.transferFrom(msg.sender, address(this), guardAmount),
            "HbarPool: GUARD transferFrom failed"
        );

        payable(recipient).transfer(hbarAmount);
        emit GuardToHbar(msg.sender, recipient, guardAmount, hbarAmount);
    }

    // ── View Functions ────────────────────────────────────────

    /// @notice How much GUARD for a given HBAR amount (tinybars).
    function quoteGuardForHbar(uint256 hbarTinybars) external pure returns (uint256) {
        return hbarTinybars * RATE;
    }

    /// @notice How much HBAR (tinybars) for a given GUARD amount.
    function quoteHbarForGuard(uint256 guardAmount) external pure returns (uint256) {
        return guardAmount / RATE;
    }

    /// @notice Current pool reserves.
    function getReserves() external view returns (uint256 hbarReserve, uint256 guardReserve) {
        return (address(this).balance, guardToken.balanceOf(address(this)));
    }

    // ── Owner Functions ───────────────────────────────────────

    /// @notice Withdraw excess HBAR from pool.
    function withdrawHbar(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "HbarPool: insufficient balance");
        payable(owner()).transfer(amount);
    }

    /// @notice Withdraw excess GUARD from pool.
    function withdrawGuard(uint256 amount) external onlyOwner {
        require(guardToken.balanceOf(address(this)) >= amount, "HbarPool: insufficient balance");
        require(guardToken.transfer(owner(), amount), "HbarPool: transfer failed");
    }

    /// @notice Accept HBAR deposits to fund the pool.
    receive() external payable {}
}
