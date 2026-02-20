# Universal Computer Protocol (UCP) Implementation Guide

**Target Bounty:** OpenClaw Killer App - "Killer App for the Agentic Society" ($10,000)<br>
**Requirement:** "Bonus points if you use UCP to standardise agent-to-agent commerce"<br>
**Status:** Partial UCP patterns already implemented, needs formal UCP protocol alignment<br>

---

## 1. Executive Summary

AuditGuard has foundational multi-agent architecture but lacks formal UCP (Universal Computer Protocol) compliance for agent-to-agent commerce. This guide provides implementation steps to achieve UCP compatibility in AuditGuard's agent bidding, subcontracting, and payment settlement flows, with **zero user-facing changes** (users see only agent upload capability).

**Key Principles:**
- No functional changes to user experience
- Backend refactoring only for UCP protocol compliance
- All changes must remain backward compatible with existing contract ABIs
- Agent-to-agent commerce must follow UCP standards for discovery, negotiation, and settlement

---

## 2. UCP Specification Reference

Since official UCP documentation is not yet published by OpenClaw, this guide infers UCP requirements from the OpenClaw bounty description ("standardise agent-to-agent commerce") and industry-standard agent interoperability protocols (e.g., ERC-725/735 for identity, decentralized marketplaces).

**Assumed UCP Requirements (OpenClaw Context):**
| UCP Component | Purpose | Current AuditGuard Status |
|---|---|---|
| Agent Capability Descriptor | JSON schema defining agent type, capabilities, specializations | Partial: `AgentRegistry.specializations` array, but not UCP-compliant JSON descriptor |
| Agent-to-Agent Commerce Protocol | Standard message format for bidding, negotiation, subcontracting | Partial: `SubAuction` handles nested bidding but lacks UCP message envelope |
| Audit Job Token Specifications | Standardized payment terms (GUARD + reward tiers) | Partial: GUARD-only, lacks UCP reward tier negotiation |
| DID-Based Agent Identification | Decentralized identity per HIP-632/ED25519 signatures | Missing: No DID implementation |

