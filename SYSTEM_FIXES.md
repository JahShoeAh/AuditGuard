# AuditGuard System Fixes & Setup Guide

This document provides detailed implementation steps to fix the GUARD economy, test IPFS integration, and update the 0g inference LLM.

---

## Table of Contents

1. [GUARD Economy Fixes](#1-guard-economy-fixes)
   - [1.1 Verify Contract Configuration](#11-verify-contract-configuration)
   - [1.2 Fix Token Transfer Issues](#12-fix-token-transfer-issues)
   - [1.3 Test Staking Functionality](#13-test-staking-functionality)
   - [1.4 Test Rewards Distribution](#14-test-rewards-distribution)
2. [IPFS Testing](#2-ipfs-testing)
   - [2.1 Setup IPFS Node](#21-setup-ipfs-node)
   - [2.2 Test IPFS Upload](#22-test-ipfs-upload)
   - [2.3 Verify CID Retrieval](#23-verify-cid-retrieval)
3. [0g Inference LLM Fixes](#3-0g-inference-llm-fixes)
   - [3.1 Diagnose Broker Initialization Failure](#31-diagnose-broker-initialization-failure)
   - [3.2 Fix Configuration Issues](#32-fix-configuration-issues)
   - [3.3 Test 0g Integration](#33-test-0g-integration)
   - [3.4 Update to New Model](#34-update-to-new-model)

---

## 1. GUARD Economy Fixes

### 1.1 Verify Contract Configuration

**File:** `agents/shared/config.ts`

**Steps:**

1. Verify the GUARD token configuration in your `.env` file or `packages/sdk/config.json`:

```bash
# Check current configuration
cat packages/sdk/config.json | grep -A5 "guardToken"
```

2. Ensure these environment variables are set in your `.env`:

```env
# Hedera/HTS Configuration
HEDERA_ACCOUNT_ID=0.0.XXXXXX
HEDERA_PRIVATE_KEY=your_private_key
OPERATOR_ACCOUNT_ID=0.0.XXXXXX
OPERATOR_PRIVATE_KEY=your_private_key

# GUARD Token Settings (defaults shown)
BID_MIN_COLLATERAL_GUARD=50
BID_COLLATERAL_BUFFER_GUARD=0
SCANNER_REGISTRATION_STAKE_GUARD=100
REPORT_AGENT_STAKE_GUARD=100
```

3. Verify contract addresses in `config.ts` match deployed contracts:

```typescript
// From agents/shared/config.ts lines 58-76
guardToken: {
  id: sdk?.guardTokenId ?? "0.0.7936262",
  evmAddress: sdk?.guardTokenEvmAddress ?? "0x0000000000000000000000000000000000791906",
},
contracts: {
  agentRegistry: "0xe86218b5Bf5C21CA7a69cba04C5be0D3c2Be2303",
  paymentSettlement: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  // ... other contracts
}
```

### 1.2 Fix Token Transfer Issues

**File:** `agents/shared/contract-client.ts` (lines 437-460)

**Problem:** Token transfers may fail due to Hedera HTS ERC-20 precompile issues.

**Implementation Steps:**

1. Create a test script to verify token transfers:

```typescript
// test-token-transfer.ts
import { ContractClient } from "./agents/shared/contract-client.js";
import { ethers } from "ethers";

async function testTokenTransfer() {
  // Use your wallet's private key
  const client = ContractClient.fromPrivateKey(process.env.HEDERA_PRIVATE_KEY!);
  
  const myAddress = client.getAddress();
  console.log("Wallet address:", myAddress);
  
  // Check balance
  const balance = await client.getGuardBalance(myAddress);
  console.log("GUARD balance:", ethers.formatUnits(balance, 8));
  
  // Check allowance for payment settlement
  const spender = client.paymentSettlement.target;
  const allowance = await client.getGuardAllowance(myAddress, spender);
  console.log("Allowance to PaymentSettlement:", ethers.formatUnits(allowance, 8));
  
  // Test approval if needed
  if (allowance < ethers.parseUnits("100", 8)) {
    console.log("Approving tokens...");
    const tx = await client.ensureGuardAllowance(spender, ethers.parseUnits("1000", 8));
    if (tx) {
      await tx.wait();
      console.log("Approval confirmed!");
    }
  }
}

testTokenTransfer().catch(console.error);
```

2. Run the test:

```bash
cd agents
npx tsx test-token-transfer.ts
```

3. **Common Issues & Fixes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `HTS_REVERT` | Invalid token address | Verify `guardToken.evmAddress` in config |
| `INSUFFICIENT_BALANCE` | Wallet has no GUARD | Transfer GUARD to wallet address |
| `APPROVAL_FAILED` | Hedera HTS rejection | Use bounded approval (see code line 454-459) |

### 1.3 Test Staking Functionality

**Implementation Steps:**

1. Ensure the agent has sufficient GUARD balance for staking:

```typescript
// Minimum stake amounts from config
const MIN_SCANNER_STAKE = 100;  // GUARD
const MIN_REPORT_AGENT_STAKE = 100; // GUARD
```

2. Test agent registration with staking:

```typescript
// test-staking.ts
import { ContractClient } from "./agents/shared/contract-client.js";
import { ethers } from "ethers";

async function testStaking() {
  const client = ContractClient.fromPrivateKey(process.env.HEDERA_PRIVATE_KEY!);
  
  const agentId = "scanner-001";
  const ucpEndpoint = "https://your-agent-endpoint.com";
  const specializations = ["solidity", "security"];
  const stakeAmount = ethers.parseUnits("100", 8); // 100 GUARD
  
  // Check if already registered
  try {
    const existing = await client.getAgent(client.getAddress());
    console.log("Already registered:", existing);
    return;
  } catch (e) {
    console.log("Not registered yet, proceeding...");
  }
  
  // Ensure allowance for agent registry
  const registryAddress = client.agentRegistry.target;
  await client.ensureGuardAllowance(registryAddress, stakeAmount);
  
  // Register with stake
  console.log("Registering agent with stake...");
  const tx = await client.registerAgent(agentId, ucpEndpoint, specializations, stakeAmount);
  const receipt = await tx.wait();
  console.log("Registration confirmed! Tx:", receipt.hash);
  
  // Verify active status
  const isActive = await client.isActiveAgent(client.getAddress());
  console.log("Agent active:", isActive);
}

testStaking().catch(console.error);
```

3. Run the test:

```bash
cd agents
npx tsx test-staking.ts
```

### 1.4 Test Rewards Distribution

**Implementation Steps:**

1. Verify PaymentSettlement contract configuration:

```typescript
// From contract-client.ts lines 391-405
async function testRewards() {
  const client = ContractClient.fromPrivateKey(process.env.HEDERA_PRIVATE_KEY!);
  
  // Get fee configuration
  const reportFeeBase = await client.getReportFeeBase();
  const reportFeeDiscounted = await client.getReportFeeDiscounted();
  
  console.log("Report fee (base):", ethers.formatUnits(reportFeeBase, 8), "GUARD");
  console.log("Report fee (discounted):", ethers.formatUnits(reportFeeDiscounted, 8), "GUARD");
}

testRewards().catch(console.error);
```

2. Test job settlement with payments:

```typescript
// Test settleJob function
const payments = [
  {
    recipient: "0xrecipientAddress...",
    basePayment: ethers.parseUnits("10", 8),    // 10 GUARD
    bonus: ethers.parseUnits("2", 8),            // 2 GUARD bonus
    reportFee: ethers.parseUnits("0.5", 8),     // 0.5 GUARD fee
    paymentType: 0, // AUDIT
    description: "Audit job payment"
  }
];

const tx = await client.settleJob(jobId, payments, reportAgentAddress);
await tx.wait();
```

---

## 2. IPFS Testing

### 2.1 Setup IPFS Node

**Implementation Steps:**

1. **Option A: Docker Compose** (Recommended)

```yaml
# docker-compose.ipfs.yml
version: '3.8'

services:
  ipfs:
    image: ipfs/kubo:v0.24.0
    ports:
      - "5001:5001"  # API
      - "8080:8080"  # Gateway
    volumes:
      - ipfs_data:/data/ipfs
    environment:
      - IPFS_PROFILE=server

volumes:
  ipfs_data:
```

Run with:
```bash
docker-compose -f docker-compose.ipfs.yml up -d
```

2. **Option B: Manual Installation**

```bash
# Download and install IPFS
wget https://dist.ipfs.tech/kubo/v0.24.0/kubo_v0.24.0_linux-amd64.tar.gz
tar -xzf kubo_v0.24.0_linux-amd64.tar.gz
cd kubo

# Initialize and run
ipfs init
ipfs daemon
```

3. Set environment variable:

```env
IPFS_API_URL=http://127.0.0.1:5001
IPFS_GATEWAY_URL=http://127.0.0.1:8080
```

### 2.2 Test IPFS Upload

**File:** `agents/shared/ipfs-client.ts`

**Implementation Steps:**

1. Create a test script:

```typescript
// test-ipfs.ts
import { uploadToIPFS, ipfsGatewayUrl } from "./agents/shared/ipfs-client.js";

async function testIPFS() {
  const testContent = `
# AuditGuard Test Report

## Contract Analyzed
- Address: 0x1234567890abcdef1234567890abcdef12345678
- Type: ERC-20 Token

## Findings
- Critical: No reentrancy guard found
- High: Missing access control

Generated by AuditGuard AI Scanner
`;

  console.log("Uploading to IPFS...");
  const cid = await uploadToIPFS(testContent);
  console.log("Upload successful!");
  console.log("CID:", cid);
  console.log("Gateway URL:", ipfsGatewayUrl(cid));
  
  // Verify by fetching
  console.log("\nVerifying upload...");
  const response = await fetch(ipfsGatewayUrl(cid));
  const retrieved = await response.text();
  console.log("Retrieved content length:", retrieved.length, "chars");
  
  if (retrieved.includes("AuditGuard Test Report")) {
    console.log("✓ IPFS upload verified successfully!");
  } else {
    console.error("✗ IPFS verification failed");
    process.exit(1);
  }
}

testIPFS().catch((err) => {
  console.error("IPFS test failed:", err);
  process.exit(1);
});
```

2. Run the test:

```bash
cd agents
npx tsx test-ipfs.ts
```

3. **Expected Output:**

```
Uploading to IPFS...
Upload successful!
CID:Qm...
Gateway URL: http://127.0.0.1:8080/ipfs/Qm...

Verifying upload...
Retrieved content length: 243 chars
✓ IPFS upload verified successfully!
```

### 2.3 Verify CID Retrieval

**Implementation Steps:**

1. Test CID retrieval via API:

```bash
# Check if IPFS daemon is running
curl -s http://127.0.0.1:5001/api/v0/id | jq

# Get file from IPFS
curl -s "http://127.0.0.1:8080/ipfs/<YOUR_CID>" | head -c 200
```

2. Test gateway URL generation:

```typescript
import { ipfsGatewayUrl } from "./agents/shared/ipfs-client.js";

// Test various CID formats
const testCids = [
  "QmXyZ1234567890abcdef...",
  "bafybeif7ztnhq65lumvvtr4xszm7rus4s2x5o",  # CIDv1
];

testCids.forEach(cid => {
  console.log(`${cid} -> ${ipfsGatewayUrl(cid)}`);
});
```

---

## 3. 0g Inference LLM Fixes

### 3.1 Diagnose Broker Initialization Failure

**File:** `agents/llm-contextual/zg-client.ts` (lines 206-241)

**Error Code:** `zg_broker_init_failed`

**Implementation Steps:**

1. **First, verify environment variables:**

```env
# Required for 0g broker
ZG_PRIVATE_KEY=0x8948e...your_private_key
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_PROVIDER_ADDRESS=0xa48f0...provider_address
ZG_MODEL=qwen-2.5-7b-instruct

# Optional settings
ZG_TIMEOUT_MS=30000
ZG_HEALTHCHECK_TIMEOUT_MS=15000
ZG_DEPOSIT_AMOUNT=5
ZG_MIN_LEDGER_CREDITS=1
ZG_MAX_INIT_RETRIES=2
ZG_PROBE_AT_STARTUP=true
ZG_REQUIRED_IN_LIVE=true
```

2. **Check SDK installation:**

```bash
# Verify @0glabs/0g-serving-broker is installed
cd agents
npm list @0glabs/0g-serving-broker

# If not installed, install it
npm install @0glabs/0g-serving-broker@latest
```

3. **Create diagnostic script:**

```typescript
// test-zg-diagnostics.ts
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

async function diagnoseBrokerInit() {
  console.log("=== 0g Broker Diagnostics ===\n");
  
  // Check environment
  const privateKey = process.env.ZG_PRIVATE_KEY;
  const rpcUrl = process.env.ZG_RPC_URL;
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS;
  
  console.log("1. Environment Check:");
  console.log("   - ZG_PRIVATE_KEY:", privateKey ? `${privateKey.slice(0, 10)}...` : "MISSING");
  console.log("   - ZG_RPC_URL:", rpcUrl || "MISSING");
  console.log("   - ZG_PROVIDER_ADDRESS:", providerAddress || "MISSING");
  
  if (!privateKey || !rpcUrl || !providerAddress) {
    console.error("\n✗ Missing required environment variables!");
    process.exit(1);
  }
  
  // Test RPC connectivity
  console.log("\n2. RPC Connectivity:");
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const blockNumber = await provider.getBlockNumber();
    console.log("   ✓ RPC connected. Current block:", blockNumber);
  } catch (err) {
    console.error("   ✗ RPC connection failed:", err);
    process.exit(1);
  }
  
  // Test wallet creation
  console.log("\n3. Wallet Creation:");
  try {
    const wallet = new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    console.log("   ✓ Wallet created. Address:", wallet.address);
  } catch (err) {
    console.error("   ✗ Wallet creation failed:", err);
    process.exit(1);
  }
  
  // Test broker initialization
  console.log("\n4. Broker Initialization:");
  try {
    const { createZGComputeNetworkBroker } = await import("@0glabs/0g-serving-broker");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
      provider
    );
    
    const broker = await createZGComputeNetworkBroker(wallet);
    console.log("   ✓ Broker initialized successfully!");
    console.log("   Broker instance:", typeof broker);
    
    // Test ledger
    console.log("\n5. Ledger Check:");
    const ledger = await broker.ledger.getLedger();
    console.log("   Available balance:", ledger?.availableBalance?.toString() || "0");
    console.log("   Total balance:", ledger?.totalBalance?.toString() || "0");
    
    // Test provider metadata
    console.log("\n6. Provider Metadata:");
    const meta = await broker.inference.getServiceMetadata(providerAddress);
    console.log("   Endpoint:", meta?.endpoint);
    console.log("   Model:", meta?.model);
    
    console.log("\n=== All diagnostics passed! ===");
  } catch (err: any) {
    console.error("   ✗ Broker initialization failed:");
    console.error("   Error:", err.message);
    console.error("   Code:", err.code || "N/A");
    
    if (err.message.includes("cannot find module")) {
      console.error("\n>>> Fix: npm install @0glabs/0g-serving-broker@latest");
    }
    process.exit(1);
  }
}

diagnoseBrokerInit().catch(console.error);
```

4. Run diagnostics:

```bash
cd agents
npx tsx test-zg-diagnostics.ts
```

### 3.2 Fix Configuration Issues

**Common Issues & Solutions:**

| Error | Cause | Fix |
|-------|-------|-----|
| `ZG_PRIVATE_KEY not configured` | Missing env var | Add to `.env` file |
| `Ledger has zero balance` | No 0g credits | Deposit tokens via `ensureLedgerFunding()` |
| `Provider not acknowledged` | First-time setup | Call `ensureProviderAcknowledged()` |
| `Provider metadata missing` | Invalid provider address | Verify `ZG_PROVIDER_ADDRESS` |

**Implementation Fix:**

```typescript
// Force re-initialization if config changed
import { _resetBroker, ensureZgReady } from "./llm-contextual/zg-client.js";

// Reset cached broker instance
_resetBroker();

// Re-initialize with proper configuration
const readiness = await ensureZgReady();
console.log("Ready! Endpoint:", readiness.endpoint);
```

### 3.3 Test 0g Integration

**File:** `agents/tests/llm-0g-integration.test.ts`

**Implementation Steps:**

1. Run existing tests:

```bash
cd agents
npm test -- --run llm-0g-integration
```

2. Create integration test:

```typescript
// test-zg-integration.ts
import { infer, initZgClient, ZGClientError } from "./llm-contextual/zg-client.js";

async function testInference() {
  console.log("Initializing 0g client...");
  
  try {
    await initZgClient();
    console.log("✓ Client initialized");
  } catch (err) {
    console.error("✗ Initialization failed:", err);
    process.exit(1);
  }
  
  console.log("Testing inference...");
  const request = {
    model: "qwen-2.5-7b-instruct",
    messages: [
      { role: "system", content: "You are a smart contract security auditor." },
      { role: "user", content: "What are the top 3 vulnerabilities in ERC-20 tokens?" }
    ],
    temperature: 0.3,
    max_tokens: 500
  };
  
  try {
    const result = await infer(request);
    console.log("✓ Inference successful!");
    console.log("Response:", result.content.slice(0, 200), "...");
    console.log("Provider:", result.providerAddress);
    console.log("Verified:", result.verified);
  } catch (err) {
    if (err instanceof ZGClientError) {
      console.error(`✗ Inference failed: [${err.code}] ${err.message}`);
    } else {
      console.error("✗ Inference failed:", err);
    }
    process.exit(1);
  }
}

testInference();
```

3. Run:

```bash
npx tsx test-zg-integration.ts
```

### 3.4 Update to New Model

**Implementation Steps:**

1. **Check available models:**

```bash
# List available 0g models (via provider)
curl -X POST https://<provider-endpoint>/v1/models \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>"
```

2. **Update environment variable:**

```env
# Change model
ZG_MODEL=qwen-2.5-14b-instruct
# Or new model
ZG_MODEL=llama-3-8b-instruct
```

3. **Update in config.ts if needed:**

```typescript
// agents/shared/config.ts line 111
zgInference: {
  // ... other config
  model: process.env.ZG_MODEL ?? "qwen-2.5-7b-instruct", // Update default here
}
```

4. **Test new model:**

```typescript
// test-model-update.ts
import { infer, probeProvider } from "./llm-contextual/zg-client.js";

async function testNewModel() {
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS!;
  
  // Probe provider to verify new model
  console.log("Probing provider...");
  const report = await probeProvider(providerAddress);
  console.log("Provider model:", report.model);
  
  // Test inference with new model
  const result = await infer({
    model: report.model,
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0.1,
    max_tokens: 10
  });
  
  console.log("Inference result:", result.content);
}

testNewModel();
```

---

## Environment Variable Quick Reference

```env
# =============================================================================
# GUARD Economy
# =============================================================================
HEDERA_ACCOUNT_ID=0.0.XXXXXX
HEDERA_PRIVATE_KEY=0x...
OPERATOR_ACCOUNT_ID=0.0.XXXXXX
OPERATOR_PRIVATE_KEY=0x...

BID_MIN_COLLATERAL_GUARD=50
BID_COLLATERAL_BUFFER_GUARD=0
SCANNER_REGISTRATION_STAKE_GUARD=100
REPORT_AGENT_STAKE_GUARD=100

# =============================================================================
# IPFS
# =============================================================================
IPFS_API_URL=http://127.0.0.1:5001
IPFS_GATEWAY_URL=http://127.0.0.1:8080

# =============================================================================
# 0g Inference LLM
# =============================================================================
ZG_PRIVATE_KEY=0x...
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_PROVIDER_ADDRESS=0x...
ZG_MODEL=qwen-2.5-7b-instruct

# Optional
ZG_TIMEOUT_MS=30000
ZG_HEALTHCHECK_TIMEOUT_MS=15000
ZG_DEPOSIT_AMOUNT=5
ZG_MIN_LEDGER_CREDITS=1
ZG_MAX_INIT_RETRIES=2
ZG_PROBE_AT_STARTUP=true
ZG_REQUIRED_IN_LIVE=true
ZG_ENABLED=true
ZG_PROVIDER_MODE=pinned
```

---

## 4. Scanner Wallet Cutover Reliability

When scanner credentials are rotated, activation can fail on GUARD funding due to transient Hedera JSON-RPC estimate/send instability even when scanner/account setup is correct.

### 4.1 Required Env Controls

Set these in root `.env` (recommended defaults shown):

```env
ACTIVATE_GUARD_TRANSFER_RETRY_MAX=3
ACTIVATE_GUARD_TRANSFER_RETRY_BASE_MS=900
ACTIVATE_GUARD_TRANSFER_GAS_LIMIT=250000
ACTIVATE_GUARD_FALLBACK_HAPI_TRANSFER=true
```

### 4.2 Cutover Run Sequence

Run these in order:

```bash
npm run preflight:runtime
npm run activate:live-agents
npm run verify:live-agents
```

Expected behavior:
1. Activation first tries EVM GUARD transfer with explicit gas and bounded retries.
2. If EVM transfer remains unstable, activation falls back to HAPI token transfer.
3. Scanner should then complete allowance/registration and verify as active.

### 4.3 Troubleshooting

| Symptom | Meaning | Action |
|-------|-------|-----|
| `guard_transfer_estimate_or_rpc_failure` | Hedera estimate/send path instability | Re-run activation; keep HAPI fallback enabled |
| `guard_transfer_operator_insufficient` | Operator cannot fund scanner | Top up operator GUARD or lower scanner funding target |
| `guard_transfer_hapi_fallback_failed` | Both EVM and fallback failed | Check token association + network health + operator signer key |
| `agent_inactive` with `guard>0` | Funding succeeded, registration did not | Re-run activation and inspect `registerAgent` return logs |

---

## Troubleshooting Checklist

### GUARD Economy

- [ ] Verify Hedera account has HBAR for gas fees
- [ ] Verify GUARD token balance > 0
- [ ] Verify contract addresses are correct in config.json
- [ ] Check allowance for spender contracts before transactions
- [ ] Verify agent registration with sufficient stake

### IPFS

- [ ] IPFS daemon is running (`docker ps` or `ipfs daemon`)
- [ ] API port 5001 is accessible
- [ ] Gateway port 8080 is accessible
- [ ] CID format is valid (Qm... or bafy...)
- [ ] Content was successfully pinned

### 0g LLM

- [ ] ZG_PRIVATE_KEY has valid format (0x +)
- [ ] RPC URL is accessible 64 hex chars and responding
- [ ] Provider address is valid and acknowledged
- [ ] Ledger has sufficient credits
- [ ] SDK is installed: `npm list @0glabs/0g-serving-broker`

---

## Running Tests

```bash
# GUARD economy tests
cd agents
npm test -- --run agents

# IPFS tests  
npm run test:ipfs

# 0g LLM tests
npm test -- --run llm-0g-integration

# All tests
npm test -- --run
```

---

*Last updated: 2026-02-19*
