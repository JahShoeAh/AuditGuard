// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHTSPrecompile {
    function associateToken(address account, address token) external returns (int64 responseCode);
}

IHTSPrecompile constant HTS = IHTSPrecompile(0x0000000000000000000000000000000000000167);

/// @title GuardExchange
/// @notice Minimal constant-product AMM for swapping HBAR <-> GUARD.
/// @dev HBAR and GUARD both use 8 decimals on Hedera testnet flows targeted here.
contract GuardExchange is Ownable, ReentrancyGuard {
    IERC20 public immutable guardToken;

    uint256 public hbarReserve;
    uint256 public guardReserve;

    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;

    event LiquidityAdded(
        uint256 hbarAdded,
        uint256 guardAdded,
        uint256 hbarReserve,
        uint256 guardReserve
    );
    event LiquidityRemoved(
        uint256 hbarRemoved,
        uint256 guardRemoved,
        uint256 hbarReserve,
        uint256 guardReserve
    );
    event Swap(
        address indexed sender,
        uint256 hbarIn,
        uint256 guardIn,
        uint256 hbarOut,
        uint256 guardOut
    );

    constructor(address _guardToken) Ownable(msg.sender) {
        require(_guardToken != address(0), "GuardExchange: guard token is zero");
        guardToken = IERC20(_guardToken);
        // On Hedera, a contract must be associated with an HTS token before it
        // can hold or transfer it. Response code 22 = SUCCESS.
        int64 code = HTS.associateToken(address(this), _guardToken);
        require(code == 22, "GuardExchange: HTS association failed");
    }

    function addLiquidity(uint256 guardAmount) external payable onlyOwner {
        require(msg.value > 0, "GuardExchange: zero hbar");
        require(guardAmount > 0, "GuardExchange: zero guard");

        bool ok = guardToken.transferFrom(msg.sender, address(this), guardAmount);
        require(ok, "GuardExchange: guard transferFrom failed");

        hbarReserve += msg.value;
        guardReserve += guardAmount;

        emit LiquidityAdded(msg.value, guardAmount, hbarReserve, guardReserve);
    }

    function removeLiquidity(uint256 hbarAmount, uint256 guardAmount) external onlyOwner {
        require(hbarAmount <= hbarReserve, "GuardExchange: hbar exceeds reserve");
        require(guardAmount <= guardReserve, "GuardExchange: guard exceeds reserve");

        hbarReserve -= hbarAmount;
        guardReserve -= guardAmount;

        payable(owner()).transfer(hbarAmount);
        bool ok = guardToken.transfer(owner(), guardAmount);
        require(ok, "GuardExchange: guard transfer failed");

        emit LiquidityRemoved(hbarAmount, guardAmount, hbarReserve, guardReserve);
    }

    function buyGuard(uint256 minGuardOut) external payable nonReentrant returns (uint256 guardOut) {
        require(msg.value > 0, "GuardExchange: zero hbar in");
        require(hbarReserve > 0 && guardReserve > 0, "GuardExchange: pool empty");

        guardOut = getAmountOut(msg.value, hbarReserve, guardReserve);
        require(guardOut >= minGuardOut, "GuardExchange: slippage");
        require(guardOut < guardReserve, "GuardExchange: insufficient liquidity");

        hbarReserve += msg.value;
        guardReserve -= guardOut;

        bool ok = guardToken.transfer(msg.sender, guardOut);
        require(ok, "GuardExchange: guard transfer failed");

        emit Swap(msg.sender, msg.value, 0, 0, guardOut);
    }

    function sellGuard(
        uint256 guardIn,
        uint256 minHbarOut
    ) external nonReentrant returns (uint256 hbarOut) {
        require(guardIn > 0, "GuardExchange: zero guard in");
        require(hbarReserve > 0 && guardReserve > 0, "GuardExchange: pool empty");

        hbarOut = getAmountOut(guardIn, guardReserve, hbarReserve);
        require(hbarOut >= minHbarOut, "GuardExchange: slippage");
        require(hbarOut < hbarReserve, "GuardExchange: insufficient liquidity");

        bool ok = guardToken.transferFrom(msg.sender, address(this), guardIn);
        require(ok, "GuardExchange: guard transferFrom failed");

        guardReserve += guardIn;
        hbarReserve -= hbarOut;

        payable(msg.sender).transfer(hbarOut);

        emit Swap(msg.sender, 0, guardIn, hbarOut, 0);
    }

    function quoteGuardOut(uint256 hbarIn) external view returns (uint256 guardOut) {
        if (hbarIn == 0 || hbarReserve == 0 || guardReserve == 0) {
            return 0;
        }
        return getAmountOut(hbarIn, hbarReserve, guardReserve);
    }

    function quoteHbarIn(uint256 guardOut) external view returns (uint256 hbarIn) {
        if (guardOut == 0 || hbarReserve == 0 || guardReserve == 0 || guardOut >= guardReserve) {
            return 0;
        }
        return getAmountIn(guardOut, hbarReserve, guardReserve);
    }

    function getRate() external view returns (uint256 hbarPerGuard) {
        if (guardReserve == 0) {
            return 0;
        }
        return (hbarReserve * 1e8) / guardReserve;
    }

    function getReserves() external view returns (uint256 _hbarReserve, uint256 _guardReserve) {
        return (hbarReserve, guardReserve);
    }

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "GuardExchange: zero amount in");
        require(reserveIn > 0 && reserveOut > 0, "GuardExchange: invalid reserves");

        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }

    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountIn) {
        require(amountOut < reserveOut, "GuardExchange: amount out too large");
        require(reserveIn > 0 && reserveOut > 0, "GuardExchange: invalid reserves");

        uint256 numerator = reserveIn * amountOut * BPS;
        uint256 denominator = (reserveOut - amountOut) * (BPS - FEE_BPS);
        return (numerator / denominator) + 1;
    }

    receive() external payable {
        revert("GuardExchange: use buyGuard()");
    }
}
