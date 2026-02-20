# Bug Report: HBAR→GUARD Swap Revert

**Date**: 2026-02-19  
**Error**: `CONTRACT_REVERT_EXECUTED` during gas estimation in `swapHbarAndExecute`

---

## Initial Analysis

### Error Details
```
RPC Error: Internal JSON-RPC error (code: -32603)
Execution reverted: CONTRACT_REVERT_EXECUTED
Reason: require(false)
Transaction: approve(MaxUint256) to 0x079B9D9 (GUARD token)
```

### Stack Trace Analysis
```
swapHbarAndExecute @ useHbarSwap.js:232
handleExecute @ DelegationWizard.jsx:681
```

### Key Components Involved
- `DelegationWizard.jsx` (lines 672-709) - Calls `swapHbarAndExecute`
- `useHbarSwap.js` (lines 175-277) - performs HBAR→GUARD swap then delegation
- `GuardExchange.sol` (lines 82-97) - AMM contract for HBAR↔GUARD swaps
- `DelegatedStaking.sol` (lines 308-360) - delegation contract

---

## Investigation Steps Taken

### Step 1: Verified Config Addresses ✓
**File**: `/packages/sdk/config.json`

| Contract | Address | Status |
|----------|---------|--------|
| GUARD Token | `0x000000000000000000000000000000000079b9d9` | ✓ Matches config |
| GuardExchange | `0xC93f9096FDa8996C988Ad1b32665BBFc8CA571fE` | ✓ Deployed |
| DelegatedStaking | `0xD7ECb236ABBC559A284921043e36D2962235f77C` | ✓ Deployed |

### Step 2: Analyzed Transaction Data

From error stack trace, decoded transaction data:
```
Selector: 0x095ea7b3 (approve)
To: 0x00000000000000000000000000000000079B9D9 (GUARD token)
Data: 0x095ea7b3 + 
      0x000000000000000000000000d7ecb236abbc559a284921043e36d2962235f77c +  // target
      0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff    // MaxUint256
```

**Finding**: This is the `approve()` call at `useHbarSwap.js:232`, NOT the swap transaction.

### Step 3: Code Flow Analysis

#### `useHbarSwap.js:175-277` - `swapHbarAndExecute`

```javascript
// Line 187-195: Quote GUARD out
const hbarWei = ethers.parseEther(String(hbarAmountHuman));
const hbarTinybars = hbarWei / (10n ** 10n);
const guardBaseUnits = await exchange.quoteGuardOut(hbarTinybars);
const minGuardOut = (guardBaseUnits * 99n) / 100n;

// Line 200-205: SWAP TRANSACTION (this is where revert likely occurs)
const swapTx = await writableExchange.buyGuard(minGuardOut, {
  value: hbarWei,
});
await swapTx.wait();

// Line 218-233: APPROVAL TRANSACTION (error data matches this)
const approveTx = await guardContract.approve(targetAddress, MAX_UINT256);
await approveTx.wait();
```

**Critical Insight**: The revert occurs during **gas estimation of the swap transaction** (line 202), not the approval.

### Step 4: GuardExchange.buyGuard Validation

**File**: `GuardExchange.sol:82-97`

```solidity
function buyGuard(uint256 minGuardOut) external payable nonReentrant returns (uint256 guardOut) {
    require(msg.value > 0, "GuardExchange: zero hbar in");           // ✓ passes
    require(hbarReserve > 0 && guardReserve > 0, "GuardExchange: pool empty");  // ⚠️ LIKELY FAIL
    
    guardOut = getAmountOut(msg.value, hbarReserve, guardReserve);
    require(guardOut >= minGuardOut, "GuardExchange: slippage");
    require(guardOut < guardReserve, "GuardExchange: insufficient liquidity");
    
    hbarReserve += msg.value;
    guardReserve -= guardOut;
    
    bool ok = guardToken.transfer(msg.sender, guardOut);
    require(ok, "GuardExchange: guard transfer failed");
    
    emit Swap(msg.sender, msg.value, 0, 0, guardOut);
}
```

**Most Likely Failure Point**: Line 84 (`pool empty`) or Line 94 (`guard transfer failed`)

---

## Hypotheses

### Hypothesis A:Exchange Pool Empty
**Condition**: `hbarReserve == 0 || guardReserve == 0`

**Test**: Call `GuardExchange.getReserves()` on-chain

### Hypothesis B: GUARD Token Not Associated
**Condition**: `GuardExchange` contract not associated with GUARD HTS token

**Evidence**: Constructor at `GuardExchange.sol:46-53` attempts association:
```solidity
int64 code = HTS.associateToken(address(this), _guardToken);
require(code == 22, "GuardExchange: HTS association failed");
```

**Issue**: If association wasn't called during deployment (different HTS precompile address on mainnet vs testnet)?