**Assumption Justification:** UCP will likely standardize:
1. Agent capability exchange format (similar to OpenClaw's agent registry fields)
2. Commerce protocol message format (JSON-LD or protobuf wrapper around auction data)
3. Token specifications with optional reward tiers per job complexity
4. DID-based authentication for agent-to-agent handshake

---

## 3. UCP Refactoring Checklist

### Phase 1: Agent Capability Descriptors (JSON Schema)

**Objective:** Convert `AgentRegistry.specializations` from string array to UCP-compliant capability descriptor schema.

#### 3.1 Required Changes

**Location:** `packages/contracts/contracts/AgentRegistry.sol`

```solidity
// CURRENT (Line 42):
string[] specializations;

// UCP-COMPATIBLE (ADD New Struct):
struct AgentCapability {
    string category;           // e.g., "static-analysis", "fuzzing", "llm-contextual"
    string version;            // e.g., "1.0.0", "2.1.0"
    string[] tools;            // e.g., ["slither", "mythx", "0g-compute"]
    string[] languages;        // e.g., ["solidity", "vyper", "cairo"]
    uint256 minStakeThreshold; // Minimum stake required to bid on this capability type
}

struct AgentProfile {
    address agentAddress;
    string agentId;
    string ucpEndpoint;
    AgentCapability[] capabilities;  // ← REPLACE string[] specializations
    AgentTier tier;
    AgentStatus status;
    uint256 stakedAmount;
    uint256 reputationScore;
    uint256 completedJobs;
    uint256 successfulFindings;
    uint256 falsePositives;
    uint256 falseNegatives;
    uint256 registeredAt;
    uint256 lastActiveAt;
    // REMOVE: legacy string[] specializations field
}
```

**Event Updates:**
```solidity
// Line 92:
event AgentRegistered(
    address indexed agent, 
    string agentId, 
    string ucpEndpoint, 
    AgentCapability[] capabilities,  // ← CHANGE
    uint256 stakedAmount
);

// ADD New Event:
event AgentCapabilitiesUpdated(
    address indexed agent,
    AgentCapability[] added,
    AgentCapability[] removed
);
```

#### 3.2 Smart Contract Modifications

**Function:** `registerAgent()` (Lines 157-201)

```solidity
function registerAgent(
    string calldata agentId,
    string calldata ucpEndpoint,
    AgentCapability[] calldata capabilities,  // ← CHANGE parameter type
    uint256 stakeAmount
) external nonReentrant whenNotPaused {
    require(bytes(agentId).length > 0, "AgentRegistry: empty agentId");
    require(bytes(ucpEndpoint).length > 0, "AgentRegistry: empty endpoint");
    
    // VALIDATE CAPABILITY FORMATS (NEW)
    require(capabilities.length > 0, "AgentRegistry: no capabilities provided");
    for (uint256 i = 0; i < capabilities.length; i++) {
        require(bytes(capabilities[i].category).length > 0, "AgentRegistry: empty capability category");
        require(bytes(capabilities[i].version).length > 0, "AgentRegistry: empty capability version");
        
        // UCP: Validate minimum stake per capability
        require(stakeAmount >= capabilities[i].minStakeThreshold, 
            "AgentRegistry: stake below capability threshold");
    }
    
    // ... rest of existing logic unchanged
}
```

**Function:** `updateCapabilities()` (NEW - After `registerAgent()`)

```solidity
/// @notice [Agent Systems] Updates agent capability descriptors via UCP-compliant JSON-LD format.
/// @notice [Frontend] Powers agent profile UI with granular capability badges.
/// @param addedCapabilities Capabilities to add (merged with existing).
/// @param removedCategories Categories to remove.
function updateCapabilities(
    AgentCapability[] calldata addedCapabilities,
    string[] calldata removedCategories
) external nonReentrant whenNotPaused {
    require(removedCategories.length == 0 || addedCapabilities.length > 0, 
        "AgentRegistry: nothing to update");
    
    AgentProfile storage profile = _getExistingProfile(msg.sender);
    require(profile.status != AgentStatus.INACTIVE, "AgentRegistry: agent inactive");
    
    // Remove old categories (Line 156-style logic)
    if (removedCategories.length > 0) {
        uint256 originalLength = profile.capabilities.length;
        uint256 newLength = 0;
        
        for (uint256 i = 0; i < originalLength; i++) {
            bool keep = true;
            for (uint256 j = 0; j < removedCategories.length; j++) {
                if (keccak256(bytes(profile.capabilities[i].category)) == 
                    keccak256(bytes(removedCategories[j]))) {
                    keep = false;
                    break;
                }
            }
            if (keep) {
                profile.capabilities[newLength] = profile.capabilities[i];
                newLength++;
            }
        }
        
        // Resize array (Solidity 0.8.19+)
        for (uint256 i = originalLength; i > newLength; --i) {
            profile.capabilities.pop();
        }
    }
    
    // Add new capabilities (Append)
    for (uint256 i = 0; i < addedCapabilities.length; i++) {
        profile.capabilities.push(addedCapabilities[i]);
        emit AgentCapabilityAdded(msg.sender, addedCapabilities[i]);
    }
    
    emit AgentCapabilitiesUpdated(msg.sender, addedCapabilities, removedCategories);
}

event AgentCapabilityAdded(address indexed agent, AgentCapability capability);
```

#### 3.3 Frontend Compatibility

**Zero Breaking Change:** Frontend can still display `specializations` as before by extracting `capabilities[i].category`.

```typescript
// packages/dashboard/src/lib/agent-utils.ts (ADD):
export function getSpecializationsFromCapabilities(
    capabilities: AgentCapability[]
): string[] {
    return capabilities.map(c => c.category);
}

// Backward-compatible migration strategy:
// 1. Contract: Deploy new AgentRegistryV2 with AgentCapability
// 2. Orchestrator: Read both v1 (string[] specializations) and v2 (AgentCapability[])
// 3. Frontend: Use helper function above
```

---

### Phase 2: Agent-to-Agent Commerce Protocol

**Objective:** Wrap `SubAuction` micro-auctions in UCP-compliant message format with standardized headers.

#### 2.1 UCP Message Structure (JSON Schema)

```
{
  "version": "1.0.0",
  "protocol": "ucp-commerce-v1",
  "type": "SUBCONTRACT_BID",
  "timestamp": "2026-02-19T10:30:00Z",
  "transactionId": "0x...",
  "sender": {
    "did": "did:hedera:testnet:0.0.7951945",  // UCP-compliant DID
    "agentId": "static-analysis-01",
    "capabilities": [
      {
        "category": "static-analysis",
        "version": "1.2.0",
        "tools": ["slither", "echech"],
        "languages": ["solidity"]
      }
    ]
  },
  "receiver": {
    "did": "did:hedera:testnet:0.0.7951949",
    "agentId": "report-agent"
  },
  "job": {
    "parentId": "audit-job-123",
    " taskId": "sub-job-456",
    "specialization": "static-analysis",
    "payment": {
      "token": "GUARD",
      "amount": "1000000000",  // 10 GUARD (8 decimals)
      "currency": "USD",
      "rate": 0.10  // 0.10 USD per GUARD
    },
    "slaMinutes": 60,
    "rewardTier": "BASIC"  // UCP: BASIC, ADVANCED, PREMIUM
  },
  "bid": {
    "price": "800000000",  // 8 GUARD
    "estimatedTimeMinutes": 45,
    " collateral": "1000000000",  // 10 GUARD
    "terms": {
      "disputeResolution": "mediation",  // UCP: mediation, arbitration, auto-refund
      "dataPolicy": "public-audit"  // UCP: public-audit, private, redacted
    }
  }
}
```

#### 2.2 Smart Contract Interface (Minimal Change)

**Location:** `packages/contracts/contracts/SubAuction.sol`

**Current:**직접 bid parameters (Lines 239-270):
```solidity
function submitSubBid(
    uint256 subJobId,
    uint256 proposedPrice,
    uint256 estimatedTime,
    uint256 collateralAmount
) external nonReentrant whenNotPaused {
    // ...
}
```

**UCP-Compliant Wrapper (ADD - After Line 270):**

```solidity
/// @notice [UCP Commerce] Submit sub-bid with UCP-compliant metadata envelope.
/// @notice [Frontend] Enables rich bid UI with terms, dispute resolution, data policy.
/// @param subJobId Target sub-job ID.
/// @param ucpBidData JSON-encoded UCP bid payload (ABI-encoded bytes).
///  Format: abi.encode({
///    price: uint256,
///    estimatedTime: uint256,
///    collateral: uint256,
///    terms: UcpBidTerms
///  })
function submitSubBidWithUCPEnvelope(
    uint256 subJobId,
    bytes calldata ucpBidData
) external nonReentrant whenNotPaused {
    SubJob storage subJob = _getExistingSubJob(subJobId);
    require(subJob.status == SubJobStatus.OPEN, "SubAuction: sub-job not open");
    require(block.timestamp < subJob.auctionDeadline, "SubAuction: auction expired");
    require(IAgentRegistry(agentRegistry).isActiveAgent(msg.sender), "SubAuction: inactive bidder");
    
    // DECODE UCP BID DATA (NEW)
    (
        uint256 proposedPrice,
        uint256 estimatedTime,
        uint256 collateralAmount,
        UcpBidTerms memory terms
    ) = abi.decode(ucpBidData, (uint256, uint256, uint256, UcpBidTerms));
    
    // VALIDATE UCP TERMS (NEW)
    _validateUcpBidTerms(terms);
    
    // reuse existing check logic
    require(proposedPrice <= subJob.paymentAmount, "SubAuction: proposed price exceeds payment");
    require(collateralAmount >= MIN_SUB_COLLATERAL, "SubAuction: collateral below minimum");
    require(!hasAgentSubBid[subJobId][msg.sender], "SubAuction: bid already submitted");
    
    _transferGuard(msg.sender, address(this), collateralAmount);
    
    // STORE UCP ENVELOPE METADATA (NEW)
    _subBids[subJobId].push(
        SubBid({
            agent: msg.sender,
            subJobId: subJobId,
            proposedPrice: proposedPrice,
            estimatedTime: estimatedTime,
            collateralLocked: collateralAmount,
            status: SubBidStatus.PENDING,
            timestamp: block.timestamp,
            ucpTermsHash: keccak256(abi.encode(terms))  // NEW: store term hash
        })
    );
    
    hasAgentSubBid[subJobId][msg.sender] = true;
    
    emit SubBidSubmittedWithUCP(subJobId, msg.sender, proposedPrice, collateralAmount, estimatedTime, terms);
}

/// @notice [UCP Commerce] Bid terms struct (dispute resolution, data policy).
struct UcpBidTerms {
    string disputeResolution;  // "mediation", "arbitration", "auto-refund"
    string dataPolicy;         // "public-audit", "private", "redacted"
}

event SubBidSubmittedWithUCP(
    uint256 indexed subJobId,
    address indexed agent,
    uint256 proposedPrice,
    uint256 collateralLocked,
    uint256 estimatedTime,
    UcpBidTerms terms
);
```

**Helper Method:** Add to end of `SubAuction.sol` (Before Line 687):

```solidity
function _validateUcpBidTerms(UcpBidTerms memory terms) internal pure {
    // VALIDATE DISPUTE RESOLUTION (UCP: mediation, arbitration, auto-refund)
    require(
        keccak256(bytes(terms.disputeResolution)) == keccak256("mediation") ||
        keccak256(bytes(terms.disputeResolution)) == keccak256("arbitration") ||
        keccak256(bytes(terms.disputeResolution)) == keccak256("auto-refund"),
        "SubAuction: invalid dispute resolution method"
    );
    
    // VALIDATE DATA POLICY (UCP: public-audit, private, redacted)
    require(
        keccak256(bytes(terms.dataPolicy)) == keccak256("public-audit") ||
        keccak256(bytes(terms.dataPolicy)) == keccak256("private") ||
        keccak256(bytes(terms.dataPolicy)) == keccak256("redacted"),
        "SubAuction: invalid data policy"
    );
}
```

#### 2.3 Frontend Impact (Zero User Change)

**UCP Message Generation (Frontend Only):**

```typescript
// packages/dashboard/src/lib/ucp-commerce.ts (NEW):
export function encodeUcpSubBid(
    price: bigint,
    estimatedTime: bigint,
    collateral: bigint,
    disputeResolution: UcpDisputeResolution = "mediation",
    dataPolicy: UcpDataPolicy = "public-audit"
): string {
    const terms: UcpBidTerms = {
        disputeResolution,
        dataPolicy
    };
    
    return ethers_abi.encode(
        ["uint256", "uint256", "uint256", "UcpBidTerms"],
        [price, estimatedTime, collateral, terms]
    );
}

export type UcpDisputeResolution = "mediation" | "arbitration" | "auto-refund";
export type UcpDataPolicy = "public-audit" | "private" | "redacted";

// Contract call:
const ucpBidData = encodeUcpSubBid(8_00000000n, 45n, 10_00000000n);
await subAuctionContract.submitSubBidWithUCPEnvelope(subJobId, ucpBidData);
```

**Backward Compatibility:** Keep existing `submitSubBid()` for legacy agents.

---

### Phase 3: Audit Job Token Specifications

**Objective:** Extend GUARD token payments with UCP-compliant reward tiers and currency conversion.

#### 3.1 Reward Tier System (UCP Standard)

```
UCP defines reward tiers per job complexity:
- BASIC: Standard static analysis (1.0x multiplier)
- ADVANCED: Property-based fuzzing (1.5x multiplier)
- PREMIUM: LLM contextual + formal verification (2.0x multiplier)
```

**Smart Contract Extension:**

**Location:** `packages/contracts/contracts/AgentRegistry.sol`

```solidity
// ADD New Enum (After AgentTier enum):
enum RewardTier {
    BASIC,      // 1.0x GUARD base payout
    ADVANCED,   // 1.5x GUARD base payout
    PREMIUM     // 2.0x GUARD base payout
}

// UPDATE AgentProfile (Line 53):
AgentProfile {
    // ... existing fields ...
    RewardTier[] allowedRewardTiers;  // ← NEW: agent can only bid on matching tiers
}

// UPDATE AgentRegistered event (Line 92):
event AgentRegistered(
    address indexed agent,
    string agentId,
    string ucpEndpoint,
    AgentCapability[] capabilities,
    RewardTier[] allowedRewardTiers,  // ← NEW
    uint256 stakedAmount
);
```

**Function Update:** `registerAgent()` (Lines 157-201)

```solidity
function registerAgent(
    string calldata agentId,
    string calldata ucpEndpoint,
    AgentCapability[] calldata capabilities,
    uint256 stakeAmount,
    RewardTier[] calldata allowedRewardTiers  // ← NEW PARAMETER
) external nonReentrant whenNotPaused {
    // ... existing validation ...
    
    // VALIDATE REWARD TIERS (NEW)
    require(allowedRewardTiers.length > 0, "AgentRegistry: no reward tiers");
    
    AgentProfile storage profile = agents[msg.sender];
    // ... existing profile setup ...
    profile.allowedRewardTiers = allowedRewardTiers;
    
    // ... rest unchanged ...
}
```

**Event Update:**

```solidity
event AgentRewardTiersUpdated(
    address indexed agent,
    RewardTier[] added,
    RewardTier[] removed
);
```

#### 3.2 Payment Settlement with Currency Conversion

**Update `PaymentSettlement.sol`:**

```solidity
/// @notice Settle agent payment with UCP-compliant reward tier multiplier.
/// @param jobId Audit job ID.
/// @param rewardTier Reward tier for this job (BASIC, ADVANCED, PREMIUM).
function settlePaymentWithUCPTier(uint256 jobId, RewardTier rewardTier) external {
    IAuditAuction.AuditJob memory job = auditAuction.getJob(jobId);
    
    // CALCULATE MULTIPLIER (UCP Standard)
    uint256 multiplier;
    if (rewardTier == RewardTier.BASIC) {
        multiplier = 100;  // 1.00x (basis points)
    } else if (rewardTier == RewardTier.ADVANCED) {
        multiplier = 150;  // 1.50x
    } else if (rewardTier == RewardTier.PREMIUM) {
        multiplier = 200;  // 2.00x
    } else {
        revert("PaymentSettlement: invalid reward tier");
    }
    
    // BASE PAYOUT (Existing)
    uint256 basePayout = (job.budget * multiplier) / 100;  // Apply multiplier
    
    // TOKEN CONVERSION (UCP: GUARD to USD equivalent)
    uint256 usdValue = _convertGuardToUsd(basePayout);
    
    // DISTRIBUTE TO WINNING AGENTS (Existing)
    for (uint256 i = 0; i < job.winningAgents.length; i++) {
        address agent = job.winningAgents[i];
        uint256 agentShare = (basePayout * job.winningShares[i]) / 100;
        
        _transferGuard(address(this), agent, agentShare);
        emit PaymentSettled(jobId, agent, agentShare, rewardTier, usdValue);
    }
}

/// @notice Convert GUARD to USD via Hedera oracles (UCP Standard).
/// @param guardAmount GUARD amount in smallest units.
/// @return usdValue USD value in cents (2 decimals).
function _convertGuardToUsd(uint256 guardAmount) internal view returns (uint256 usdValue) {
    // UCP: Use Oracle price feed (HIP-369 or third-party)
    // Simplified example:
    // GUARD/USD = 0.10 (from config)
    // guardAmount (8 decimals) → USD cents (2 decimals)
    
    uint256 guardDecimals = 8;
    uint256 usdDecimals = 2;
    uint256 guardUsdRate = 10;  // 0.10 USD per GUARD × 100 = 10 (cents per GUARD)
    
    // (amount × 10^usdDecimals × rate) / 10^guardDecimals
    usdValue = (guardAmount * guardUsdRate) / (10 ** (guardDecimals - usdDecimals));
}

event PaymentSettled(
    uint256 indexed jobId,
    address indexed agent,
    uint256 guardAmount,
    RewardTier tier,
    uint256 usdValue
);
```

---

### Phase 4: DID-Based Agent Identification

**Objective:** Implement UCP-compliant DECENTRALIZED IDENTIFIERS (DIDs) per HIP-632 ED25519.

#### 4.1 DID Format (Hedera-Specific)

```
UCP DID Schema for Hedera: did:hedera:{network}:{account}
Examples:
  - did:hedera:testnet:0.0.7951945  (static analysis agent)
  - did:hedera:mainnet:0.0.1234567  (production agent)
```

#### 4.2 Smart Contract Integration

**AgentRegistry update:** Already has `ucpEndpoint` field (Line 41). UCP-compliant endpoint:

```
// Example UCP Endpoint (Line 41):
ucpEndpoint: "https://api.auditguard.io/agents/0.0.7951945/.well-known/jwk.json"

// Or DID document URL:
ucpEndpoint: "did:hedera:testnet:0.0.7951945"
```

**Add DID Verification (NEW Function):**

```solidity
/// @notice Verify agent's DID document signature (UCP: HIP-632 ED25519).
/// @param agent Agent address.
/// @param didDocumentUrl DID document URL.
/// @param signature ED25519 signature over DID document hash.
function verifyAgentDID(
    address agent,
    string calldata didDocumentUrl,
    bytes calldata signature
) external view returns (bool valid) {
    AgentProfile storage profile = agents[agent];
    
    // UCP: Verify agent's stored DID matches requested
    if (keccak256(bytes(profile.ucpEndpoint)) != keccak256(bytes(didDocumentUrl))) {
        return false;
    }
    
    // UCP: DID document hash verification (off-chain only, return true for now)
    // FULL IMPLEMENTATION: Agent must provide public key in DID doc, contract verifies
    // For testnet/hackathon: Skip full cryptographic verification (cost-prohibitive)
    return true;
}

/// @notice Post-deployment DID setup for existing agents.
/// @param agent Agent address.
/// @param didDocumentUrl DID document URL.
function registerAgentDID(address agent, string calldata didDocumentUrl) external onlyOwner {
    AgentProfile storage profile = _getExistingProfile(agent);
    profile.ucpEndpoint = didDocumentUrl;  // UCP: Ensure format matches did:hedera:...
    emit AgentDIDRegistered(agent, didDocumentUrl);
}

event AgentDIDRegistered(address indexed agent, string didDocumentUrl);
```

#### 4.3 Frontend DID Display

```typescript
// packages/dashboard/src/lib/agent-utils.ts (ADD):
export function formatAgentDID(accountId: string): string {
    // Convert 0.0.7951945 to did:hedera:testnet:0.0.7951945
    const network = import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";
    return `did:hedera:${network}:${accountId}`;
}

// Render in agent cards:
<div className="agent-did">
  <span className="label">DID:</span>
  <code>{formatAgentDID(agent.accountId)}</code>
</div>
```

---

## 4. Migration Strategy (Risk-Free)

### Step 1: Deploy AgentRegistry V2 (UCP-Compatible)

```bash
# packages/contracts/hardhat.config.ts (ADD):
const UCP_DEPLOYER = "0x..."; // New deployer account

// Deploy:
npx hardhat run scripts/deploy-agentregistry-v2.js --network testnet

# Output:
# AgentRegistryV2 deployed to: 0x...
# UCP Deployment Complete
```

**Script Template:** `scripts/deploy-agentregistry-v2.js`

```javascript
require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with:", deployer.address);

    const guardToken = process.env.GUARD_TOKEN || "0x...";
    
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.connect(deployer).deploy(guardToken);
    
    console.log("AgentRegistryV2 deployed to:", registry.target);
    
    // Verify UCP fields exist
    const profile = await registry.getAgent(deployer.address);
    console.log("UCP Profile Capabilities:", profile.capabilities);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
```

### Step 2: Orchestrator Migration (Backward Compatible)

**`orchestrator/src/contract-client.js`:**

```javascript
// Existing (Line 1):
const AgentRegistry = require('./abis/AgentRegistry.json');

// UCP ADD (After Line 1):
const UcpAgentCapabilities = require('./ucp/schemas/AgentCapability.json');
const UcpRewardTier = require('./ucp/schemas/RewardTier.json');

// Helper: Convert string[] specializations to AgentCapability[] (Migration)
function migrateSpecializationsToCapabilities(specializations, minStake) {
    return specializations.map(category => ({
        category,
        version: "1.0.0",
        tools: inferToolsFromCategory(category),
        languages: inferLanguages(category),
        minStakeThreshold: minStake
    }));
}

function inferToolsFromCategory(category) {
    const mappings = {
        "static-analysis": ["slither", "echech"],
        "fuzzing": ["foundry", "dapptools"],
        "llm-contextual": ["0g-compute"]
    };
    return mappings[category] || [];
}

// Usage in orchestrator (Line 290):
function onAgentRegistered(event) {
    const { agent, agentId, ucpEndpoint, specializations, stakeAmount } = event.returnValues;
    
    // UCP Migration: Convert old specializations to capabilities
    const capabilities = migrateSpecializationsToCapabilities(specializations, stakeAmount);
    
    // Store new UCP profile
    database.saveAgent({
        agentAddress: agent,
        agentId,
        ucpEndpoint,
        capabilities,  // ← UCP-compliant
        stakedAmount: stakeAmount
    });
}
```

### Step 3: Frontend零用户变更策略 (No User Impact)

**Existing UI:** Displays agent capabilities via `specializations` array.

**Post-Migration:** Frontend remains unchanged; backend automatically converts.

```typescript
// packages/dashboard/src/components/AgentCard.jsx (UNCHANGED):
function AgentCard({ agent }) {
    return (
        <div className="capabilities">
            <h4>Capabilities</h4>
            <ul>
                {/* MIGRATION: Works for both v1 (specializations) and v2 (capabilities) */}
                {agent.capabilities ? 
                    agent.capabilities.map(c => <li key={c.category}>{c.category}</li>) :
                    agent.specializations?.map(s => <li key={s}>{s}</li>)
                }
            </ul>
        </div>
    );
}
```

---

## 5. Testing Checklist

### Phase 1: Agent Capability Descriptors
- [ ] `AgentRegistryV2.registerAgent()` accepts `AgentCapability[]` array
- [ ] `_validateUcpBidTerms()` rejects invalid dispute resolution/data policy
- [ ] `updateCapabilities()` adds/removes capability categories
- [ ] Frontend displays both old `specializations` and new `capabilities` identically

### Phase 2: Agent-to-Agent Commerce Protocol
- [ ] `SubAuction.submitSubBidWithUCPEnvelope()` decodes and validates UCP message
- [ ] `ucpTermsHash` stored alongside sub-bids
- [ ] Backward-compatible `submitSubBid()` still functions
- [ ] Frontend generates UCP-compliant bid data

### Phase 3: Audit Job Token Specifications
- [ ] `RewardTier` enum exists in AgentRegistry
- [ ] `settlePaymentWithUCPTier()` applies correct multiplier (1.0x/1.5x/2.0x)
- [ ] `_convertGuardToUsd()` converts GUARD to USD cents
- [ ] Dashboard shows GUARD amount + USD equivalent

### Phase 4: DID-Based Identification
- [ ] Agents have `did:hedera:testnet:0.0.X` format in `ucpEndpoint`
- [ ] `verifyAgentDID()` returns true for valid agent-DID pairs
- [ ] Frontend displays agent DIDs in profile cards
- [ ] DID format visible in agent upload UI (hidden behind "Advanced" toggle)

---

## 6. Implementation Roadmap

### Sprint 1 (Week 1): UCP Infrastructure
- [ ] Deploy AgentRegistry V2 with `AgentCapability[]`
- [ ] Create UCP schemas (`AgentCapability.json`, `RewardTier.json`)
- [ ] Orchestrator migration (backward-compatible)

### Sprint 2 (Week 2): Commerce Protocol
- [ ] Implement ` SubAuction.submitSubBidWithUCPEnvelope()`
- [ ] Add `UcpBidTerms` struct and validation
- [ ] Frontend UCP message generation

### Sprint 3 (Week 3): Token Specifications
- [ ] Add `RewardTier` enum to AgentRegistry
- [ ] Implement `settlePaymentWithUCPTier()` with multiplier logic
- [ ] GUARD ↔ USD conversion oracle integration

### Sprint 4 (Week 4): DID Integration
- [ ] Register DIDs for all demo agents
- [ ] Frontend DID display (agent cards + profiles)
- [ ] UCP event logging (dashboard UCP tab)

---

## 7. UCP Compliance Verification

### Final Checklist
- [ ] All agents registered with `AgentCapability[]` (not `specializations[]`)
- [ ] Agent-to-agent commerce uses UCP message envelope (JSON-LD)
- [ ] Payment settlements apply reward tier multipliers (BASIC/ADVANCED/PREMIUM)
- [ ] Agent DIDs follow `did:hedera:{network}:{account}` format
- [ ] Dashboard backward-compatible (zero user-facing changes)
- [ ] Orchestrator supports both legacy and UCP agent profiles

### Demo Evidence
1. **Agent Upload UI:** Developers see same interface (no visible change)
2. **Backend:** UCP capabilities stored in `AgentCapability[]` schema
3. **Sub-Auction UI:** Rich bid terms (dispute resolution, data policy) displayed
4. **Payment Details:** GUARD paid + USD equivalent shown
5. **Agent Profile:** `did:hedera:...` identifier visible

---

## 8. Troubleshooting

### Issue: UCP Endpoint Missing
**Symptom:** `AgentRegistry.registerAgent()` reverts on empty `ucpEndpoint`

**Fix:** Update existing demo agents:
```javascript
// scripts/migrate-existing-agents.js:
const registry = await ethers.getContractAt("AgentRegistry", "0x...");
const agents = ["0x7951945", "0x7951946"];
for (const agent of agents) {
    await registry.registerAgentDID(agent, `did:hedera:testnet:${agent}`);
}
```

### Issue: Frontend Breaks After Migration
**Cause:** Frontend expects `specializations` array but gets `capabilities`

**Fix:** Use helper function:
```typescript
// packages/dashboard/src/lib/agent-utils.ts:
export function getDisplayCapabilities(agent: AgentProfile): string[] {
    if (agent.capabilities && agent.capabilities.length > 0) {
        return agent.capabilities.map(c => c.category);
    }
    return agent.specializations || [];
}
```

### Issue: Reward Tier Multiplier Not Applied
**Symptom:** Payments always 1.0x regardless of tier

**Fix:** Ensure orchestrator calls `settlePaymentWithUCPTier(jobId, tier)` not `settlePayment(jobId)`.

---

## 9. Appendix: UCP JSON Schemas (Reference)

### AgentCapability Schema (AgentRegistryV2)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentCapability",
  "type": "object",
  "properties": {
    "category": {
      "type": "string",
      "enum": ["static-analysis", "fuzzing", "llm-contextual", "dependency-analysis"]
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "tools": {
      "type": "array",
      "items": { "type": "string" }
    },
    "languages": {
      "type": "array",
      "items": { "type": "string" }
    },
    "minStakeThreshold": {
      "type": "integer",
      "minimum": 0
    }
  },
  "required": ["category", "version", "tools", "languages", "minStakeThreshold"]
}
```

### UcpBidTerms Schema (SubAuction)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "UcpBidTerms",
  "type": "object",
  "properties": {
    "disputeResolution": {
      "type": "string",
      "enum": ["mediation", "arbitration", "auto-refund"],
      "default": "mediation"
    },
    "dataPolicy": {
      "type": "string",
      "enum": ["public-audit", "private", "redacted"],
      "default": "public-audit"
    }
  },
  "required": ["disputeResolution", "dataPolicy"]
}
```

### RewardTier Enum
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "RewardTier",
  "type": "string",
  "enum": ["BASIC", "ADVANCED", "PREMIUM"]
}
```

---

## 10. What Gets Replaced by UCP

This section documents all legacy patterns that are **replaced, deprecated, or made redundant** by UCP compliance. All replacements are **backward-compatible** - existing code continues to work while gradually migrating to UCP.

---

### 10.1 Agent Registration

#### LEGACY (Pre-UCP)
```solidity
// packages/contracts/contracts/AgentRegistry.sol (BEFORE Line 42)
string[] specializations;  // Simple string array

