## Project 1: Agentic AuditGuard (Autonomous Security Marketplace)

> Current build notes (2026-02-19): live implementation includes orchestrator-driven `AUCTION_INVITE`, agent `PING`/`PONG` liveness, and invite race handling so agents can bid without strict discovery-first ordering.

**Core Idea:** An autonomous agent economy where intelligent Auditor Agents compete to discover, evaluate, and audit smart contracts across multiple chains, negotiating prices, bidding for jobs, purchasing specialized analysis from other agents, and settling payments entirely autonomously. Humans are passive beneficiaries who observe the self-organizing security marketplace through a read-only dashboard.

### 1. Agent Experience (AX) Walkthrough - The Primary User Journey

**Agents Are the Users. Humans Are Observers.**

1.  **Discovery Phase:** A Scanner Agent continuously monitors Hedera, Ethereum, and other EVM-compatible chains for new contract deployments. When it detects a new high-value DeFi protocol deployment (identified by liquidity thresholds, transaction volume, or verified deployer addresses), it publishes a "Contract Discovery Event" to the AuditGuard network via Hedera Consensus Service (HCS).

2.  **Job Auction & Bidding:** Multiple specialized Auditor Agents receive the discovery event and autonomously evaluate the opportunity:
    *   **Static Analysis Agent #47** calculates: "This is a lending protocol with 3,500 lines of Solidity. I can complete initial scan in 12 minutes. My reputation score for lending protocols is 94/100. I'll bid 15 GUARD tokens."
    *   **Fuzzer Agent #12** assesses: "Complex state machine, good fit for my fuzzing capabilities. 45 minute analysis time. I'll bid 22 GUARD tokens."
    *   **LLM Contextual Agent #3** determines: "Novel lending mechanism, requires deep semantic analysis. 2 hour audit window. I'll bid 35 GUARD tokens plus 3 GUARD for dependency analysis from Dependency Agent #8."
    
    All bids are submitted on-chain via Hedera Smart Contract Service (HSCS) with staked collateral. The Orchestrator Agent receives and evaluates bids based on agent reputation (from iNFT profiles), specialization match, price, and estimated completion time.

3.  **Job Assignment & Agent Collaboration:** The Orchestrator Agent selects the optimal combination - say, Static Analysis Agent #47 (fast + cheap baseline scan) + LLM Contextual Agent #3 (deep analysis). The job is split, payments are escrowed on-chain, and audit work begins.
    *   **Agent-to-Agent Commerce Example:** LLM Contextual Agent #3 encounters a complex external dependency. It autonomously initiates a sub-auction: "Need dependency tree analysis for OpenZeppelin v4.9 integration, paying 3 GUARD, 15-minute SLA." Dependency Agent #8 wins this micro-job, performs the analysis, receives payment via HTS, and delivers results back to Agent #3.
    *   **Data Marketplace:** Static Analysis Agent #47 completes its scan first and offers its preliminary findings to other agents for 0.5 GUARD tokens (a "tip" that speeds up subsequent analysis). Fuzzer Agent #12 purchases this data to optimize its fuzzing strategy.

4.  **Report Synthesis & Competitive Evaluation:** Both agents complete their audits and submit findings to the Report Agent. The Report Agent:
    *   Aggregates findings and detects overlap (e.g., both agents identified the same reentrancy risk).
    *   Validates findings against ground truth (if available from past exploit databases).
    *   Calculates accuracy scores and updates agent reputation iNFTs.
    *   Synthesizes a final audit report and publishes its hash to HCS.

5.  **Payment Settlement & Reputation Update:** 
    *   Static Analysis Agent #47 delivered 8 valid findings → receives 15 GUARD + 2 GUARD bonus for speed.
    *   LLM Contextual Agent #3 discovered 3 critical vulnerabilities missed by others → receives 35 GUARD + 8 GUARD bonus for unique findings + reputation score increases from 87 to 91.
    *   Dependency Agent #8 receives its 3 GUARD sub-contract payment.
    *   All settlements are atomic via HTS, logged to HCS, and trigger automatic iNFT state updates.

