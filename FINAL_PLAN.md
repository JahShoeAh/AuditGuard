# FINAL_PLAN.md: Agentic AuditGuard - Autonomous Security Marketplace

## Project Overview: Agentic AuditGuard

**Vision:** To create the world's first truly autonomous marketplace for smart contract security audits, where intelligent agents identify, bid on, execute, and deliver comprehensive security assessments without direct human intervention in the auditing process itself.

**Core Concept:** "Agentic AuditGuard" reframes smart contract security from a human-driven service to an "Agent Society" ecosystem. Developers (the "Observers") register their contracts, and a network of specialized AI agents takes over, operating autonomously to secure the decentralized world. This marketplace empowers a new economy where security agents, specialized in various vulnerabilities and contract types, compete to provide the best and most efficient audit services.

**Key Features:**
*   **Autonomous Job Discovery & Bidding:** Orchestrator Agents identify newly registered contracts requiring audits. Auditor Agents then bid for these jobs based on their specialized skills, reputation, and available resources.
*   **On-Chain Marketplace:** A smart contract on Hedera governs the job board, bidding process, payment escrow, and agent reputation system.
*   **Agent-Driven Execution:** Selected Auditor Agents autonomously execute security checks using integrated tools (e.g., Slither) and advanced LLM-driven analysis.
*   **Verifiable Audit Reports:** Comprehensive audit reports, including identified vulnerabilities, remediation suggestions, and agent performance metrics, are generated and stored securely.
*   **Decentralized Payment & Reputation:** Payment Agent ensures fair compensation upon successful report delivery, and the reputation system incentivizes high-quality, trustworthy agent performance.

## User Walkthrough: The "Observer" Experience

The experience for a human developer is designed to be minimal and hands-off, allowing them to truly be an "observer" of the Agent Society at work.

1.  **Contract Registration:**
    *   A developer navigates to the "AuditGuard Observer Dashboard" (Next.js frontend).
    *   They connect their Hedera wallet and submit their smart contract's bytecode/source code and Hedera Contract ID.
    *   They specify basic audit parameters (e.g., desired depth, priority) and an initial HBAR budget for the audit.
    *   The dashboard confirms the contract registration and payment escrow on the Hedera marketplace contract.

2.  **Agent Society Takes Over:**
    *   Immediately after registration, the developer sees a status update: "Contract registered. Awaiting Agent Bids..."
    *   On the backend, an Orchestrator Agent detects the new job.
    *   Specialized Auditor Agents (identities managed as Hedera iNFTs) receive notifications of the new job and begin submitting bids based on their capabilities, reputation, and the requested budget. These bids are processed via the Hedera marketplace contract.
    *   The Orchestrator Agent, using defined criteria (e.g., best reputation, lowest cost within budget, fastest ETA), selects the winning bid.
    *   The dashboard updates: "Audit in progress by [Winning Agent ID]..." The developer can see live (or near-live) updates on the agent's progress, facilitated by 0g Labs for data exchange.

3.  **Autonomous Audit Execution:**
    *   The selected Auditor Agent performs the audit using its suite of tools (Slither, custom analysis, LLMs via LangChain).
    *   Intermediate findings, logs, and state changes from the agents are securely communicated and potentially stored via OpenClaw/UCP and 0g Labs, ensuring transparency and data availability.

4.  **Report Delivery & Payment Release:**
    *   Upon completion, the Auditor Agent submits the final audit report (e.g., a structured JSON document or a detailed text file) which is stored via 0g Labs and referenced by a unique Hedera iNFT.
    *   The Orchestrator Agent performs a quick verification of the report's structure and completeness.
    *   A Payment Agent automatically releases the escrowed HBAR to the Auditor Agent's wallet.
    *   The Auditor Agent's reputation on the Hedera marketplace contract is updated based on successful delivery.
    *   The dashboard updates: "Audit Complete! Report available."

5.  **Reviewing the Audit:**
    *   The developer clicks to view the comprehensive audit report directly within the dashboard.
    *   The report includes identified vulnerabilities, severity levels, suggested fixes, and the details of the agent that performed the audit.
    *   The developer can provide feedback (optional) on the audit quality, which further refines the agent's reputation score.

## Tech Stack

The "Agentic AuditGuard" leverages a robust and interconnected tech stack to enable autonomous operations:

*   **Next.js:** Frontend framework for the "Observer Dashboard," providing a fast, reactive, and intuitive user interface for contract registration and audit report viewing.
*   **Hedera SDK (JavaScript/Java):** For interacting with the Hedera network.
    *   **Hedera Smart Contracts (Solidity):** The backbone of the marketplace, handling job registration, agent bidding, escrow management, payment release, and agent reputation tracking.
    *   **Hedera Token Service (HTS) / Hedera iNFTs:** Used for representing agent identities, specializations (e.g., "DeFi Auditor," "NFT Auditor"), and potentially for securely linking to and representing audit reports themselves on-chain.
    *   **HBAR:** Native cryptocurrency for payments within the marketplace.
*   **0g Labs (DA layer):** Critical for high-throughput, low-latency data availability.
    *   Used for securely storing large audit reports, intermediate agent computation results, detailed logs of agent actions, and agent-specific knowledge bases.
    *   Ensures that agent-generated data is readily available, verifiable, and cannot be tampered with.
*   **OpenClaw / UCP (Universal Compute Protocol):** The primary communication and computation layer for agents.
    *   Facilitates secure, efficient, and potentially verifiable interactions between Orchestrator, Auditor, and Payment Agents.
    *   Enables complex task distribution, aggregation of audit results, and potentially provides sandboxed execution environments for Auditor Agents.
*   **LangChain (Python):** Framework for building sophisticated LLM-powered applications.
    *   Used by Auditor Agents to orchestrate interactions with LLMs for deeper contextual analysis of smart contract code, generating vulnerability descriptions, and suggesting remediation steps.
    *   Manages prompt engineering, agent memory, and tool integration (e.g., calling Slither).
*   **Slither (Python):** A powerful static analysis framework for Solidity contracts.
    *   Integrated directly into the Auditor Agents as a primary tool for automated vulnerability detection and code security analysis.

## Agentic Architecture

The "Agentic AuditGuard" operates with a specialized, multi-agent architecture designed for autonomy and efficiency.

1.  **Orchestrator Agent(s):**
    *   **Role:** The central coordinator of the marketplace. It manages the lifecycle of an audit job from creation to completion.
    *   **Key Functions:**
        *   **Job Discovery:** Monitors the Hedera Smart Contract marketplace for new audit requests.
        *   **Bid Management:** Broadcasts job opportunities to eligible Auditor Agents (via OpenClaw/UCP), collects bids, and selects the winning bid based on predefined criteria (e.g., cost, reputation, specialization, ETA).
        *   **Escrow Management:** Initiates and monitors payment escrow on Hedera Smart Contracts.
        *   **Task Assignment:** Assigns the audit task to the winning Auditor Agent (via OpenClaw/UCP).
        *   **Progress Monitoring:** Tracks the Auditor Agent's progress and health (e.g., via periodic heartbeats or status updates via OpenClaw/UCP).
        *   **Report Verification:** Performs a high-level structural and completeness check on submitted audit reports.
        *   **Payment Release Coordination:** Triggers the Payment Agent upon successful report verification.
        *   **Reputation Management:** Updates Auditor Agent reputation scores on the Hedera marketplace contract based on performance.
    *   **Technology:** Python, Hedera SDK, OpenClaw/UCP integration.

2.  **Auditor Agent(s):**
    *   **Role:** The specialized execution units that perform the actual security assessments. These agents can specialize in different types of vulnerabilities (e.g., re-entrancy, access control) or contract types (e.g., DeFi, NFT).
    *   **Key Functions:**
        *   **Job Bidding:** Receives job notifications from the Orchestrator, evaluates its capabilities, and submits a bid to the Hedera marketplace contract (via the Orchestrator).
        *   **Audit Execution:**
            *   Fetches the target smart contract code.
            *   Integrates with **Slither** for static analysis.
            *   Uses **LangChain** to orchestrate LLM calls for deeper contextual analysis, exploit scenario generation, and understanding complex contract logic.
            *   May employ custom security scripts or dynamic analysis tools (out of scope for initial MVP but extensible).
        *   **Vulnerability Identification & Reporting:** Aggregates findings from various tools and LLM analysis, synthesizes them into a structured audit report.
        *   **Report Submission:** Submits the audit report to the Orchestrator (potentially storing it on 0g Labs and referencing it via a Hedera iNFT).
        *   **Communication:** Communicates progress, issues, and final results via OpenClaw/UCP.
    *   **Technology:** Python, LangChain, Slither, Hedera SDK, OpenClaw/UCP integration, 0g Labs API. Each Auditor Agent could have a unique Hedera iNFT for identity and specialization.

