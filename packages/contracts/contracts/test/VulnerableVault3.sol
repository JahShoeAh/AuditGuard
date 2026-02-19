// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceOracle {
    function getSpotPrice() external view returns (uint256);
}

/// @title VulnerableVault3
/// @notice Minimal collateralized borrowing pool with liquidations.
/// @dev Uses spot pricing from a configured oracle source.
contract VulnerableVault3 {
    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant BORROW_LTV_BPS = 7000;
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 8000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 10500;

    address public owner;
    IPriceOracle public oracle;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public debtBalance;

    event OracleUpdated(address indexed newOracle);
    event CollateralDeposited(address indexed account, uint256 amount);
    event CollateralWithdrawn(address indexed account, uint256 amount);
    event Borrowed(address indexed account, uint256 amount, uint256 totalDebt);
    event Repaid(address indexed account, uint256 amount, uint256 remainingDebt);
    event Liquidated(
        address indexed borrower,
        address indexed liquidator,
        uint256 repaidDebt,
        uint256 collateralSeized,
        uint256 spotPriceUsed
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "VulnerableVault3: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Assigns the oracle contract used for collateral pricing.
    /// @param oracleAddress Oracle contract address.
    function setOracle(address oracleAddress) external onlyOwner {
        require(oracleAddress != address(0), "VulnerableVault3: zero oracle");
        oracle = IPriceOracle(oracleAddress);
        emit OracleUpdated(oracleAddress);
    }

    /// @notice Deposits native collateral.
    function depositCollateral() external payable {
        require(msg.value > 0, "VulnerableVault3: value is zero");
        collateralBalance[msg.sender] += msg.value;
        emit CollateralDeposited(msg.sender, msg.value);
    }

    /// @notice Withdraws collateral while preserving account health.
    /// @param amount Amount of collateral to withdraw.
    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "VulnerableVault3: amount is zero");
        uint256 collateral = collateralBalance[msg.sender];
        require(collateral >= amount, "VulnerableVault3: insufficient collateral");

        collateralBalance[msg.sender] = collateral - amount;
        require(
            debtBalance[msg.sender] == 0 || getAccountHealth(msg.sender) >= PRICE_SCALE,
            "VulnerableVault3: health too low"
        );

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "VulnerableVault3: withdraw transfer failed");
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Borrows pool liquidity against posted collateral.
    /// @param amount Amount to borrow.
    function borrow(uint256 amount) external {
        require(amount > 0, "VulnerableVault3: amount is zero");
        require(address(this).balance >= amount, "VulnerableVault3: insufficient pool liquidity");

        uint256 collateralValue = (collateralBalance[msg.sender] * getSpotPrice()) / PRICE_SCALE;
        uint256 maxBorrow = (collateralValue * BORROW_LTV_BPS) / 10_000;
        require(debtBalance[msg.sender] + amount <= maxBorrow, "VulnerableVault3: borrow limit exceeded");

        debtBalance[msg.sender] += amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "VulnerableVault3: borrow transfer failed");
        emit Borrowed(msg.sender, amount, debtBalance[msg.sender]);
    }

    /// @notice Repays outstanding debt.
    /// @param amount Repayment amount in native token.
    function repay(uint256 amount) external payable {
        require(amount > 0, "VulnerableVault3: amount is zero");
        require(msg.value == amount, "VulnerableVault3: invalid msg.value");

        uint256 debt = debtBalance[msg.sender];
        require(debt > 0, "VulnerableVault3: no debt");

        if (amount >= debt) {
            debtBalance[msg.sender] = 0;
            uint256 refund = amount - debt;
            if (refund > 0) {
                (bool refunded, ) = payable(msg.sender).call{value: refund}("");
                require(refunded, "VulnerableVault3: refund failed");
            }
            emit Repaid(msg.sender, debt, 0);
            return;
        }

        debtBalance[msg.sender] = debt - amount;
        emit Repaid(msg.sender, amount, debtBalance[msg.sender]);
    }

    /// @notice Liquidates an unhealthy borrower by repaying debt for collateral.
    /// @param borrower Borrower account to liquidate.
    function liquidate(address borrower) external payable {
        require(borrower != address(0), "VulnerableVault3: zero borrower");
        require(borrower != msg.sender, "VulnerableVault3: self liquidation");

        uint256 debt = debtBalance[borrower];
        require(debt > 0, "VulnerableVault3: no debt");
        require(getAccountHealth(borrower) < PRICE_SCALE, "VulnerableVault3: account healthy");
        require(msg.value >= debt, "VulnerableVault3: insufficient repayment");

        debtBalance[borrower] = 0;

        uint256 collateral = collateralBalance[borrower];
        uint256 seizeAmount = (collateral * LIQUIDATION_BONUS_BPS) / 10_000;
        if (seizeAmount > collateral) seizeAmount = collateral;

        collateralBalance[borrower] = collateral - seizeAmount;

        (bool sent, ) = payable(msg.sender).call{value: seizeAmount}("");
        require(sent, "VulnerableVault3: seize transfer failed");

        if (msg.value > debt) {
            (bool refunded, ) = payable(msg.sender).call{value: msg.value - debt}("");
            require(refunded, "VulnerableVault3: repayment refund failed");
        }

        emit Liquidated(borrower, msg.sender, debt, seizeAmount, getSpotPrice());
    }

    /// @notice Returns account health ratio where 1e18 is liquidation boundary.
    /// @param account Borrower account.
    /// @return health Health factor scaled by 1e18.
    function getAccountHealth(address account) public view returns (uint256 health) {
        uint256 debt = debtBalance[account];
        if (debt == 0) return type(uint256).max;

        uint256 collateralValue = (collateralBalance[account] * getSpotPrice()) / PRICE_SCALE;
        uint256 adjustedCollateral = (collateralValue * LIQUIDATION_THRESHOLD_BPS) / 10_000;
        health = (adjustedCollateral * PRICE_SCALE) / debt;
    }

    /// @notice Reads current oracle spot price.
    /// @return price Current spot price in 1e18 scale.
    function getSpotPrice() public view returns (uint256 price) {
        require(address(oracle) != address(0), "VulnerableVault3: oracle not set");
        price = oracle.getSpotPrice();
    }
}

