# Prompt 4 Implementation Log

Date: February 19, 2026  
Scope: Add three self-contained vulnerable test contracts and a deployment script.

## Files created

- `packages/contracts/contracts/test/VulnerableVault1.sol`
- `packages/contracts/contracts/test/VulnerableVault2.sol`
- `packages/contracts/contracts/test/VulnerableVault3.sol`
- `packages/contracts/scripts/deploy-test-contracts.js`

## What was implemented

### 1) `VulnerableVault1.sol`

Added a native ETH vault with:
- `deposit()` payable
- `withdraw(uint256)`
- `setOwner(address)` (no access control)
- `emergencyWithdraw()` with `onlyOwner`

Intentional vulnerability behaviors present:
- `withdraw` performs `call{value: amount}` before updating `balances`.
- `setOwner` is externally callable by any address.

### 2) `VulnerableVault2.sol`

Added a token staking contract with:
- `stake(uint256)`
- `unstake(uint256)`
- `claimRewards()`
- `accrueRewards(address)` internal

Intentional vulnerability behaviors present:
- Reward math uses `(rewardRate * elapsed * staked) / PRECISION`.
- Token movements use low-level `address(token).call(...)` and ignore success.

### 3) `VulnerableVault3.sol`

Added a collateralized borrow/liquidation contract with:
- `borrow(uint256)`
- `repay(uint256)`
- `liquidate(address)`
- `getAccountHealth(address)` view
- `IPriceOracle` interface

Intentional vulnerability behaviors present:
- `getSpotPrice()` reads single spot oracle value (no TWAP guard).
- `liquidate` has immediate execution path with no delay/commit-reveal controls.

### 4) `deploy-test-contracts.js`

Added Hardhat deployment script following existing script style:
- gets deployer from `hre.ethers.getSigners()`
- deploys all 3 contracts sequentially
- waits for each deployment
- logs deployed addresses
- prints final JSON payload:

```json
{
  "testContracts": [
    { "key": "vault1", "address": "...", "deployer": "..." },
    { "key": "vault2", "address": "...", "deployer": "..." },
    { "key": "vault3", "address": "...", "deployer": "..." }
  ]
}
```

## Verification

Compile command run:

```sh
npx hardhat compile
```

Run from:
- `packages/contracts`

Result:
- `Compiled 3 Solidity files successfully (evm target: shanghai).`

File presence check:
- Confirmed all 3 new files exist in `packages/contracts/contracts/test/`.

## Potential bugs / follow-up notes

### 1) `VulnerableVault2` requires post-deploy token configuration

Location:
- `packages/contracts/contracts/test/VulnerableVault2.sol`

Risk:
- If `setToken` is not called after deploy, staking actions revert due to unset token address.

### 2) `VulnerableVault3` requires post-deploy oracle configuration

Location:
- `packages/contracts/contracts/test/VulnerableVault3.sol`

Risk:
- If `setOracle` is not called after deploy, price-dependent paths (`borrow`, `liquidate`, health checks) revert.

### 3) Intentional vulnerabilities are active by design

Locations:
- `packages/contracts/contracts/test/VulnerableVault1.sol`
- `packages/contracts/contracts/test/VulnerableVault2.sol`
- `packages/contracts/contracts/test/VulnerableVault3.sol`

Note:
- Contracts intentionally include unsafe patterns for testing and should not be used in production deployments.

