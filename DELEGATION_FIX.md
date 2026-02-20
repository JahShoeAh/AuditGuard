# Delegation HTS Transfer Fix

## Problem
The DelegatedStaking contract was failing with "HTS transfer failed" error during the delegation process (Stage 3).

## Root Cause
The contract was using Hedera's HTS precompile `HTS.transferToken()` which **does not respect ERC20 approvals**. When users approved the contract via ERC20 `approve()`, the approval wasn't recognized by the HTS precompile.

## Solution
Modified the `_transferGuard()` function in DelegatedStaking.sol to use standard ERC20 methods:
- `transferFrom()` for user → contract transfers (respects ERC20 approvals)
- `transfer()` for contract → user transfers

## Changes Made

### 1. Updated DelegatedStaking.sol
- Added `IERC20` import from OpenZeppelin
- Rewrote `_transferGuard()` to use ERC20 methods instead of HTS precompile
- Lines modified: 4-7, 918-926

### 2. Redeployed Contract
- **Old address**: `0xD7ECb236ABBC559A284921043e36D2962235f77C`
- **New address**: `0x1DBEf290A6cC26f8F48D68F6168Be4bD2b6ef815`
- Updated in `packages/sdk/config.json`

### 3. Associated GUARD Token
- Called `associateGuardToken()` on new contract (required for Hedera HTS)
- Transaction: `0x7cb011210f7e7690f2f7e38f48a90834160576a7b222947b142f4e5aa6408123`

### 4. Updated StakingManager
- Called `setDelegatedStaking()` to point to new contract address
- Ensures slash propagation works correctly

### 5. Restarted Dashboard
- Dashboard now uses new DelegatedStaking address from config

## Testing
1. Navigate to http://localhost:5173
2. Connect your wallet
3. Try staking HBAR to an agent
4. The flow should now complete all 4 stages:
   - ✓ Quoting exchange rate
   - ✓ Swapping HBAR → GUARD
   - ✓ Approving GUARD transfer
   - ✓ Delegating to agent

## Technical Details

### Before (HTS Precompile)
```solidity
function _transferGuard(address from, address to, uint256 amount) internal {
    require(amount <= uint256(uint64(type(int64).max)), "...");
    int64 responseCode = HTS.transferToken(guardToken, from, to, int64(uint64(amount)));
    require(responseCode == HTS_SUCCESS, "DelegatedStaking: HTS transfer failed");
}
```

### After (ERC20 Standard)
```solidity
function _transferGuard(address from, address to, uint256 amount) internal {
    if (from == address(this)) {
        // Contract → User: use transfer
        require(IERC20(guardToken).transfer(to, amount), "...");
    } else {
        // User → Contract: use transferFrom (respects approval)
        require(IERC20(guardToken).transferFrom(from, to, amount), "...");
    }
}
```

## Key Insight
On Hedera, HTS tokens support both HTS precompile methods AND ERC20 standard methods. For user interactions where approvals are involved, **always use ERC20 methods** for compatibility with standard wallet approvals.

## Note on Old Delegations
Any delegations made to the old contract address will NOT automatically migrate. For testnet/demo purposes, this is acceptable. Users will need to redelegate using the new contract.
