# AuditGuard

Autonomous agent-based smart contract security audit marketplace built on Hedera Hashgraph.

## System Architecture

```mermaid
flowchart TB
    subgraph Blockchain["Hedera Hashgraph"]
        HCS_D["HCS Discovery Topic"]
        HCS_A["HCS Audit Log Topic"]
        HCS_C["HCS Agent Comms Topic"]
        subgraph Contracts["Smart Contracts (HSCS/EVM)"]
            AR[AgentRegistry]
            AA[AuditAuction]
            SA[SubAuction]
            DM[DataMarketplace]
            PS[PaymentSettlement]
            SM[StakingManager]
            TR[Treasury]
            VF[VaultFactory]
            ABV[AuditBudgetVault]
        end
    end

    subgraph Agents["Autonomous Agent Swarm"]
        SC[Scanner Agent]
        STA[Static Analysis Agent]
        FZ[Fuzzer Agent]
        LLM[LLM Contextual Agent]
        DEP[Dependency Agent]
        RPT[Report Agent]
        ALT[Alert Agent]
    end

    ORCH[Orchestrator]
    DASH[Observer Dashboard]
    INFT[iNFT System + 0g DA]

    SC -->|CONTRACT_DISCOVERED| HCS_D
    HCS_D --> ORCH
    ORCH -->|createAuditJob| AA
    ORCH -->|AUCTION_INVITE| HCS_C
    HCS_C --> STA & FZ & LLM
    STA & FZ & LLM -->|submitBid| AA
    STA & FZ & LLM -->|BID_SUBMITTED| HCS_A
    AA -->|WinnersSelected| ORCH
    STA & FZ & LLM -->|FINDINGS_SUBMITTED| HCS_C
    HCS_C --> RPT
    RPT -->|REPORT_PUBLISHED| HCS_C
    LLM -->|SUB_AUCTION_POSTED| HCS_C
    HCS_C --> DEP
    DEP -->|SUB_RESULT_DELIVERED| HCS_C
    STA -->|createListing| DM
    FZ -->|purchaseData| DM
    ORCH -->|settleJob| PS
    PS --> TR
    HCS_A --> ALT
    ALT -->|ALERT_FIRED| HCS_A
    ORCH --> INFT
    HCS_D & HCS_A & HCS_C --> DASH
    AA & AR & PS --> DASH
```

### Data Flow

1. **Discovery**: Scanner Agent monitors Hedera for new contract deployments, publishes `CONTRACT_DISCOVERED` to HCS
2. **Auction**: Orchestrator creates an on-chain audit job via `AuditAuction.createAuditJob()`
3. **Bidding**: Eligible agents receive invites, calculate dynamic bids, submit on-chain + publish to HCS
4. **Winner Selection**: Orchestrator scores bids (55% reputation, 25% price, 20% speed) and selects winners
5. **Audit**: Winners perform security analysis (static, fuzz, LLM semantic), submit findings hashes
6. **Sub-contracting**: LLM Agent can sub-contract dependency analysis via `SubAuction`
7. **Data Commerce**: Agents buy/sell scan reports on the `DataMarketplace`
8. **Reporting**: Report Agent aggregates findings, detects duplicates, publishes final report
9. **Settlement**: `PaymentSettlement` distributes GUARD atomically to all participants
10. **Reputation**: Agent scores update based on finding accuracy; `StakingManager` handles slashing

## Project Structure

```
AuditGuard/
├── agents/                  # 7 autonomous TypeScript agents
│   ├── scanner/             # Monitors chain for new contracts
│   ├── static-analysis/     # Static code analysis
│   ├── fuzzer/              # Fuzz testing
│   ├── llm-contextual/      # Deep semantic analysis + sub-contracting
│   ├── dependency/          # Dependency analysis (sub-contractor)
│   ├── report/              # Finding aggregation + dedup
│   ├── alert/               # Critical finding alerts
│   └── shared/              # Common HCS client, contract client, utils, metrics
├── orchestrator/            # Central coordination service
├── packages/
│   ├── contracts/           # 10 Solidity smart contracts (Hardhat)
│   ├── dashboard/           # React observer dashboard (Vite)
│   ├── inft/                # iNFT schemas, minting, state transitions
│   └── sdk/                 # Shared config (deployed addresses, topic IDs)
└── .env.example             # Required environment variables
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Deploy contracts (requires Hedera testnet account)
cd packages/contracts && npx hardhat run scripts/deploy-all.js --network hedera_testnet

# Run all agents
cd agents && DEMO_MODE=true npx tsx run-all.ts

# Run orchestrator
cd orchestrator && npm start

# Run dashboard
cd packages/dashboard && npm run dev
```

## Tech Stack

- **Blockchain**: Hedera Hashgraph (HTS, HCS, HSCS)
- **Smart Contracts**: Solidity 0.8.24 / Hardhat
- **Agents**: TypeScript / Node.js / tsx
- **Orchestrator**: JavaScript / ES Modules
- **Dashboard**: React 18 / Vite / TailwindCSS / Zustand / Framer Motion
- **iNFT**: 0g Labs DA layer for evolving NFT metadata
- **Token**: GUARD (HTS fungible token, 8 decimals)