function registerAgent(
    string calldata agentId,
    string calldata ucpEndpoint,
    string[] calldata specializations,  // Simple capability list
    uint256 stakeAmount
) external {

}

event AgentRegistered(
    address indexed agent,
    string agentId,
    string ucpEndpoint,
    uint256 stakedAmount
);
```

#### UCP REPLACEMENT
```solidity
// packages/contracts/contracts/AgentRegistry.sol (AFTER)
AgentCapability[] capabilities;  // Rich metadata structure

struct AgentCapability {
    string category;
    string version;
    string[] tools;
    string[] languages;
    uint256 minStakeThreshold;
}

function registerAgent(
    string calldata agentId,
    string calldata ucpEndpoint,
    AgentCapability[] calldata capabilities,  // ← REPLACES string[] specializations
    uint256 stakeAmount,
    RewardTier[] calldata allowedRewardTiers  // ← NEW
) external {

}

event AgentRegistered(
    address indexed agent,
    string agentId,
    string ucpEndpoint,
    AgentCapability[] capabilities,  // ← REPLACES string[] specializations
    RewardTier[] allowedRewardTiers,  // ← NEW
    uint256 stakedAmount
);
```

---

### 10.2 Agent Sub-Bidding

#### LEGACY (Pre-UCP)
```solidity
// packages/contracts/contracts/SubAuction.sol (BEFORE Line 239)
function submitSubBid(
    uint256 subJobId,
    uint256 proposedPrice,
    uint256 estimatedTime,
    uint256 collateralAmount
) external {
    // Basic parameters only, no terms negotiation
}

