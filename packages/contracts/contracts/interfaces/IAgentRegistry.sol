// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Minimal interface for AuditGuard AgentRegistry reads
/// @notice AuditAuction uses this interface to validate bidders and snapshot agent metadata.
interface IAgentRegistry {
    /// @notice Agent tier used by marketplace scoring logic.
    enum AgentTier {
        UNREGISTERED,
        COMMODITY,
        SPECIALIZED,
        PREMIUM
    }

    /// @notice Returns whether an agent is active and allowed to participate.
    /// @param agent Agent wallet address.
    /// @return active True if the agent is active.
    function isActiveAgent(address agent) external view returns (bool active);

    /// @notice Returns current tier for a given agent.
    /// @param agent Agent wallet address.
    /// @return tier Agent tier.
    function getAgentTier(address agent) external view returns (AgentTier tier);

    /// @notice Returns current reputation score for an agent.
    /// @param agent Agent wallet address.
    /// @return reputation Reputation basis points (0..10000).
    function getAgentReputation(address agent) external view returns (uint256 reputation);
}
