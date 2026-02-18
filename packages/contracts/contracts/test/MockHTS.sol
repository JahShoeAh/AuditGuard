// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockHTS — Local Hardhat mock of the Hedera Token Service precompile at 0x167.
/// @dev Deployed to 0x167 via hardhat_setCode in test setup. Always returns HTS_SUCCESS (22).
///      Tracks transfers for assertion in integration tests.
contract MockHTS {
    int64 internal constant HTS_SUCCESS = 22;

    struct Transfer {
        address token;
        address sender;
        address receiver;
        int64 amount;
    }

    Transfer[] public transfers;

    /// @notice Returns all recorded transfers for test assertions.
    function getTransfers() external view returns (Transfer[] memory) {
        return transfers;
    }

    /// @notice Returns the number of recorded transfers.
    function transferCount() external view returns (uint256) {
        return transfers.length;
    }

    /// @notice Clears recorded transfers between test cases.
    function clearTransfers() external {
        delete transfers;
    }

    /// @notice Mock transferToken — records transfer and returns HTS_SUCCESS.
    function transferToken(
        address token,
        address sender,
        address receiver,
        int64 amount
    ) external returns (int64 responseCode) {
        transfers.push(Transfer({
            token: token,
            sender: sender,
            receiver: receiver,
            amount: amount
        }));
        return HTS_SUCCESS;
    }

    /// @notice Mock tokenAssociate — always returns HTS_SUCCESS.
    function tokenAssociate(address, address) external pure returns (int64 responseCode) {
        return HTS_SUCCESS;
    }
}
