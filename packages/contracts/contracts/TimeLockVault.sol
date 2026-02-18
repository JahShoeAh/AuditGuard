// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ──────────────────────────────────────────────────────────────────────────────
// TimeLockVault — a simple HBAR time-lock vault for the AuditGuard demo.
//
// Users can deposit HBAR and set a lock duration. The funds are only
// withdrawable by the depositor after the lock expires.
//
// ⚠  INTENTIONAL RISK (for scanner/agent detection):
//    `emergencyWithdraw` is owner-only with NO time-gate, meaning the owner
//    can drain any deposit at will — a classic centralisation / rug risk.
//    Audit agents should flag this as HIGH severity.
//
// Deployed on Hedera testnet and used as a "real" target for the
// AuditGuard agent pipeline integration test.
// ──────────────────────────────────────────────────────────────────────────────

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TimeLockVault is ReentrancyGuard, Ownable {
    // ─── Structs ───────────────────────────────────────────────────────────

    struct Deposit {
        address depositor;
        uint256 amount;       // HBAR in tinybars (wei equivalent on Hedera)
        uint256 unlockAt;     // unix timestamp when funds become withdrawable
        bool    withdrawn;
    }

    // ─── State ─────────────────────────────────────────────────────────────

    /// @notice Sequential deposit counter (starts at 1).
    uint256 public nextDepositId;

    /// @notice All deposits indexed by ID.
    mapping(uint256 => Deposit) public deposits;

    /// @notice Total HBAR currently held in the vault (in tinybars).
    uint256 public totalLocked;

    // ─── Events ────────────────────────────────────────────────────────────

    /// @notice Emitted when HBAR is deposited.
    event Deposited(
        uint256 indexed depositId,
        address indexed depositor,
        uint256 amount,
        uint256 unlockAt
    );

    /// @notice Emitted when the depositor reclaims their funds after lock expires.
    event Withdrawn(
        uint256 indexed depositId,
        address indexed depositor,
        uint256 amount
    );

    /// @notice Emitted when the owner uses the emergency drain (⚠ centralisation risk).
    event EmergencyWithdrawn(
        uint256 indexed depositId,
        address indexed owner,
        uint256 amount
    );

    // ─── Constructor ───────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {
        nextDepositId = 1;
    }

    // ─── Core: Deposit ─────────────────────────────────────────────────────

    /// @notice Deposit HBAR and lock it for `lockDurationSeconds`.
    /// @param lockDurationSeconds  How many seconds until funds are withdrawable.
    /// @return depositId  The ID of the newly created deposit.
    function deposit(uint256 lockDurationSeconds)
        external
        payable
        nonReentrant
        returns (uint256 depositId)
    {
        require(msg.value > 0, "TimeLockVault: zero deposit");
        require(lockDurationSeconds > 0, "TimeLockVault: zero lock duration");

        depositId = nextDepositId++;
        uint256 unlockAt = block.timestamp + lockDurationSeconds;

        deposits[depositId] = Deposit({
            depositor: msg.sender,
            amount:    msg.value,
            unlockAt:  unlockAt,
            withdrawn: false
        });

        totalLocked += msg.value;

        emit Deposited(depositId, msg.sender, msg.value, unlockAt);
    }

    // ─── Core: Withdraw ────────────────────────────────────────────────────

    /// @notice Withdraw funds once the time-lock has expired.
    /// @param depositId  The deposit to withdraw from.
    function withdraw(uint256 depositId) external nonReentrant {
        Deposit storage dep = deposits[depositId];

        require(dep.depositor == msg.sender, "TimeLockVault: not depositor");
        require(!dep.withdrawn,              "TimeLockVault: already withdrawn");
        require(
            block.timestamp >= dep.unlockAt,
            "TimeLockVault: funds still locked"
        );

        dep.withdrawn = true;
        totalLocked  -= dep.amount;

        uint256 amount = dep.amount;
        // Effects before interactions (CEI pattern respected here)
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "TimeLockVault: transfer failed");

        emit Withdrawn(depositId, msg.sender, amount);
    }

    // ─── ⚠  RISK: Emergency Drain (owner, no time-gate) ───────────────────

    /// @notice Owner can withdraw any deposit at any time — no time-gate.
    /// @dev    This is an INTENTIONAL centralisation risk planted for the
    ///         AuditGuard agent pipeline to detect. In a production vault this
    ///         function would either be absent or guarded by a time-lock itself.
    /// @param depositId  The deposit to drain.
    function emergencyWithdraw(uint256 depositId) external onlyOwner nonReentrant {
        Deposit storage dep = deposits[depositId];

        require(!dep.withdrawn, "TimeLockVault: already withdrawn");
        require(dep.amount > 0, "TimeLockVault: nothing to withdraw");

        dep.withdrawn = true;
        totalLocked  -= dep.amount;

        uint256 amount = dep.amount;
        // Owner receives funds — bypasses depositor's time-lock
        (bool ok, ) = owner().call{value: amount}("");
        require(ok, "TimeLockVault: emergency transfer failed");

        emit EmergencyWithdrawn(depositId, owner(), amount);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    /// @notice Returns whether a deposit is currently locked.
    function isLocked(uint256 depositId) external view returns (bool) {
        Deposit storage dep = deposits[depositId];
        return !dep.withdrawn && block.timestamp < dep.unlockAt;
    }

    /// @notice Returns the time remaining until a deposit unlocks (0 if expired).
    function timeUntilUnlock(uint256 depositId) external view returns (uint256) {
        Deposit storage dep = deposits[depositId];
        if (dep.withdrawn || block.timestamp >= dep.unlockAt) return 0;
        return dep.unlockAt - block.timestamp;
    }

    /// @notice Convenience: full deposit info.
    function getDeposit(uint256 depositId)
        external
        view
        returns (
            address depositor,
            uint256 amount,
            uint256 unlockAt,
            bool    withdrawn,
            bool    locked
        )
    {
        Deposit storage dep = deposits[depositId];
        return (
            dep.depositor,
            dep.amount,
            dep.unlockAt,
            dep.withdrawn,
            !dep.withdrawn && block.timestamp < dep.unlockAt
        );
    }

    // ─── Fallback ──────────────────────────────────────────────────────────

    /// @dev Reject accidental plain HBAR sends (require deposit() call).
    receive() external payable {
        revert("TimeLockVault: use deposit()");
    }
}