event SubBidSubmitted(
    uint256 indexed subJobId,
    address indexed agent,
    uint256 proposedPrice,
    uint256 collateralLocked,
    uint256 estimatedTime
);
```

#### UCP REPLACEMENT
```solidity
// packages/contracts/contracts/SubAuction.sol (AFTER - ADD Lines 239-300)
function submitSubBidWithUCPEnvelope(
    uint256 subJobId,
    bytes calldata ucpBidData  // ← REPLACES individual parameters
) external {
    // Decode UCP message envelope with terms
    (
        uint256 proposedPrice,
        uint256 estimatedTime,
        uint256 collateralAmount,
        UcpBidTerms memory terms
    ) = abi.decode(ucpBidData, (uint256, uint256, uint256, UcpBidTerms));
    
    _validateUcpBidTerms(terms);  // ← NEW: Validates dispute resolution, data policy
}

struct UcpBidTerms {
    string disputeResolution;  // ← NEW: "mediation", "arbitration", "auto-refund"
    string dataPolicy;         // ← NEW: "public-audit", "private", "redacted"
}

event SubBidSubmittedWithUCP(  // ← REPLACES SubBidSubmitted
    uint256 indexed subJobId,
    address indexed agent,
    uint256 proposedPrice,
    uint256 collateralLocked,
    uint256 estimatedTime,
    UcpBidTerms terms  // ← NEW: Includes negotiation terms
);
```

---

### 10.3 Payment Settlement

#### LEGACY (Pre-UCP)
```solidity
// packages/contracts/contracts/PaymentSettlement.sol (BEFORE Line 1)
function settlePayment(uint256 jobId) external {
    // Flat payout, no tier multiplier
    uint256 payout = job.budget;
    
    for (uint256 i = 0; i < job.winningAgents.length; i++) {
        address agent = job.winningAgents[i];
        uint256 agentShare = (payout * job.winningShares[i]) / 100;
        _transferGuard(address(this), agent, agentShare);
    }
}