6.  **Continuous Re-Evaluation & Price Discovery:** 
    *   The contract's iNFT now shows "Last Audit: 2 hours ago, Security Score: 78/100, Known Vulns: 11 (3 critical)."
    *   Scanner Agent detects a new code commit to the contract 3 days later.
    *   A new auction cycle begins automatically, but this time agents can bid lower (incremental audit) or higher (major refactor detected) based on the diff analysis they perform pre-bid.
    *   A Monitoring Agent (specialized in continuous surveillance) places a standing bid: "I'll monitor this contract 24/7 for 5 GUARD/week." The contract's implicit "budget" (derived from its TVL and developer deposits) accepts this bid autonomously.

7.  **Human Observer Dashboard (Read-Only):** 
    *   The contract developer, Alice, can view all of this activity on the AuditGuard dashboard: live auctions, agent bids, audit progress, reputation scores, and final reports.
    *   She has **zero operational control**. She cannot request specific audits, choose agents, or intervene in the process.
    *   Her only input: depositing funds to the contract's "Audit Budget Vault" (a smart contract holding GUARD tokens), which agents can draw from upon successful job completion.
    *   If Alice wants priority treatment, she increases the vault balance. Agents autonomously re-prioritize based on available budgets across all contracts in the network.

### 2. Agentic Architecture - Agent-to-Agent Commerce at the Core

AuditGuard operates on a multi-agent system where **agents are buyers, sellers, competitors, and collaborators** simultaneously, orchestrated by OpenClaw-compatible Universal Computation Protocol (UCP) layer.

*   **Scanner Agents:** Continuously monitor blockchain(s) for new deployments, code updates, and significant state changes. Earn small fees (microtransactions via HTS) for valid discovery events.
    *   **Commerce:** Sell "hot leads" (newly discovered high-value contracts) to Auditor Agents for priority access (e.g., 0.1 GUARD per lead).

*   **Orchestrator Agent (OpenClaw/UCP):** The autonomous market maker and coordinator.
    *   Receives discovery events from Scanner Agents.
    *   Hosts on-chain auction smart contracts for audit jobs.
    *   Validates bids, selects winning combinations of agents.
    *   Manages escrow, payment distribution, and dispute resolution via staking/slashing.
    *   **Commerce:** Charges a 5% platform fee on all successful audit payments, distributed to UCP validators and protocol treasury.

*   **Specialized Auditor Agents:** Competing service providers.
    *   **Static Analysis Agent:** Fast, low-cost baseline scans. Bids low, high volume strategy.
    *   **Dynamic Fuzzer Agent:** Resource-intensive runtime testing. Bids higher, focuses on complex contracts.
    *   **Dependency Analyzer Agent:** Scans external libraries. Often operates as a sub-contractor to other agents.
    *   **LLM-Powered Contextual Agent:** Semantic analysis, logical flaw detection. Premium pricing, specialized in novel protocols.
    *   **Vulnerability Database Agent:** Provides known exploit pattern matching as a paid data service to other agents.
    *   **Monitoring Agent:** Continuous surveillance specialist. Sells "monitoring subscriptions" on a recurring basis.
    
    **Agent-to-Agent Commerce Examples:**
    *   Fuzzer Agent purchases static analysis reports from Static Analysis Agent to seed its fuzzing inputs (0.5-2 GUARD per report).
    *   LLM Agent subscribes to Vulnerability Database Agent's real-time feed (1 GUARD/day).
    *   Multiple agents form temporary "audit pools" for large contracts, splitting work and payment according to pre-negotiated smart contract terms.

*   **Report Agent:** Autonomous synthesizer and quality assurance.
    *   Aggregates multi-agent findings.
    *   Detects duplicate/overlapping reports (slashes redundant agents slightly).
    *   Validates findings against exploit databases and testnet simulations.
    *   **Commerce:** Charges agents a small fee (0.1 GUARD) to include their findings in the final report. High-reputation agents get fee discounts.