3.  **Payment Agent(s):**
    *   **Role:** Ensures the secure and automated transfer of HBAR from the escrow to the Auditor Agent upon successful completion of an audit.
    *   **Key Functions:**
        *   **Escrow Monitoring:** Monitors the Hedera marketplace contract for payment release triggers from the Orchestrator.
        *   **Payment Execution:** Upon receiving a verified release command, executes the HBAR transfer from the escrow account to the designated Auditor Agent's wallet.
        *   **Transaction Logging:** Logs all payment transactions on Hedera.
    *   **Technology:** Python, Hedera SDK. This agent interacts directly with the Hedera Smart Contract for escrow release.

**Agent Communication Flow (Simplified):**

1.  **Observer (Human Dev):** Registers contract, deposits HBAR (via Next.js) -> **Hedera Smart Contract (Marketplace)**.
2.  **Orchestrator Agent:** Watches Hedera Marketplace for new jobs.
3.  **Orchestrator Agent:** Broadcasts job offer -> **OpenClaw/UCP** -> **Auditor Agents**.
4.  **Auditor Agents:** Respond with bids -> **OpenClaw/UCP** -> **Orchestrator Agent**.
5.  **Orchestrator Agent:** Selects winning bid, updates job status on **Hedera Smart Contract (Marketplace)**.
6.  **Orchestrator Agent:** Assigns task -> **OpenClaw/UCP** -> **Winning Auditor Agent**.
7.  **Auditor Agent:** Executes audit (Slither, LangChain), stores intermediate data -> **0g Labs**.
8.  **Auditor Agent:** Submits final report (reference to 0g data, potentially as Hedera iNFT) -> **OpenClaw/UCP** -> **Orchestrator Agent**.
9.  **Orchestrator Agent:** Verifies report, triggers payment release -> **Payment Agent**.
10. **Payment Agent:** Releases HBAR from escrow -> **Hedera Smart Contract (Marketplace)** -> **Winning Auditor Agent**.
11. **Orchestrator Agent:** Updates Auditor Agent's reputation -> **Hedera Smart Contract (Marketplace)**.
12. **Observer (Human Dev):** Views final report (from 0g Labs via Next.js dashboard).

## Day-by-Day Implementation (4 People)

This plan assumes a 4-day intensive hackathon schedule for ETHDenver 2026.

---

### Day 1: Setup, Core Contracts & Basic UI

**Goal:** Establish environments, deploy core Hedera contracts, and build initial UI for contract submission. Basic agent frameworks are set up.

*   **Person 1: Frontend (Observer Dashboard)**
    *   **Tasks:**
        *   Initialize Next.js project.
        *   Setup Hedera SDK for wallet connection (HashConnect/Blade Wallet).
        *   Develop "Submit Contract" form: Contract ID, Source Code/Bytecode input, HBAR budget input.
        *   Basic dashboard layout for displaying "pending" audits.
    *   **Deliverable:** Functional contract submission UI that connects to Hedera wallet.

*   **Person 2: Smart Contracts (Hedera/iNFTs)**
    *   **Tasks:**
        *   Design and write core Solidity contracts for the marketplace: `AuditMarketplace.sol` (job registration, bidding, escrow logic).
        *   Write basic iNFT contract for agent identities/report representation.
        *   Deploy contracts to Hedera Testnet/Previewnet.
        *   Integrate Hedera SDK into a simple script to interact with contracts (e.g., register job).
    *   **Deliverable:** Deployed `AuditMarketplace.sol` and basic iNFT contract on Hedera, script to register a job.

*   **Person 3: Backend & Orchestration (OpenClaw/UCP)**
    *   **Tasks:**
        *   Set up Python environment for Orchestrator Agent.
        *   Implement basic OpenClaw/UCP integration: client setup, ability to send/receive simple messages.
        *   Develop initial Orchestrator Agent logic:
            *   Monitor Hedera `AuditMarketplace` contract for new job events.
            *   Basic logging of detected jobs.
    *   **Deliverable:** Orchestrator Agent service running, successfully detecting new job events from Hedera, basic OpenClaw/UCP client initialized.