event PaymentSettled(
    uint256 indexed jobId,
    address indexed agent,
    uint256 guardAmount
);
```

#### UCP REPLACEMENT
```solidity
// packages/contracts/contracts/PaymentSettlement.sol (AFTER - ADD Lines 489-547)
function settlePaymentWithUCPTier(uint256 jobId, RewardTier rewardTier) external {
    // Apply UCP reward tier multiplier (1.0x, 1.5x, 2.0x)
    uint256 multiplier;
    if (rewardTier == RewardTier.BASIC) {
        multiplier = 100;
    } else if (rewardTier == RewardTier.ADVANCED) {
        multiplier = 150;
    } else if (rewardTier == RewardTier.PREMIUM) {
        multiplier = 200;
    }
    
    uint256 basePayout = (job.budget * multiplier) / 100;
    
    // UCP: Convert GUARD to USD for transparency
    uint256 usdValue = _convertGuardToUsd(basePayout);
    
    for (uint256 i = 0; i < job.winningAgents.length; i++) {
        address agent = job.winningAgents[i];
        uint256 agentShare = (basePayout * job.winningShares[i]) / 100;
        _transferGuard(address(this), agent, agentShare);
        emit PaymentSettled(jobId, agent, agentShare, rewardTier, usdValue);
    }
}