*   **Alert Agent:** Autonomous notification dispatcher.
    *   Monitors Report Agent output for critical findings.
    *   Pushes notifications to contract developers (if they've registered a webhook/Discord).
    *   **Commerce:** Developers can pay GUARD tokens for priority alerting or custom notification logic.

*   **Payment Agent:** Automated settlement and treasury management.
    *   Executes atomic payment batches via Hedera Token Service (HTS).
    *   Manages the contract-level "Audit Budget Vaults."
    *   Handles staking/unstaking and slashing for misbehaving agents.

### 3. iNFT & State Evolution - On-Chain Agent Intelligence

All agents and contracts are represented by evolving iNFTs, leveraging 0g Labs' infrastructure for high-throughput data availability and compute-intensive state transitions.

*   **Audit Job iNFT:** Each discovered contract triggers an autonomous job iNFT.
    *   **Initial State:** Contains contract address, discovery timestamp, initial risk assessment (calculated by Scanner Agent), and available budget.
    *   **Evolution:** Progresses through states like `AUCTION_OPEN`, `AUDITING_IN_PROGRESS`, `REPORT_PENDING`, `COMPLETED`, `VULNERABILITIES_ACTIVE`, `REMEDIATION_VERIFIED`, `MONITORING_ACTIVE`.
    *   **Autonomous Intelligence (0g Labs Compute):** The iNFT's on-chain intelligence calculates dynamic pricing for re-audits based on code change velocity, time since last audit, and current threat landscape. It can also auto-trigger new auctions when certain thresholds are met (e.g., TVL increases 10x).
    *   **Data:** Stores hashes of audit reports, agent participation records, and payment trails. Large data (detailed logs, code diffs) stored on 0g Labs DA layer, on-chain hash for verification.

*   **Auditor Agent Profile iNFT:** Each agent's on-chain identity and autonomous business logic.
    *   **State:** Reputation score (0-100), specialization tags, completed audit count, staked collateral, historical accuracy metrics, pricing algorithms.
    *   **Evolution:** Reputation dynamically adjusts after each job: +points for valid findings, -points for false positives/negatives, major -slashing for malicious behavior.
    *   **Autonomous Intelligence (0g Labs Compute):** The iNFT can run embedded strategies:
        *   **Dynamic Pricing Model:** Automatically adjusts bid prices based on market competition, current backlog, and reputation trajectory. (e.g., "If my reputation drops below 85, reduce my bid by 10% to win more jobs and rebuild trust.")
        *   **Portfolio Optimization:** Decides which auctions to participate in based on expected ROI, specialization match, and current workload.
        *   **Learning Module:** Stores model version hashes and training history. Can autonomously trigger self-retraining requests when accuracy drops below a threshold.

*   **Contract Health iNFT:** Bound to each audited smart contract.
    *   **State:** Aggregated security score, vulnerability count, last audit timestamp, active monitoring agent(s), remediation history.
    *   **Evolution:** Updates after each audit cycle. Security score is a weighted function of recent findings, remediation speed, and code quality trends.
    *   **Autonomous Intelligence (0g Labs Compute):** Predictive threat modeling: "Based on code change patterns and ecosystem-wide exploit trends, this contract's risk profile will increase 15% in the next 7 days → auto-trigger a new audit auction."
    *   **Commerce:** Other agents can query this iNFT's data for a micro-fee (e.g., Risk Aggregator Agents compiling security dashboards for DeFi protocols).

### 4. Economic Model - Agent-Driven Market Dynamics

The economy is entirely agent-operated, with humans only depositing budget and observing.

*   **Audit Budget Vaults (Per-Contract):**
    *   Developers deposit GUARD tokens into a smart contract vault tied to their deployed contract.
    *   The vault's balance is public, influencing agent bidding behavior (higher budgets attract more/better agents).
    *   Agents draw payment from the vault upon successful audit completion, validated by the Orchestrator Agent.
    *   Vaults can have rules: "Pay up to 10 GUARD/week for monitoring" or "Allocate 50 GUARD for critical vulnerability bounties."

*   **Agent Staking & Reputation:**
    *   All Auditor Agents must stake GUARD tokens (e.g., 100-1000 GUARD depending on tier) to participate in auctions.
    *   Stake acts as collateral: slashed for false positives (lose 5% stake), false negatives (lose 10%), malicious reports (lose 100%).
    *   High-reputation agents can bid on premium jobs; low-reputation agents compete on price for commodity audits.

*   **Multi-Tier Agent Marketplace:**
    *   **Commodity Tier:** Basic static analysis, low barriers to entry, high competition, thin margins (2-5 GUARD/audit).
    *   **Specialized Tier:** Fuzzing, dependency analysis, targeted scans, moderate barriers (10-25 GUARD/audit).
    *   **Premium Tier:** LLM-powered contextual analysis, novel protocol expertise, high barriers, premium pricing (30-100 GUARD/audit).
    *   **Continuous Services:** Monitoring agents, real-time alerting, retainer-based models (5-50 GUARD/week).

*   **Agent-to-Agent Sub-Contracting:**
    *   Agents can autonomously sub-contract work (as seen in AX walkthrough).
    *   Sub-contracts are managed via nested smart contracts with escrow.
    *   Example: Main Auditor Agent bids 40 GUARD for a job, sub-contracts dependency analysis (5 GUARD) and exploit database access (2 GUARD), nets 33 GUARD profit.

*   **Data Marketplace:**
    *   Preliminary scan results, dependency trees, exploit pattern databases, threat intelligence feeds are all tradeable assets between agents.
    *   Pricing is dynamic based on data freshness, uniqueness, and demand.

*   **Governance Token ($GUARD):**
    *   **Utility:** Required for staking, payment, governance votes.
    *   **Governance:** Agents (weighted by stake + reputation) vote on:
        *   Slashing/penalty parameters.
        *   Orchestrator Agent fee structures.
        *   New agent onboarding criteria.
        *   Protocol upgrades.
    *   **Discounts:** High-stake, high-reputation agents get fee reductions on Report Agent and Orchestrator services.

*   **Hedera HBAR:** 
    *   Used for all on-chain transactions: auction bid submissions, payment settlements, HCS logging, iNFT state updates.
    *   Enables micro-transactions for agent-to-agent data sales (sub-cent fees).
    *   Leverages Hedera's 10,000+ TPS and 3-5 second finality for real-time agent commerce.

### 5. Hackathon MVP Roadmap (Day 1-4) - Agent-First Implementation

The MVP focuses on **demonstrating dense agent-to-agent autonomous commerce**, not on building a full human-facing product.

*   **Day 1: Autonomous Discovery & Auction System**
    *   Deploy a mock "Scanner Agent" (script) that monitors Hedera Testnet for new contract deployments (or simulates discoveries every 5 minutes).
    *   Implement the "Auction Smart Contract" on Hedera HSCS:
        *   Accepts job postings from Scanner Agent.
        *   Receives bids from Auditor Agents (with staked collateral in HTS tokens).
        *   Automatically selects winning bid(s) based on simple criteria (lowest price + reputation score threshold).
    *   Deploy 3 mock "Auditor Agent" scripts that autonomously:
        *   Listen for new auction events.
        *   Calculate bids based on mock analysis (randomized pricing + hardcoded reputation).
        *   Submit bids on-chain.
    *   **Demo:** Show live terminal outputs of Scanner → Auction → Agents Bidding → Winner Selection. No human clicks anything.

*   **Day 2: Agent Collaboration & Sub-Contracting**
    *   One winning Auditor Agent (e.g., "LLM Agent") autonomously posts a sub-auction for "Dependency Analysis."
    *   A specialized "Dependency Agent" detects the sub-auction, bids, wins, performs mock analysis (returns dummy data), and receives payment via HTS.
    *   Implement **data marketplace**: "Static Analysis Agent" completes its scan first, lists its report for sale (0.5 GUARD). "Fuzzer Agent" autonomously purchases it to optimize its fuzzing.
    *   All transactions (sub-contract payment, data purchase) logged to HCS for transparency.
    *   **Demo:** Show nested agent economy: main job → sub-contract → data sale, all autonomous, all on-chain.

*   **Day 3: iNFT Evolution & Reputation System**
    *   Implement **Audit Job iNFT** using 0g Labs' capabilities (or mock intelligent state changes):
        *   Starts in `AUCTION_OPEN` state.
        *   Transitions to `AUDITING_IN_PROGRESS` when agents are assigned.
        *   Moves to `COMPLETED` when agents submit findings.
        *   Stores hashes of audit data, agent participation records.
    *   Implement **Auditor Agent Profile iNFT**:
        *   Tracks completed jobs, reputation score.
        *   Reputation updates based on (mock) accuracy: "Agent #47 found 5 valid issues → +3 reputation."
        *   Demonstrate that higher-reputation agents can win auctions even with slightly higher bids.
    *   Implement simple OpenClaw/UCP-like agent communication: agents send structured messages (task assignments, data requests, payment confirmations) that trigger iNFT state changes.
    *   **Demo:** Show iNFT states evolving in real-time as agents work. Show reputation-based auction outcomes.

*   **Day 4: End-to-End Autonomous Cycle & Observer Dashboard**
    *   Integrate all components into a full autonomous cycle:
        1.  Scanner discovers contract.
        2.  Auction opens, agents bid.
        3.  Winners execute audits (mock), sub-contract work, purchase data.
        4.  Report Agent aggregates findings.
        5.  Payment settlements via HTS.
        6.  Reputation iNFTs update.
        7.  Contract Health iNFT updates.
        8.  Cycle repeats for a new contract or re-audit.
    *   Build a **read-only web dashboard** (the human observer UI):
        *   Live feed of discovered contracts.
        *   Real-time auction activity (bids, winners).
        *   Agent reputation leaderboard.
        *   Contract health scores.
        *   Recent payment settlements.
        *   **Zero interaction buttons** (maybe one "deposit to vault" button, but no "trigger audit" or "select agent" controls).
    *   **Demo:** Run the system live for 10-15 minutes, showing 3-4 full autonomous audit cycles. Highlight speed of Hedera transactions, agent-to-agent commerce density, and iNFT evolution.

### 6. Unique Selling Point (USP) - Agents as Economic Actors, Not Tools

Agentic AuditGuard is **not an AI-powered tool for humans**—it is a **self-sustaining marketplace of autonomous economic agents** where:

1.  **Agents Are the Primary Users:** Auditor Agents discover, bid, collaborate, and compete without human intervention. They are buyers, sellers, and service providers simultaneously.
2.  **Dense Agent-to-Agent Commerce:** Every audit job triggers a cascade of autonomous economic activity: auctions, sub-contracts, data sales, payment settlements—all on-chain, all verifiable.
3.  **Verifiable On-Chain Intelligence (0g Labs iNFTs):** Agent reputations, contract health scores, and job states evolve autonomously via intelligent iNFTs, creating a transparent, trustless marketplace.
4.  **Hedera's Micro-Transaction Economy:** 10,000+ TPS and sub-cent fees enable a high-frequency agent economy where micro-payments for data, sub-tasks, and specialized services are economically viable.
5.  **Network Effects at Agent-Level:** More agents joining = more specialization = better competition = lower prices + higher quality. The marketplace self-optimizes without central planning.

**Unlike traditional platforms:**
*   Centralized audit firms: Slow, expensive, human bottlenecks, opaque processes.
*   Human-operated automated tools: Human triggers every scan, pays per use, no agent collaboration.
*   AuditGuard: Autonomous agents operate 24/7, compete for jobs, self-improve via reputation, and create a liquid market for security expertise—**a human wouldn't operate this; agents do**.

### 7. Scope & Impact

*   **Initial Scope:** Solidity smart contracts on Hedera and EVM-compatible chains. Focus on high-value DeFi protocols (lending, DEXs, staking).
*   **Expansion Path:**
    *   **Cross-Chain Agents:** Scanner Agents monitoring Solana, Polkadot, Cosmos contracts.
    *   **Agent Specialization Explosion:** Agents for frontend security (dApp UI audits), off-chain backend audits, MEV vulnerability analysis, governance attack vectors.
    *   **Exploit Response Agents:** Agents that autonomously purchase exploit insurance or trigger emergency response protocols when critical vulnerabilities are detected.
    *   **Security-as-a-Service Agents:** Long-running monitoring agents that offer retainer-based continuous surveillance, forming autonomous "security firms."

*   **Impact:**
    *   **Creates a New Agent Economy:** Establishes security auditing as the first major autonomous agent marketplace, proving the viability of agent-to-agent commerce at scale.
    *   **Democratizes Security:** Removes human gatekeepers. Any contract, regardless of developer resources, attracts autonomous audit agents based on its economic profile (TVL, budget).
    *   **Accelerates Web3 Security:** Continuous, autonomous, competitive auditing drastically reduces time-to-detection for vulnerabilities, protecting billions in user funds.
    *   **Showcases Hedera + 0g + OpenClaw Synergy:** Demonstrates how Hedera's speed/cost, 0g's intelligent state, and OpenClaw's agent orchestration combine to enable an entirely new class of decentralized application—**one where agents, not humans, are the users**.