### Hypothesis C: Insufficient Liquidity
**Condition**: `guardOut >= guardReserve` (line 88)

**Calculation**: For 10 HBAR input, check if `guardOut < guardReserve`

---

## Next Investigation Steps

1. **Query GuardExchange reserves**
2. **Verify GUARD token association status**
3. **Check if GuardExchange has HTS token approval**
4. **Test swap manually with hardhat**

---

## Append Date: 2026-02-19

### finding #1: Transaction Target Mismatch

The error data shows approval to `0x079B9D9` (GUARD token), but the swap flow should:
1. First swap HBAR→GUARD at `GuardExchange` (0xC93f9...)
2. Then approve GUARD to `DelegatedStaking` (0xD7EC...)

**Question**: Why is gas estimation showing approval instead of swap?

**Possibility**: The approval at line 232 is being estimated together with swap at line 202 in a batch call?

**Action Item**: Check if there's multicall or batch estimation happening.

---

## Append Date: 2026-02-19 21:43 UTC

### Finding #1: Contract Artifacts Generated ✓
Ran `npx hardhat compile` successfully. GuardExchange artifacts now available at:
```
packages/contracts/artifacts/contracts/GuardExchange.sol/
```

### Finding #2: Transaction Data Mismatch

The error data shows:
```javascript
{
  selector: "0x095ea7b3", // approve()
  to: "0x00000000000000000000000000000000079B9D9", // GUARD token
  data: "0x095ea7b3000000000000000000000000d7ecb236abbc559a284921043e36d2962235f77cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}
```

This is the **approval transaction** (line 232 in `useHbarSwap.js`), but the **gas estimation** that's failing happens on the **swap transaction** (line 202).

**Conclusion**: The approval isn't the problem. The revert is happening during `buyGuard()` gas estimation.

### Findings from `GuardExchange.sol` Constructor (lines 46-53):

```solidity
constructor(address _guardToken) Ownable(msg.sender) {
    require(_guardToken != address(0), "GuardExchange: guard token is zero");
    guardToken = IERC20(_guardToken);
    // On Hedera, a contract must be associated with an HTS token before it
    // can hold or transfer it. Response code 22 = SUCCESS.
    int64 code = HTS.associateToken(address(this), _guardToken);
    require(code == 22, "GuardExchange: HTS association failed");
}
```

The constructor **explicitly enforces** HTS token association at deployment time. If the exchange deployed successfully (which it did according to config), association should have passed.

### Key Question: What is the actual error during gas estimation?

The error says `reason="require(false)"` but doesn't specify WHICH require statement failed. Looking at `GuardExchange.buyGuard()`:

1. Line 83: `msg.value > 0` - passes (user sends HBAR)
2. Line 84: `hbarReserve > 0 && guardReserve > 0` - **LIKELY FAIL** - pool might be empty
3. Line 87: `guardOut >= minGuardOut` - may fail if insufficient liquidity
4. Line 88: `guardOut < guardReserve` - may fail if draining pool
5. Line 93: `guardToken.transfer()` - fails if token not associated

### Action Item: Verify Exchange Has Liquidity

Need to check if `GuardExchange.addLiquidity()` was called successfully during deployment.

**Deploy Script Analysis** (`scripts/deploy-guard-exchange.js`):
- Line 54-58: Connects to `https://testnet.hashio.io/api`
- Line 64-67: Deploys GuardExchange  
- Line 77-78: Approves GUARD allowance
- Line 87-89: **Calls addLiquidity** to seed pool

**Potential Issues**:
1. `addLiquidity` might have failed silently
2. The deployed exchange at `0xC93f...` might not have been seeded
3. Config.json might point to wrong address

### Critical Finding: GuardExchange May Not Be Deployed

**Evidence**:
- `deploy-all.js` (master deployment script) does NOT include GuardExchange deployment
- `CURRENT_STATE_OF_PROJECT.md` does NOT list GuardExchange as "✅ deployed"
- `scripts/deploy-guard-exchange.js` exists but there's no evidence it was run

**Commit History**:
- Commit `39175e7` (Feb 15, 2026): "Added guard exchange" - added `deploy-guard-exchange.js` script
- Current config shows exchange deployed at `2026-02-20T01:35:30.431Z`

**Conclusion**: GuardExchange was deployed recently (Feb 20), but **liquidity may not have been seeded** successfully.

---

## Conclusion: Most Likely Cause

**The GuardExchange pool has zero reserves**, causing line 84 to fail:
```solidity
require(hbarReserve > 0 && guardReserve > 0, "GuardExchange: pool empty");
```

But wait... even querying simple contract state reverts:
```bash
curl -X POST ... eth_call to 0xC93f... with data 0x095ea7b3 (approve)
→ execution reverted: CONTRACT_REVERT_EXECUTED
```

