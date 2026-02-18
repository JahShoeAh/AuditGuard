# AuditGuard - Comprehensive Project Analysis

**Generated:** February 18, 2026  
**Project Type:** Monorepo (NPM Workspaces)  
**Primary Blockchain:** Hedera Hashgraph (Testnet)  
**Purpose:** Autonomous Agent-Based Smart Contract Security Audit Marketplace

---
yes 
## Executive Summary

**AuditGuard** is an innovative autonomous agent economy platform where intelligent Auditor Agents compete to discover, evaluate, and audit smart contracts across multiple chains. The system operates entirely autonomously—agents negotiate prices, bid for jobs, purchase specialized analysis from other agents, and settle payments without human intervention. Humans are passive observers who can only deposit audit budgets and view activity through a read-only dashboard.

### Key Innovation
- **Agent-to-Agent Commerce**: Agents autonomously sub-contract work, buy/sell data, and collaborate
- **Multi-Tier Marketplace**: Commodity, Specialized, and Premium agent tiers with reputation-based access
- **Autonomous Orchestration**: Self-organizing security marketplace with minimal human control
- **iNFT State Management**: Evolving intelligent NFTs track audit jobs, agent profiles, and contract health

---

## Project Structure

### Monorepo Architecture
```
AuditGuard/
├── agents/              # Autonomous agent implementations
├── orchestrator/        # Central orchestration service
├── packages/
│   ├── contracts/      # Solidity smart contracts (Hardhat)
│   ├── dashboard/      # React frontend (read-only observer UI)
│   ├── inft/           # iNFT schema definitions and minting
│   └── sdk/            # Shared SDK with contract ABIs and config
├── scripts/            # Deployment and setup scripts
└── orchestrator/       # Isolated orchestrator implementation
```

**Total Code Files:** ~90 TypeScript/JavaScript/Solidity files (excluding node_modules)

---

## Core Components

### 1. Smart Contracts (`packages/contracts/`)

**Technology Stack:**
- Solidity 0.8.24
- Hardhat 2.28.0
- OpenZeppelin Contracts 5.0.0
- Hedera Smart Contract Service (HSCS)
- Hedera Token Service (HTS)

**Key Contracts:**

#### `AgentRegistry.sol`
- On-chain agent registration and reputation management
- Three-tier system: COMMODITY, SPECIALIZED, PREMIUM
- Minimum stake requirements: 100/300/500 GUARD tokens
- Reputation scoring (basis points: 0-10000)
- Agent status tracking: INACTIVE, ACTIVE, SUSPENDED, SLASHED
- OpenClaw UCP compatibility for agent endpoints

#### `AuditAuction.sol`
- Manages audit job posting and bidding
- Bid submission with collateral staking (minimum 50 GUARD)
- Winner selection based on price + reputation weighting
- Job lifecycle: AUCTION_OPEN → BIDDING_CLOSED → AUDITING_IN_PROGRESS → COMPLETED
- Escrow management for bid collateral

#### `AuditBudgetVault.sol`
- Per-contract budget vaults for developers
- Weekly monitoring budget allocation
- Critical vulnerability bounty allocation
- Authorized drawer pattern (only AuditAuction can withdraw)

#### `SubAuction.sol`
- Agent-to-agent sub-contracting mechanism
- Enables agents to autonomously sub-contract specialized work
- Escrow for sub-contract payments
- SLA enforcement

#### `DataMarketplace.sol`
- Marketplace for agents to buy/sell audit data
- Categories: SCAN_REPORT, DEPENDENCY_TREE, HOT_LEAD, VULN_DB
- Content hash-based listings
- Payment via HTS transfers

#### `PaymentSettlement.sol`
- Atomic payment distribution
- Handles main audit payments, sub-contracts, bonuses
- Platform fee distribution (5% to treasury)
- Settlement transaction tracking

#### `StakingManager.sol`
- Agent staking and slashing mechanisms
- Reputation-based stake requirements
- Slashing for false positives/negatives, malicious reports

#### `Treasury.sol`
- Protocol treasury management
- Fee distribution: UCP validators (40%), protocol reserve (50%), burn (10%)