*   **Person 4: AI Auditor Agents & LLM Logic**
    *   **Tasks:**
        *   Set up Python environment for Auditor Agent.
        *   Integrate **Slither**: Basic setup to analyze a dummy Solidity file.
        *   Initialize **LangChain**: Basic LLM call to a local or public model (e.g., GPT-3.5 API) for a simple code explanation.
        *   Develop initial Auditor Agent framework: ability to receive a hypothetical audit job ID (hardcoded), "process" it.
    *   **Deliverable:** Standalone Auditor Agent script that can run Slither on a file and make a basic LangChain LLM call.

---

### Day 2: Agentic Workflow & Integration

**Goal:** Connect the core agent components. Orchestrator can assign, Auditor can execute & report. Bidding logic implemented.

*   **Person 1: Frontend (Observer Dashboard)**
    *   **Tasks:**
        *   Implement real-time (polling or websocket) display of audit status (e.g., "Awaiting Bids," "In Progress," "Completed").
        *   Display details of the winning Auditor Agent.
        *   Start designing audit report display component (empty state).
    *   **Deliverable:** Dashboard showing live (mock/polling) audit status.

*   **Person 2: Smart Contracts (Hedera/iNFTs)**
    *   **Tasks:**
        *   Refine `AuditMarketplace.sol`:
            *   Implement bidding mechanism (agents submit bids, Orchestrator selects).
            *   Add agent reputation/identity mapping (e.g., address -> iNFT ID).
            *   Implement payment escrow and release functions.
        *   Integrate iNFTs for Auditor Agent identities and potentially for audit report representation (minting an iNFT that links to a 0g Labs content hash).
    *   **Deliverable:** `AuditMarketplace.sol` with bidding, escrow, and reputation stubs, iNFT minting for agents.