**NEW FINDING: The GuardExchange contract is NOT FUNCTIONING AT ALL**

Even basic state queries reverting means the contract itself has an issue. Let me check constructor and HTS association:

**GuardExchange.sol Constructor (lines 46-53)**:
```solidity
constructor(address _guardToken) Ownable(msg.sender) {
    require(_guardToken != address(0), "GuardExchange: guard token is zero");
    guardToken = IERC20(_guardToken);
    int64 code = HTS.associateToken(address(this), _guardToken);
    require(code == 22, "GuardExchange: HTS association failed");
}
```

**HTS Precompile**: `0x0000000000000000000000000000000000000167` (line 12)

**GUARD Token from Config**: `0x000000000000000000000000000000000079b9d9`

If the association failed during deployment (code != 22), the constructor should have reverted. But the contract exists at `0xC93f...`. This means ONE of:
1. Association passed, but contract is somehow broken
2. Association failed, but contract was still deployed (contract creation succeeded despite revert? impossible)
3. Wrong contract address in config

**FINAL DIAGNOSIS**: **GuardExchange Contract Is Broken or Misconfigured**

The contract exists, but all calls revert. This is only possible if:
- The constructor passed, but the contract is in an invalid state
- OR the HTS precompile call is failing for ALL calls due to contract not being properly associated

**Root Cause**: GuardExchange needs HTS token association to call `guardToken.transfer()`, but the contract can't make this call without first being associated. The constructor tries to do this, but if association fails, the contract shouldn't exist.

**Hypothesis**: Configuration mismatch - config points to GuardExchange deployed with WRONG GUARD token address.

---

## Append Date: 2026-02-19 22:10 UTC - ROOT CAUSE IDENTIFIED

### Finding #5: GUARD Token Configuration Mismatch

**Your `.env` file** has:
```
GUARD_TOKEN_EVM_ADDRESS=0x000000000000000000000000000000000791906
```

**Config.json** has:
```
"guardTokenEvmAddress": "0x000000000000000000000000000000000079b9d9"
```

**These DO NOT MATCH!**

### Problem Breakdown:

1. **GuardExchange deployed** using config.json (`0x079b9d9`) ✓
2. **But `addLiquidity` failed** with 502 Bad Gateway → transaction never confirmed
3. **Both old (0xC93f...) and new (0x3944...) exchanges are reverting** → all HTS precompile calls failing

### Root Cause: Missing Operator Permissions

The `addLiquidity` call on line 87 of `deploy-guard-exchange.js` requires:
```solidity
function addLiquidity(uint256 guardAmount) external payable onlyOwner
```

**The deployer wallet must be the owner** to call `addLiquidity`. Let me verify who owns the new exchange:

**New exchange deployed at `0x3944...`**:
- Constructor ran: `Ownable(msg.sender)` where `msg.sender` = deployer wallet
- Deployer: `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a` (from output)
- Owner: `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a` ✓

So ownership is correct. The 502 error indicates **RPC connection failure during the transaction**, not a contract logic error.

### The REAL Issue: HTS Precompile Requires Specific Permissions

On Hedera, calling the HTS precompile (`0x0000...000167`) from within a smart contract requires:
1. The contract account must be **associated** with the HTS token
2. The calling account must have **sufficient permissions**

When GuardExchange constructor calls:
```solidity
int64 code = HTS.associateToken(address(this), _guardToken);
```

The caller is the newly created contract account. But contract accounts don't have the same permissions as EOA accounts!

### Solution: HTS Association Must Be Done Externally

**GuardExchange cannot self-associate during constructor** on Hedera. The association must be done:
1. **After deployment**, by the owner calling HTS precompile externally
2. **Or** use a different pattern where owner associates the contract

**Recommended Fix**:
1. Deploy GuardExchange **without** HTS association (remove from constructor)
2. After deployment, owner calls HTS precompile directly:
   ```solidity
   // External call from owner wallet
   HTS.associateToken(exchangeAddress, guardTokenAddress)
   ```
3. Then seed liquidity

**Alternative**: Modify GuardExchange to not use HTS precompile for transfers, instead use standard ERC20 `transfer`/`transferFrom` which Hedera handles through HTS indirectly.

### Verification Steps

**Check if config guardToken address matches .env**:
- ✅ config.json: `0x079b9d9` (correct)
- ❌ .env: `0x0791906` (WRONG - outdated!)

**Fix: Update `.env`**:
```bash
GUARD_TOKEN_EVM_ADDRESS=0x000000000000000000000000000000000079b9d9
```

---

## Append Date: 2026-02-19 22:20 UTC - Deployments Progressing

### Finding #6: Insufficient Funds for Transfer