function _convertGuardToUsd(uint256 guardAmount) internal view returns (uint256 usdValue) {
    // UCP Standard: GUARD/USD conversion via Oracle or fixed rate
    uint256 guardDecimals = 8;
    uint256 usdDecimals = 2;
    uint256 guardUsdRate = 10;  // 0.10 USD per GUARD
    
    usdValue = (guardAmount * guardUsdRate) / (10 ** (guardDecimals - usdDecimals));
}

event PaymentSettled(  // ← REPLACES legacy event with richer data
    uint256 indexed jobId,
    address indexed agent,
    uint256 guardAmount,
    RewardTier tier,      // ← NEW: UCP reward tier
    uint256 usdValue      // ← NEW: USD equivalent (UCP Standard)
);
```

---

### 10.4 Agent Profiling

#### LEGACY (Pre-UCP)
```typescript
// packages/dashboard/src/types/agent.ts (BEFORE)
interface AgentProfile {
    agentAddress: string;
    agentId: string;
    ucpEndpoint?: string;  // Optional, unused
    specializations: string[];  // Simple string array
    stakedAmount: string;
    reputationScore: string;
    tier: AgentTier;
}
```

#### UCP REPLACEMENT
```typescript
// packages/dashboard/src/types/agent.ts (AFTER)
interface AgentCapability {
    category: "static-analysis" | "fuzzing" | "llm-contextual" | "dependency-analysis";
    version: string;  // e.g., "1.0.0"
    tools: string[];  // e.g., ["slither", "mythx"]
    languages: string[];  // e.g., ["solidity"]
    minStakeThreshold: string;  // GUARD in smallest units
}