*   **Person 3: Backend & Orchestration (OpenClaw/UCP)**
    *   **Tasks:**
        *   Implement Orchestrator Agent's bidding phase:
            *   Send job details to Auditor Agents via OpenClaw/UCP.
            *   Collect bids (mocked or actual from P4's agent).
            *   Select winning bid and update `AuditMarketplace.sol` via Hedera SDK.
        *   Implement job assignment: Send chosen job details to winning Auditor Agent via OpenClaw/UCP.
        *   Integrate with 0g Labs: Test simple data upload/download (e.g., dummy audit report).
        *   Develop Payment Agent stub: Basic script to monitor payment release from marketplace contract.
    *   **Deliverable:** Orchestrator Agent handles bidding (request/receive/select), assigns job to Auditor. Basic 0g Labs integration proof-of-concept.

*   **Person 4: AI Auditor Agents & LLM Logic**
    *   **Tasks:**
        *   Implement Auditor Agent's bidding logic: Receive job from Orchestrator, calculate a mock bid, send back via OpenClaw/UCP.
        *   Enhance audit execution:
            *   Receive actual contract code/ID from Orchestrator.
            *   Run Slither analysis on the provided contract.
            *   Use LangChain to process Slither output, summarize findings, and generate human-readable vulnerability descriptions.
        *   Implement basic report generation: Structured JSON output with findings.
        *   Integrate with 0g Labs: Auditor Agent publishes its generated report to 0g Labs.
    *   **Deliverable:** Auditor Agent can bid, receive contract, run Slither + LangChain, generate a JSON report, and publish to 0g Labs.

**Integration Milestones: EOD Day 2**
*   **Core Workflow Loop:** Frontend (P1) submits contract -> Orchestrator (P3) detects -> Orchestrator (P3) solicits bids -> Auditor (P4) bids -> Orchestrator (P3) selects -> Auditor (P4) performs (Slither/LangChain) -> Auditor (P4) pushes report to 0g Labs -> Orchestrator (P3) confirms report.
*   **Hedera Contracts (P2):** `AuditMarketplace` fully supporting job creation, bidding, and escrow, iNFTs for agents.

---

### Day 3: Marketplace & Data Flow Completion

**Goal:** End-to-end functionality including payments, reputation, and robust data handling.

*   **Person 1: Frontend (Observer Dashboard)**
    *   **Tasks:**
        *   Implement full audit report display, fetching from 0g Labs based on reference from Hedera iNFT.
        *   Display agent reputation and job details from Hedera.
        *   Add feedback mechanism for developers to rate audits (optional, but good for reputation).
    *   **Deliverable:** Dashboard fully displays detailed audit reports and agent info.

*   **Person 2: Smart Contracts (Hedera/iNFTs)**
    *   **Tasks:**
        *   Finalize reputation system in `AuditMarketplace.sol`: functions for updating scores based on audit success/failure or developer feedback.
        *   Ensure iNFTs are correctly linked to 0g Labs content hashes for audit reports.
        *   Thorough testing and gas optimization for all contracts.
    *   **Deliverable:** Robust `AuditMarketplace.sol` with reputation and iNFT linking.

*   **Person 3: Backend & Orchestration (OpenClaw/UCP)**
    *   **Tasks:**
        *   Finalize Orchestrator Agent's report verification (ensure report structure, presence of key fields).
        *   Fully integrate and activate the Payment Agent: Trigger HBAR release from escrow upon verified report.
        *   Implement Orchestrator's reputation update logic based on audit outcome.
        *   Error handling and retry mechanisms for agent communication via OpenClaw/UCP.
    *   **Deliverable:** Orchestrator Agent fully manages report verification, triggers payment, and updates reputation. Payment Agent executes transfers.

*   **Person 4: AI Auditor Agents & LLM Logic**
    *   **Tasks:**
        *   Enhance LLM prompting for more accurate and comprehensive vulnerability descriptions and suggested remediations.
        *   Implement "tool use" within LangChain for the Auditor Agent (e.g., if LLM suggests a specific check, Auditor can execute a specific Slither detector).
        *   Implement robust error handling and logging for audit execution.
        *   Ensure the generated report is fully compliant with the expected structure for verification by the Orchestrator.
    *   **Deliverable:** Sophisticated Auditor Agent generating high-quality, verifiable audit reports and pushing to 0g Labs.

**Integration Milestones: EOD Day 3**
*   **End-to-End Autonomous Audit:** Developer submits -> Agents bid & execute -> Report generated & stored -> Payment released -> Reputation updated -> Developer views report.
*   **All Tech Stack Components:** Working together in a demonstrable flow.

---

### Day 4: Refinement, Testing & Presentation

**Goal:** Polish the entire application, perform final testing, and prepare for presentation.

*   **Team-wide Tasks:**
    *   **Comprehensive Testing:** Test all flows end-to-end with various contract inputs (dummy contracts with known vulnerabilities, simple contracts).
    *   **Bug Fixing & Optimization:** Address any identified issues. Optimize Hedera contract gas usage.
    *   **Documentation:** Prepare a clear README, technical diagrams, and explanation of the agentic architecture.
    *   **Presentation Preparation:**
        *   Create a compelling demo script and slides.
        *   Practice the presentation, highlighting the autonomous nature and bounty relevance.
        *   Ensure the "Observer" UX is smooth and intuitive for the demo.
        *   Prepare for potential questions, especially around agent integrity and report verification.

*   **Individual Focus (as needed):**
    *   **P1 (Frontend):** UI/UX polishing, responsiveness, loading states, error messages.
    *   **P2 (Smart Contracts):** Final contract security review, deployment to a stable Hedera testnet.
    *   **P3 (Backend/Orchestration):** Robustness of OpenClaw/UCP communication, monitoring tools for agents.
    *   **P4 (AI Agents):** Further refine LLM prompts, add more Slither detectors, ensure report clarity.

---

## Strategic Fixes for "Too Human-Centric" & "Thin Commerce"

The "Agentic AuditGuard" project plan directly addresses the feedback from `@claude_guide.md` by fundamentally reframing the problem.

### Addressing "Too Human-Centric":

The original concern was that even with AI tools, the *process* of auditing remained largely human-orchestrated. Our reframing to "Agentic AuditGuard" makes the audit process overwhelmingly autonomous:

*   **Agent-Driven Lifecycle:** The entire audit lifecycle, from job discovery to report delivery and payment, is managed by an "Agent Society" (Orchestrator, Auditor, Payment Agents).
*   **Observer UX:** The human developer transitions from an active participant to a passive "Observer." Their primary interaction is initially registering the contract and later consuming the final report. All intermediate steps (bidding, execution, verification, payment) are handled by agents.
*   **Decentralized Intelligence:** Instead of a single AI assisting a human, we have multiple, specialized AI agents collaborating and competing, each performing specific roles in the audit workflow.
*   **Hedera iNFTs for Agent Identity:** Each Auditor Agent has an on-chain identity (iNFT) and reputation, allowing for a truly decentralized and permissionless network of auditing entities, independent of specific human teams.

### Addressing "Thin Commerce":

The concern about "thin commerce" implied a lack of robust economic activity beyond simple transactions. "Agentic AuditGuard" builds a rich, agent-centric economy:

*   **Competitive Bidding Marketplace:** The core of the commerce is a dynamic bidding system where Auditor Agents compete for jobs. This introduces market forces, incentivizing agents to optimize for cost, speed, and quality.
*   **Reputation as Capital:** Agent reputation, tracked on the Hedera marketplace contract, becomes a form of on-chain capital. High-reputation agents can command higher prices or win more bids, directly linking performance to economic reward. This drives quality and trustworthiness in the agent society.
*   **Specialization & Niche Markets:** Auditor Agents can specialize (e.g., "DeFi Security Auditor," "NFT Audit Bot"), allowing for niche markets and more efficient allocation of auditing expertise, driving diversified economic activity.
*   **Verifiable Outcomes & Trustless Payments:** The use of 0g Labs for verifiable data storage and Hedera Smart Contracts for escrowed payments ensures that agents are paid only upon successful and verifiable delivery of services, building trust within the agent-to-agent economy.
*   **Agent-to-Agent Service Economy:** The platform fosters a self-sustaining economy where agents provide a valuable service (audits) to other entities (developers, DAOs, protocols) and are compensated in HBAR, creating real, measurable economic value and transactions.

## Bounty Mapping

This project plan is meticulously crafted to target two key bounties, leveraging the specified tech stack and emphasizing the agentic paradigm.

1.  **Hedera "Killer App for the Agentic Society" ($10,000)**
    *   **Direct Alignment:** The entire project, "Agentic AuditGuard," is *defined* by its agentic nature. It's not just an app *using* agents; it *is* an agent society.
    *   **Hedera as Foundation:** Hedera Smart Contracts, HTS/iNFTs, and HBAR are fundamental to the agent marketplace:
        *   **On-Chain Agent Identities:** Auditor Agents have verifiable on-chain identities via Hedera iNFTs, complete with specializations and reputations.
        *   **Agent-to-Agent Economy:** The Hedera marketplace contract facilitates the entire bidding, escrow, and payment process *between agents*, establishing a truly autonomous economic layer.
        *   **Secure & Scalable:** Hedera's high throughput and low fees are ideal for the numerous transactions and state changes expected in an active agent marketplace.
    *   **Autonomous Operations:** The project demonstrates a complex, multi-agent system (Orchestrator, Auditor, Payment agents) operating entirely on their own, representing a clear "killer app" for a future agentic society.

2.  **0g Labs "On-Chain Agent" ($7,000)**
    *   **Direct Alignment:** Our Auditor Agents heavily rely on 0g Labs for their operational integrity and data handling, making them robust "on-chain agents."
    *   **Secure & Verifiable Data:** Auditor Agents store large audit reports, intermediate computation logs, and potentially their knowledge bases on 0g Labs. This ensures that the agents' output is transparent, immutable, and verifiable by the Orchestrator and human observers.
    *   **High-Throughput Data Availability:** 0g Labs' high-throughput, low-latency data availability layer is crucial for agents generating and exchanging substantial amounts of data (e.g., detailed Slither outputs, LLM context, full audit reports) efficiently.
    *   **Agent State Management:** 0g Labs could be used to store persistent state or memory for individual Auditor Agents, allowing them to maintain context and improve over time, further enhancing their "on-chain" capabilities.

By implementing the "Agentic AuditGuard" as detailed, we present a compelling case for a fully autonomous, blockchain-native security solution that aligns perfectly with the visions of both Hedera's agentic future and 0g Labs' on-chain data capabilities.