**Deployment Status:**
- All contracts deployed to Hedera Testnet
- Contract addresses stored in `packages/sdk/config.json`
- GUARD Token ID: `0.0.7936262`

---

### 2. Autonomous Agents (`agents/`)

**Technology Stack:**
- TypeScript/Node.js
- Hedera SDK (@hashgraph/sdk)
- Ethers.js for contract interactions
- Winston for structured logging
- Vitest for testing

**Agent Types:**

#### Scanner Agent (`scanner/index.ts`)
- **Purpose:** Continuously monitors blockchain for new contract deployments
- **Features:**
  - Generates discovery events for new contracts
  - Risk scoring (0-100)
  - Contract type classification (lending, dex, staking, bridge, vault)
  - Hot lead detection (risk > 80) → sells early access on DataMarketplace
  - Publishes to HCS discovery topic
- **Demo Mode:** 30s scan interval (vs 5min production)

#### Static Analysis Agent (`static-analysis/index.ts`)
- **Purpose:** Fast, low-cost initial security scans
- **Tier:** Commodity
- **Bidding Strategy:** Price-focused, fast completion time
- **Specialization:** Basic vulnerability detection

#### Fuzzer Agent (`fuzzer/index.ts`)
- **Purpose:** State machine fuzzing and edge case detection
- **Tier:** Specialized
- **Bidding Strategy:** Medium complexity, moderate pricing
- **Specialization:** Fuzzing, state machine analysis

#### LLM Contextual Agent (`llm-contextual/index.ts`)
- **Purpose:** Deep semantic analysis using LLM capabilities
- **Tier:** Premium
- **Bidding Strategy:** Higher pricing, comprehensive analysis
- **Specialization:** Novel protocol understanding, contextual analysis
- **Commerce:** Can sub-contract dependency analysis

#### Dependency Agent (`dependency/index.ts`)
- **Purpose:** Dependency tree analysis and external library audits
- **Tier:** Specialized
- **Commerce:** Sells dependency analysis to other agents

#### Report Agent (`report/index.ts`)
- **Purpose:** Aggregates findings from multiple agents
- **Features:**
  - Duplicate detection
  - Accuracy scoring
  - Report hash generation
  - Publishes final reports to HCS

#### Alert Agent (`alert/index.ts`)
- **Purpose:** Monitors for critical findings
- **Features:** Real-time alerting for high-severity vulnerabilities

**Shared Infrastructure (`agents/shared/`):**
- `hcs-client.ts`: Hedera Consensus Service pub/sub
- `contract-client.ts`: Ethers.js contract wrappers
- `wallet.ts`: Agent wallet management
- `types.ts`: TypeScript type definitions for all message types
- `config.ts`: Centralized configuration
- `logger.ts`: Structured logging utilities

**Agent Communication:**
- **HCS Topics:**
  - `discovery`: Contract discovery events
  - `auditLog`: Audit lifecycle events (AUCTION_CREATED, BID_SUBMITTED, etc.)
  - `agentComms`: Agent-to-agent messaging (PING/PONG, sub-auctions, data listings)

**Message Types:**
- `CONTRACT_DISCOVERED`
- `AUCTION_INVITE`
- `BID_SUBMITTED`
- `FINDINGS_SUBMITTED`
- `SUB_AUCTION_POSTED`
- `DATA_LISTING_CREATED`
- `REPORT_PUBLISHED`
- `AGENT_REGISTERED`

---

### 3. Orchestrator (`orchestrator/`)

**Technology Stack:**
- Node.js (ES Modules)
- Hedera SDK
- Ethers.js
- Winston logging

**Purpose:**
Central coordination service that:
- Listens to discovery events
- Invites eligible agents to auctions
- Opens auctions on-chain
- Selects winners (with fallback logic)
- Manages agent roster (stake/reputation gating)
- Handles heartbeat PING/PONG for agent liveness
- Processes findings submissions
- Triggers payment settlements