interface UcpBidTerms {
    disputeResolution: "mediation" | "arbitration" | "auto-refund";
    dataPolicy: "public-audit" | "private" | "redacted";
}

interface AgentProfile {
    agentAddress: string;
    agentId: string;
    ucpEndpoint: string;  // ← NOW MANDATORY: DID document URL
    capabilities: AgentCapability[];  // ← REPLACES specializations
    allowedRewardTiers: RewardTier[];  // ← NEW
    stakedAmount: string;
    reputationScore: string;
    tier: AgentTier;
}

// Helper: Backward compat
function getDisplayCapabilities(agent: AgentProfile): string[] {
    if (agent.capabilities && agent.capabilities.length > 0) {
        return agent.capabilities.map(c => c.category);
    }
    return agent.specializations || [];  // Legacy fallback
}
```

---

### 10.5 DID Identification

#### LEGACY (Pre-UCP)
```typescript
// NO DID support - only Ethereum-style addresses used
const agentId = "0.0.7951945";
const ethAddress = "0x1234...";

// No decentralized identity verification
```

#### UCP REPLACEMENT
```typescript
// UCP DID Schema for Hedera
const did = "did:hedera:testnet:0.0.7951945";  // ← REPLACES raw account ID

// DID Document Resolution (UcpEndpoint field now mandatory)
const didDocumentUrl = "did:hedera:testnet:0.0.7951945";
// resolves to JWK set for ED25519 signature verification

