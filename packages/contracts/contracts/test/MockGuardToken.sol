// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockGuardToken — Standard ERC20 used as GUARD token in local Hardhat tests.
/// @dev Mints initialSupply to deployer. All test signers receive allocations in before().
contract MockGuardToken is ERC20 {
    constructor(string memory name, string memory symbol, uint256 initialSupply)
        ERC20(name, symbol)
    {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }
}