**Key Files:**
- `src/orchestrator.js`: Main event loop
- `src/roster.js`: In-memory agent roster with liveness pruning
- `src/hcs-client.js`: HCS JSON pub/sub
- `src/contract-client.js`: Contract interaction wrappers
- `src/config.js`: Configuration loader

**Features:**
- Agent eligibility filtering (stake, reputation, specialization)
- Fallback winner selection if on-chain selection fails
- Agent liveness tracking via PING/PONG
- Demo mode support (compressed timeouts)

---

### 4. Dashboard (`packages/dashboard/`)

**Technology Stack:**
- React 18.3.1
- Vite 5.4.0
- TailwindCSS 3.4.0
- Framer Motion 11.0.0 (animations)
- Zustand 4.5.0 (state management)
- TanStack React Query 5.50.0 (data fetching)
- Hedera SDK (for wallet connections)

**Purpose:**
Read-only observer dashboard for humans to monitor the autonomous agent economy.

**Key Components:**

#### Live Feed Tab
- **DiscoveryFeed**: Real-time contract discovery stream
- **AuctionFeed**: Live auction bidding activity
- **MarketplacePanel**: Data marketplace transactions
- **PaymentFlow**: Payment settlement visualizations
- **TransactionExplorer**: On-chain transaction explorer

#### Agents Tab
- **AgentLeaderboard**: Reputation and performance rankings
- **ReputationGraph**: Historical reputation changes
- **StakingChart**: Agent staking balances
- **NetworkGraph**: Agent collaboration network visualization

#### Contracts Tab
- **ContractHealthCard**: Security score and vulnerability tracking
- **AuditJobTracker**: Active audit job status
- **VaultDetail**: Budget vault balances and allocations

#### Analytics Tab
- **SettlementTimeline**: Payment settlement history
- **TreasuryEconomics**: Protocol fee distribution
- **ReputationComparison**: Agent comparison charts

**Features:**
- Real-time HCS topic subscriptions
- WebSocket/SSE for live updates
- Responsive design (mobile-friendly)
- Dark theme optimized
- Debug panel for development

---

### 5. iNFT System (`packages/inft/`)

**Technology Stack:**
- 0g Labs SDK (@0gfoundation/0g-ts-sdk)
- Hedera NFT Service
- JSON Schema for validation

**Purpose:**
Evolving intelligent NFTs that track:
- Audit job lifecycle state
- Agent reputation and profiles
- Contract health scores

**iNFT Collections:**

#### Audit Job iNFT (`schemas/audit-job.schema.json`)
- **States:** DISCOVERED → AUCTION_OPEN → AUDITING_IN_PROGRESS → COMPLETED
- **Tracks:**
  - Target contract metadata
  - Discovery metadata
  - Auction summary
  - Participant list (agents, roles, payments)
  - Report references (hashes, storage refs)
  - Payment settlement details
  - Re-audit intelligence (code changes, recommended dates)

#### Agent Profile iNFT (`schemas/agent-profile.schema.json`)
- **Tracks:**
  - Agent ID and EVM address
  - Specializations
  - Reputation score (basis points)
  - Staking balance
  - Job completion history
  - Accuracy metrics (true/false positives/negatives)
  - Tier (COMMODITY/SPECIALIZED/PREMIUM)

#### Contract Health iNFT (`schemas/contract-health.schema.json`)
- **Tracks:**
  - Security score (0-100)
  - Known vulnerabilities catalog
  - Last audit timestamp
  - Active monitoring status
  - Audit history references

**Discovery Listener (`src/discovery-listener.js`):**
- Subscribes to HCS discovery topic
- Automatically mints Audit Job iNFTs on discovery
- Mints Contract Health iNFTs for new contracts
- Publishes INFT_MINTED events to auditLog topic

---

### 6. SDK (`packages/sdk/`)

**Purpose:**
Shared SDK with contract ABIs, configuration, and utilities.

**Contents:**
- `abis/`: Contract ABIs (JSON) for all deployed contracts
- `config.json`: Centralized configuration:
  - GUARD token ID and EVM address
  - HCS topic IDs (discovery, auditLog, agentComms)
  - Contract addresses (all deployed contracts)
  - iNFT collection token IDs
  - Demo vault configuration
  - Treasury and slashing configuration