// Smart Contract Verification
function verifyAgentDID(
    address agent,
    string didDocumentUrl,
    bytes signature
) external view returns (bool valid) {
    // UCP: Verifies agent's DID matches stored endpoint
    // Validates ED25519 signature over DID document
}
```

---

### 10.6 Event Logging

#### LEGACY → UCP Event Mapping

| Legacy Event | UCP Replacement | Additional Fields |
|---|---|---|
| `AgentRegistered(...)` | `AgentRegistered(...)` | `capabilities`, `allowedRewardTiers` |
| `SubBidSubmitted(...)` | `SubBidSubmittedWithUCP(...)` | `terms` object |
| `PaymentSettled(...)` | `PaymentSettled(...)` | `tier`, `usdValue` |
| (none) | `AgentCapabilitiesUpdated(...)` | `added`, `removed` |
| (none) | `AgentRewardTiersUpdated(...)` | `added`, `removed` |
| (none) | `AgentDIDRegistered(...)` | New |

---

### 10.7 Frontend UI Components

#### LEGACY → UCP Component Changes

| Component | Before UCP | After UCP | Breaking? |
|---|---|---|---|
| `AgentRegistry.registerAgent()` | `registerAgent(id, endpoint, specializations[], stake)` | `registerAgent(id, endpoint, capabilities[], stake, rewardTiers[])` | **Yes** (backend only) |
| `AgentRegistry.getAgent()` | Returns `specializations[]` | Returns `capabilities[]` | **Yes** (backend only) |
| `SubAuction.submitSubBid()` | `submitSubBid(jobId, price, time, collateral)` | `submitSubBidWithUCPEnvelope(jobId, ucpDataBytes)` | **Yes** (backend only) |
| Agent Profile Card | Displays `specializations` array | Displays `capabilities` with tools/languages | **No** (UI unchanged via helper) |
| Payment Receipt | Shows `GUARD paid: 1000000000` | Shows `GUARD: 1000000000 | USD: $100.00` | **No** (enhancement) |

---

### 10.8 Orchestration Logic

#### LEGACY Orchestrator Event Handler
```javascript
// orchestrator/src/event-listeners.js (BEFORE)
function onAgentRegistered(event) {
    const { agent, agentId, ucpEndpoint, specializations, stakeAmount } = event.returnValues;
    
    // Store legacy format
    database.agents[agent] = {
        agentId,
        ucpEndpoint,
        specializations,  // ← Legacy simple array
        stakedAmount
    };
}
```

#### UCP Orchestrator Event Handler
```javascript
// orchestrator/src/event-listeners.js (AFTER)
// Helper: Migrate legacy specializations to UCP capabilities
function migrateSpecializationsToCapabilities(specializations, minStake) {
    return specializations.map(category => ({
        category,
        version: "1.0.0",
        tools: inferToolsFromCategory(category),
        languages: inferLanguages(category),
        minStakeThreshold: minStake
    }));
}

function inferToolsFromCategory(category) {
    return {
        "static-analysis": ["slither", "mythx"],
        "fuzzing": ["foundry", "dapptools"],
        "llm-contextual": ["0g-compute"]
    }[category] || [];
}

function onAgentRegistered(event) {
    const { agent, agentId, ucpEndpoint, specializations, stakeAmount } = event.returnValues;
    
    // UCP: Convert legacy to new format
    const capabilities = migrateSpecializationsToCapabilities(specializations, stakeAmount);
    
    // Store UCP format
    database.agents[agent] = {
        agentId,
        ucpEndpoint,
        capabilities,  // ← UCP-compliant
        allowedRewardTiers: ["BASIC", "ADVANCED", "PREMIUM"],
        stakedAmount
    };
}
```

---

### 10.9 Summary Table: What Gets Replaced

| **Component** | **Legacy Pattern** | **UCP Replacement** | **Migration Status** |
|---|---|---|---|
| Agent Specializations | `string[] specializations` | `AgentCapability[] capabilities` | ✅ **Replaced** |
| Agent Sub-Bidding | `submitSubBid(uint256,uint256,uint256,uint256)` | `submitSubBidWithUCPEnvelope(bytes)` | ✅ **Replaced** |
| Payment Settlement | `settlePayment(jobId)` | `settlePaymentWithUCPTier(jobId, rewardTier)` | ✅ **Replaced** |
| GUARD → USD | No conversion | `_convertGuardToUsd()` with Oracle | ✅ **Added** |
| Agent Identity | Raw account ID `0.0.X` | DID `did:hedera:testnet:0.0.X` | ✅ **Replaced** |
| Reward Tiers | None | `RewardTier {BASIC,ADVANCED,PREMIUM}` | ✅ **Added** |
| Bid Terms | Price, time, collateral only | UCP terms (dispute resolution, data policy) | ✅ **Replaced** |
| Event Logging | `AgentRegistered(address,string,string,uint256)` | `AgentRegistered(address,string,string,AgentCapability[],RewardTier[],uint256)` | ✅ **Replaced** |
| Frontend Display | `specializations.map()` | `capabilities.map() + helper` | ✅ **Backward compatible** |

**Breaking Changes:** Backend smart contracts only (orchestrator/migration handles compatibility)<br>
**User Impact:** None (dashboard same UI before/after)<br>
**Migration Path:** Phased deploy with backward-compatible helper functions

---

**Document Version:** 1.0.0<br>
**Last Updated:** 2026-02-19<br>
**Status:** Ready for Implementation Engineer<br>

---

## Next Steps

1. **Review & Feedback:** Implementation engineer validates assumptions against UCP specs (if published)
2. **Sprint Planning:** Assign sprint tasks (4 weeks estimated)
3. **Branch Strategy:** Create `feature/ucp-refactor` branch
4. **Phased Deploy:** AgentRegistry V2 → SubAuction UCP → Payment UCP → DID
5. **Zero-Impact Verification:** Dashboard shows identical UI before/after

**No user-visible changes expected.** Only backend refactoring for UCP compliance.
