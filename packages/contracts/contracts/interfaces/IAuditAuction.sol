// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Minimal interface for AuditGuard AuditAuction reads
/// @notice SubAuction uses this interface to validate parent-job lineage and winner permissions.
interface IAuditAuction {
    /// @notice Lifecycle status for an audit job.
    enum JobStatus {
        AUCTION_OPEN,
        BIDDING_CLOSED,
        AUDITING_IN_PROGRESS,
        REPORT_PENDING,
        COMPLETED,
        CANCELLED
    }

    /// @notice Auction job metadata tracked on-chain.
    struct AuditJob {
        uint256 jobId;
        address contractAddress;
        string contractChain;
        uint256 discoveryTimestamp;
        uint256 auctionDeadline;
        uint256 initialRiskScore;
        uint256 budgetAvailable;
        uint256 lineCount;
        string contractType;
        JobStatus status;
        address[] winningAgents;
        uint256 totalEscrowedAmount;
        uint256 bidCount;
    }

    /// @notice Returns a job by id.
    /// @param jobId Job id.
    /// @return job Full job payload.
    function getJob(uint256 jobId) external view returns (AuditJob memory job);

    /// @notice Returns status for a job.
    /// @param jobId Job id.
    /// @return status Current job status.
    function getJobStatus(uint256 jobId) external view returns (JobStatus status);

    /// @notice Marks a job as COMPLETED after settlement.
    /// @param jobId Job id.
    function completeJob(uint256 jobId) external;
}