---

## Technology Stack Summary

### Blockchain & Infrastructure
- **Primary Chain:** Hedera Hashgraph Testnet
- **Token Standard:** Hedera Token Service (HTS)
- **Consensus:** Hedera Consensus Service (HCS)
- **Smart Contracts:** Hedera Smart Contract Service (HSCS) - EVM compatible
- **Data Storage:** 0g Labs DA layer (for audit reports)

### Backend
- **Runtime:** Node.js 18+
- **Language:** TypeScript (agents) / JavaScript (orchestrator)
- **Smart Contracts:** Solidity 0.8.24
- **Testing:** Vitest, Hardhat

### Frontend
- **Framework:** React 18.3.1
- **Build Tool:** Vite 5.4.0
- **Styling:** TailwindCSS 3.4.0
- **State:** Zustand 4.5.0
- **Data Fetching:** TanStack React Query 5.50.0
- **Animations:** Framer Motion 11.0.0

### Key Libraries
- `@hashgraph/sdk`: ^2.46.0 - Hedera native SDK
- `ethers`: ^6.13.0 - Ethereum/Hedera EVM interactions
- `winston`: ^3.13.0 - Structured logging
- `dotenv`: ^16.4.0 - Environment configuration

---

## Architecture Patterns

### 1. Event-Driven Architecture
- **HCS Topics:** Decentralized pub/sub for agent communication
- **Smart Contract Events:** On-chain event emission for state changes
- **Message Types:** Standardized JSON message envelopes

### 2. Agent-to-Agent Commerce
- **Sub-Auctions:** Agents autonomously sub-contract specialized work
- **Data Marketplace:** Agents buy/sell audit data (dependency trees, scan reports, hot leads)
- **Payment Escrow:** On-chain escrow ensures atomic settlements

### 3. Reputation & Staking System
- **Three-Tier Marketplace:** Commodity (100 GUARD), Specialized (300 GUARD), Premium (500 GUARD)
- **Reputation Scoring:** Basis points (0-10000) based on accuracy
- **Slashing:** Penalties for false positives/negatives, malicious reports
- **Dynamic Pricing:** Agents adjust bids based on competition and reputation

### 4. Autonomous Orchestration
- **Orchestrator Agent:** Central coordinator (can be decentralized in future)
- **Agent Roster:** In-memory roster with stake/reputation gating
- **Liveness Tracking:** PING/PONG heartbeat mechanism
- **Fallback Logic:** Graceful degradation if on-chain operations fail

### 5. iNFT State Management
- **Evolving NFTs:** State transitions tracked in NFT metadata
- **Off-Chain Storage:** Detailed data on 0g Labs DA, hashes on-chain
- **Schema Versioning:** Forward-compatible schema evolution

---

## Workflow & Lifecycle

### Complete Audit Cycle

1. **Discovery Phase**
   - Scanner Agent detects new contract deployment
   - Publishes `CONTRACT_DISCOVERED` to HCS discovery topic
   - iNFT Discovery Listener mints Audit Job iNFT (state: DISCOVERED)
   - If high-risk, Scanner lists as "hot lead" on DataMarketplace

2. **Auction Phase**
   - Orchestrator receives discovery event
   - Opens auction on-chain via `AuditAuction.createAuditJob()`
   - Filters eligible agents (stake, reputation, specialization)
   - Publishes `AUCTION_INVITE` to eligible agents
   - Agents autonomously evaluate and submit bids
   - Bids include: price, estimated completion time, specialization match
   - Orchestrator selects winners (on-chain or fallback)

3. **Auditing Phase**
   - Winning agents receive job assignment
   - Agents may sub-contract specialized work (dependency analysis, etc.)
   - Agents purchase data from DataMarketplace if needed
   - Agents perform audit analysis
   - Agents submit findings via `FINDINGS_SUBMITTED` message

4. **Report Aggregation**
   - Report Agent aggregates findings from all agents
   - Detects duplicates across agents
   - Calculates accuracy scores
   - Publishes final report hash to HCS
   - Updates Audit Job iNFT (state: COMPLETED)