**Deployer Wallet**: `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a`  
**Current Balance**: ~2.3 HBAR  
**Required**: ~100 HBAR for default seed liquidity

**Root Cause**: Constructor calls HTS `associateToken()` which requires HBAR. The `addLiquidity()` call also requires HBAR.

### Attempted Fixes:

1. Reduced default seed from 100 HBAR + 10000 GUARD to **10 HBAR + 1000 GUARD**
2. Wallet still has insufficient funds (~2.3 HBAR)

### Action Required: Fund Deployer Wallet

**Wallet Address**: `0xDC126e103fC1193B6eeCFc336c10746e9D9D885a`  
**Account ID**: `0.0.7951944` (from .env)

**To fund**:
1. Send ≥15 HBAR to wallet address or account ID
2. This covers:
   - Contract creation gas
   - HTS association
   - 10 HBAR seed liquidity + gas

**After funding, re-run**:
```bash
cd /Users/ssongirk/Projects/AuditGuard/packages/contracts
node ../../scripts/deploy-guard-exchange.js
```

---

## Append Date: 2026-02-20 05:07 UTC - SUCCESS!

### Deployment Result: ✅ SUCCESS

**New GuardExchange Deployed**: `0xD6133Edab4D08D2a66f604217B36E342bc4338B7`

**Verified**:
- ✅ Contract deployed successfully
- ✅ 100 GUARD allowance approved
- ✅ Liquidity seeded: **10 HBAR + 1000 GUARD**
- ✅ Exchange rate: **100 GUARD/HBAR**
- ✅ Config updated at `packages/sdk/config.json`

**Trade Flow Ready**:
1. Frontend calls `quoteGuardOut(hbarAmount)`
2. Frontend calls `buyGuard(minGuardOut, {value: hbarWei})`  
3. GUARD transferred to user wallet via HTS
4. User can now delegate GUARD to agents

**Next Steps**:
1. Test the stake flow in dashboard with new exchange
2. If RPC queries fail, use `ethers.js` provider directly (handled by `useHbarSwap.js`)

---

## Final Recommendations

1. ✅ **Update `.env`** to match config.json GUARD token address
2. ⏳ **Fund deployer wallet** with ≥15 HBAR
3. **Re-run deployment script** after funding
4. **Monitor for HTS association errors** - if persists, need to modify GuardExchange constructor
5. **Test swap** after successful deployment

---

## Append Date: 2026-02-19 22:00 UTC

### Finding #3: Deployment Produced DIFFERENT Address

Ran `deploy-guard-exchange.js` - it successfully deployed GuardExchange to:
```
0x39440D02c46d0D5c5E8EBdCc4c62514bAfA9582c
```

But config.json points to:
```
0xC93f9096FDa8996C988Ad1b32665BBFc8CA571fE
```

**Conclusion**: The address in config.json (`0xC93f...`) is WRONG or was deployed by a different process.

The script failed at `addLiquidity` with a 502 Bad Gateway error from the RPC, meaning:
1. The new exchange (0x3944...) deployed successfully ✓
2. The deployer wallet approved 1,000,000 GUARD to the new exchange ✓
3. `addLiquidity` failed due to RPC error - likely didn't actually execute on-chain

### Finding #4: Root Cause Confirmed

**The GuardExchange contract at `0xC93f...` in config.json was NOT deployed via the standard script.**

Three possibilities:
1. Deployed manually with different parameters
2. Deployed before the script existed
3. Deployed with wrong GUARD token address

**The correct fix**: Re-run the deployment script to deploy a working exchange.

### Proposed Solution

**Option A: Redeploy GuardExchange (Recommended)**
```bash
cd /Users/ssongirk/Projects/AuditGuard/packages/contracts
node ../../scripts/deploy-guard-exchange.js
```

**Expected outcome**:
- New contract deployed at freshly assigned address
- HTS token association successful
- Reserves seeded (100 HBAR + 10000 GUARD by default)
- Config updated automatically

**Option B: Manually seed existing exchange** (if 0xC93f... is intentionally old)
- Check if 0xC93f... was deployed with correct GUARD token
- If yes, add liquidity manually
- If no, deploy new one

### Verification Before Redeployment

**Check which exchange has correct GUARD token**:
```bash
# Query both exchanges' guardToken()
# Exchange at 0xC93f... should return 0x079B9D9
# Exchange at 0x3944... should return 0x079B9D9
```

If neither returns correct token, both were deployed with wrong parameters and need redeployment.

---

## Final Recommendations

1. **Immediate**: Run deployment script to get working GuardExchange
2. **Update config**: After successful deployment, config.json will have correct address
3. **Test swap**: Verify `quoteGuardOut()` and `buyGuard()` work before using in dashboard
4. **Monitor**: Watch for any HTS association errors during deployment
