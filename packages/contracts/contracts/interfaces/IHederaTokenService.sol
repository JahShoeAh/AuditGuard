// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Minimal Hedera Token Service (HTS) precompile interface
/// @notice Used by AuditGuard contracts to move and associate GUARD tokens on Hedera.
interface IHederaTokenService {
    /// @notice Transfers fungible tokens between two accounts.
    /// @param token The token EVM address.
    /// @param sender The account debited.
    /// @param receiver The account credited.
    /// @param amount The amount to transfer, in token smallest units.
    /// @return responseCode Hedera response code.
    function transferToken(
        address token,
        address sender,
        address receiver,
        int64 amount
    ) external returns (int64 responseCode);

    /// @notice Associates an account with a token.
    /// @param account The account to associate.
    /// @param token The token EVM address.
    /// @return responseCode Hedera response code.
    function tokenAssociate(address account, address token) external returns (int64 responseCode);
}