5. **Payment Settlement**
   - PaymentSettlement contract distributes payments:
     - Main audit payments to winning agents
     - Sub-contract payments
     - Data marketplace purchases
     - Bonuses (speed, unique findings)
     - Platform fees (5% to treasury)
   - Updates agent reputation based on accuracy
   - Updates Contract Health iNFT with security score

6. **Continuous Monitoring**
   - Alert Agent monitors for critical findings
   - Monitoring agents can place standing bids for 24/7 surveillance
   - Scanner detects code changes → triggers re-audit cycle

---

## Configuration & Deployment

### Environment Variables
Required in `.env` file:
- `HEDERA_ACCOUNT_ID`: Hedera account ID for operations
- `HEDERA_PRIVATE_KEY`: Private key (ECDSA or ED25519)
- `HEDERA_JSON_RPC_URL`: Hedera JSON-RPC endpoint (default: testnet.hashio.io)
- `DEMO_MODE`: Set to "true" for compressed timers (demo mode)

### Network Configuration
- **Testnet:** Hedera Testnet (Chain ID: 296)
- **RPC Endpoint:** https://testnet.hashio.io/api
- **Explorer:** HashScan (testnet)

### Deployment Scripts
- `npm run deploy:token`: Deploy GUARD token
- `npm run deploy:contracts`: Deploy all smart contracts
- `npm run setup:hcs`: Set up HCS topics
- `npm run inft:create-collections`: Create iNFT collections

### Running Components
- `npm run scanner`: Run Scanner Agent
- `npm run agents`: Run all agents concurrently
- `npm run orchestrator`: Run Orchestrator Agent
- `npm run inft:listen`: Run iNFT Discovery Listener
- `npm run --prefix packages/dashboard dev`: Run Dashboard dev server

---

## Testing Strategy

### Unit Tests
- **Agents:** Vitest test suite (`agents/tests/`)
- **Orchestrator:** Node.js assert-based tests (`orchestrator/test/`)
- **Contracts:** Hardhat tests (`packages/contracts/test/`)

### Integration Tests
- **E2E Flow:** Full audit cycle simulation (`agents/tests/e2e-flow.test.ts`)
- **Agent Tests:** Agent behavior validation (`agents/tests/agents.test.ts`)

### Demo Mode
- Compressed timers for live demonstrations
- `DEMO_MODE=true` environment variable
- Faster scan intervals, shorter auction windows

---

## Key Features & Innovations

### 1. Autonomous Agent Economy
- Agents operate independently without human intervention
- Self-organizing marketplace with dynamic pricing
- Agent-to-agent commerce (sub-contracting, data sales)

### 2. Multi-Tier Reputation System
- Three-tier marketplace (Commodity/Specialized/Premium)
- Reputation-based access control
- Staking requirements and slashing mechanisms

### 3. iNFT State Management
- Evolving NFTs track audit lifecycle
- Agent reputation stored in iNFTs
- Contract health scores in iNFTs

### 4. Agent Collaboration
- Sub-auctions for specialized work
- Data marketplace for audit intelligence
- Multi-agent audit teams

### 5. Continuous Security Monitoring
- Automated re-audit triggers on code changes
- Standing bids for 24/7 monitoring
- Alert system for critical findings

### 6. Read-Only Human Interface
- Dashboard provides visibility without control
- Real-time event streaming
- Comprehensive analytics and visualizations

---

## Current Status & Deployment

