// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Minimal interface for AuditGuard SubAuction reads
/// @notice PaymentSettlement uses this interface to log sub-job completions into the unified settlement ledger.
interface ISubAuction {
    /// @notice Lifecycle status for a sub-job.
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

    /// @notice Returns a sub-job by id.
    /// @param subJobId Sub-job id.
    /// @return job Full sub-job payload.
    function getSubJob(uint256 subJobId) external view returns (SubJob memory job);
}