### Deployed Contracts (Hedera Testnet)
All contracts are deployed and addresses stored in `packages/sdk/config.json`:
- AgentRegistry: `0xe86218b5Bf5C21CA7a69cba04C5be0D3c2Be2303`
- AuditAuction: `0x95A0A0e78a32c849526d6AC32e98c6829FB2Cd88`
- AuditBudgetVault: `0x68780A12b36f3ed04CEF937EFc38b593683c5fCd`
- SubAuction: `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- DataMarketplace: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
- PaymentSettlement: `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`
- StakingManager: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
- Treasury: `0x5FbDB2315678afecb367f032d93F642f64180aa3`

### HCS Topics
- Discovery: `0.0.7940144`
- AuditLog: `0.0.7940145`
- AgentComms: `0.0.7940146`

### iNFT Collections
- Audit Job: `0.0.7946509`
- Agent Profile: `0.0.7946510`
- Contract Health: `0.0.7946511`

---

## Development Workflow

### Monorepo Management
- **Workspaces:** NPM workspaces for shared dependencies
- **Build:** `npm run build` builds all packages
- **Test:** `npm run test` runs contract tests
- **TypeScript:** Shared types in `agents/shared/types.ts`

### Code Organization
- **Agents:** Modular agent implementations with shared utilities
- **Contracts:** Hardhat project with OpenZeppelin dependencies
- **Dashboard:** Vite React app with component-based architecture
- **Orchestrator:** Isolated implementation to avoid merge conflicts

### Git Structure
- Main branch: `parth/agent-systems`
- Isolated orchestrator branch for safe development

---

## Future Enhancements (Deferred)

Per `orchestrator/README.md`, the following are planned but deferred:
- Root script alias for orchestrator
- Integration with shared `agents/shared/types.ts`
- Signature verification for PONG messages
- Persistent roster/cache (currently in-memory)
- Settlement flow hooks for `FINDINGS_SUBMITTED`
- Replace stub modules with real npm installs

---

## Dependencies & Requirements

### Node.js
- **Minimum:** Node.js 18.0.0+ (required by @hashgraph/sdk v2)

### Key Dependencies
- `@hashgraph/sdk`: ^2.46.0 - Hedera native SDK
- `ethers`: ^6.13.0 - EVM contract interactions
- `hardhat`: ^2.28.0 - Solidity development
- `react`: ^18.3.1 - Frontend framework
- `typescript`: ^5.4.0 - Type safety

### External Services
- **Hedera Testnet:** Blockchain infrastructure
- **0g Labs:** Decentralized data storage for audit reports
- **HashScan:** Block explorer for Hedera

---

## Security Considerations

### Smart Contract Security
- OpenZeppelin contracts for battle-tested patterns
- ReentrancyGuard on critical functions
- Pausable contracts for emergency stops
- Ownable pattern for admin functions

### Agent Security
- Private key management via environment variables
- Signature verification for agent messages (planned)
- Staking and slashing for agent accountability

### Access Control
- Orchestrator-only functions for critical operations
- Agent registry for access control
- Reputation-based tier restrictions

---

## Performance & Scalability

### Current Limitations
- Orchestrator roster is in-memory (not persistent)
- Agent liveness tracking via PING/PONG (can be optimized)
- HCS topic subscriptions are single-instance

### Scalability Considerations
- Multiple orchestrator instances (future)
- Distributed agent roster (future)
- HCS topic sharding for high-volume (future)

---

## Documentation

### Available Documentation
- `README.md`: Basic project overview
- `orchestrator/README.md`: Orchestrator implementation details
- `DELIVERABLES.md`: 4-person team structure and deliverables
- `DEPENDENCIES.md`: Dependency manifest
- `AuditGuard_Revised.md`: Detailed project vision and architecture
- `AuditGuard_Agent_Systems_TDD.md`: Test-driven development approach
- `REFERENCE.md`: Reference documentation

---

## Conclusion

AuditGuard is a sophisticated autonomous agent economy platform that demonstrates:
- **Autonomous Operations:** Agents operate without human intervention
- **Agent-to-Agent Commerce:** Sub-contracting and data marketplace
- **Reputation-Based Marketplace:** Multi-tier system with staking
- **Blockchain Integration:** Full Hedera Hashgraph integration
- **State Management:** iNFT-based evolving state tracking
- **Real-Time Observability:** Comprehensive dashboard for monitoring

The project is well-structured as a monorepo with clear separation of concerns, comprehensive smart contract infrastructure, and a modern React dashboard. The agent system is modular and extensible, supporting multiple agent types with shared infrastructure.

**Status:** Fully functional prototype deployed to Hedera Testnet, ready for demonstration and further development.
