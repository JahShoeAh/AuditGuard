# Integrating External Security Agents into AuditGuard

## Overview

AuditGuard is designed to support a heterogeneous swarm of security agents. You can integrate:
- **OpenClaw agents** (for UCP-compliant agent-to-agent commerce)
- **HuggingFace models** (for ML-based vulnerability detection)
- **Existing security tools** (Slither, Mythril, Semgrep as agents)
- **Custom AI agents** (LangChain, AutoGPT, CrewAI)

This guide covers all integration paths with step-by-step instructions.

---

## Understanding AuditGuard's Agent Architecture

### Current Agent Structure

```
agents/
├── scanner/              # Monitors chain for new contracts
├── static-analysis/      # Solidity AST analysis
├── fuzzer/              # Property-based fuzz testing
├── llm-contextual/      # AI semantic analysis (uses 0g Compute)
├── dependency/          # Dependency graph analysis
├── report/              # Finding aggregation
├── alert/               # Critical finding alerts
└── shared/              # Common utilities (HCS, contracts, types)
```

### Agent Lifecycle

```
1. REGISTRATION
   ↓
   Agent registers on-chain via AgentRegistry.register()
   Stakes GUARD tokens
   Receives unique agent ID

2. DISCOVERY
   ↓
   Orchestrator publishes AUCTION_INVITE to HCS
   Agent listens to HCS agentComms topic

3. BIDDING
   ↓
   Agent calculates bid (price, time estimate)
   Submits bid on-chain via AuditAuction.submitBid()

4. EXECUTION
   ↓
   If selected as winner:
     - Fetches contract bytecode/source
     - Runs security analysis
     - Submits findings hash on-chain
     - Publishes findings to HCS

5. SETTLEMENT
   ↓
   PaymentSettlement distributes GUARD tokens
   AgentRegistry updates reputation score
```

### Key Integration Points

| Component | What It Does | How External Agents Use It |
|-----------|--------------|---------------------------|
| **AgentRegistry** | On-chain agent registration | Call `register(agentId, ucpEndpoint, specializations)` |
| **HCS Topics** | Agent coordination | Subscribe to `agentComms` topic (0.0.7940146) |
| **AuditAuction** | Job bidding | Call `submitBid(jobId, amount, timeEstimate)` |
| **Contract Fetcher** | Get target contract | Read bytecode/source from Hedera |
| **Finding Submitter** | Publish results | Call `submitFindings(jobId, findingsHash)` |

---

## Integration Option 1: OpenClaw Agents (RECOMMENDED for Agent-Native Apps)

### Why OpenClaw?

- ✅ **UCP-compliant** - Standardized agent-to-agent commerce
- ✅ **Agent discovery** - Built-in registry and communication
- ✅ **Task marketplace** - Natural fit for audit bidding
- ✅ **Hedera-native** - Designed for Hedera ecosystem

### Prerequisites

```bash
npm install @openclaw/sdk @openclaw/agent-core
```

### Step 1: Create OpenClaw Agent Adapter

Create `agents/openclaw-adapter/src/index.ts`:

```typescript
import { OpenClawAgent, Task, Bid } from '@openclaw/agent-core';
import { ethers } from 'ethers';
import { Client, PrivateKey } from '@hashgraph/sdk';

// Import AuditGuard shared utilities
import { HCSClient } from '../../shared/hcs-client';
import { ContractClient } from '../../shared/contract-client';
import config from '../../../packages/sdk/config.json';

interface AuditTask extends Task {
  contractAddress: string;
  jobId: number;
  budget: number;
  deadline: number;
}

interface AuditResult {
  findings: Finding[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  confidence: number;
}

class OpenClawSecurityAgent extends OpenClawAgent {
  private hcsClient: HCSClient;
  private contractClient: ContractClient;
  private agentId: string;

  constructor(agentId: string, privateKey: string) {
    super({
      agentId,
      capabilities: ['smart_contract_audit', 'vulnerability_detection'],
      ucpEndpoint: `https://api.myagent.io/${agentId}`, // Your agent's API endpoint
    });

    this.agentId = agentId;
    this.hcsClient = new HCSClient(/* ... */);
    this.contractClient = new ContractClient(/* ... */);
  }

  /**
   * OpenClaw calls this when a new task is available
   */
  async evaluateTask(task: AuditTask): Promise<Bid | null> {
    // Check if we can handle this task
    if (!this.canAudit(task.contractAddress)) {
      return null; // Decline task
    }

    // Calculate bid based on complexity
    const complexity = await this.estimateComplexity(task.contractAddress);
    const bidAmount = this.calculatePrice(complexity, task.budget);
    const timeEstimate = this.estimateTime(complexity);

    // Return bid following UCP format
    return {
      taskId: task.id,
      amount: bidAmount,
      currency: 'GUARD',
      estimatedDuration: timeEstimate,
      confidence: 0.85, // How confident we are in delivering
      metadata: {
        agentType: 'openclaw-security',
        specialization: this.getSpecialization(),
      },
    };
  }

  /**
   * OpenClaw calls this when we win the bid
   */
  async executeTask(task: AuditTask): Promise<AuditResult> {
    console.log(`[OpenClawAgent] Executing audit for job ${task.jobId}`);

    // 1. Fetch contract source/bytecode
    const contractCode = await this.fetchContract(task.contractAddress);

    // 2. Run your security analysis (this is where your agent's logic goes)
    const findings = await this.runSecurityAnalysis(contractCode);

    // 3. Submit findings to AuditGuard
    await this.submitToAuditGuard(task.jobId, findings);

    // 4. Return results to OpenClaw
    return {
      findings,
      severity: this.calculateOverallSeverity(findings),
      confidence: 0.9,
    };
  }

  /**
   * Your agent's core security logic
   */
  private async runSecurityAnalysis(code: string): Promise<Finding[]> {
    // OPTION A: Use your existing security tool
    // const slitherResults = await this.runSlither(code);
    // return this.parseSlitherOutput(slitherResults);

    // OPTION B: Use ML model from HuggingFace
    // const model = await this.loadHuggingFaceModel('security-model');
    // return await model.detectVulnerabilities(code);

    // OPTION C: Use LangChain agent
    // const langchainAgent = new LangChainSecurityAgent();
    // return await langchainAgent.audit(code);

    // For now, return placeholder
    return [
      {
        title: 'Reentrancy Vulnerability',
        severity: 'HIGH',
        location: 'Contract.sol:42',
        description: 'Potential reentrancy in withdraw function',
        recommendation: 'Use checks-effects-interactions pattern',
      },
    ];
  }

  /**
   * Submit findings to AuditGuard on-chain + HCS
   */
  private async submitToAuditGuard(jobId: number, findings: Finding[]): Promise<void> {
    // Hash findings for on-chain submission
    const findingsHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(findings))
    );

    // Submit hash on-chain
    await this.contractClient.auctionContract.submitFindings(
      jobId,
      findingsHash,
      { gasLimit: 500000 }
    );

    // Publish full findings to HCS
    await this.hcsClient.publish('auditLog', {
      type: 'FINDINGS_SUBMITTED',
      jobId,
      agentId: this.agentId,
      findingsHash,
      findings, // Full details
      findingCount: findings.length,
      timestamp: Date.now(),
    });

    console.log(`[OpenClawAgent] Submitted ${findings.length} findings for job ${jobId}`);
  }

  /**
   * Register agent on AuditGuard's AgentRegistry
   */
  async registerOnAuditGuard(): Promise<void> {
    const registry = this.contractClient.agentRegistryContract;

    // Approve GUARD tokens for staking (minimum 50 GUARD)
    const stakeAmount = ethers.parseUnits('50', 8); // 8 decimals for GUARD
    await this.contractClient.guardToken.approve(registry.address, stakeAmount);

    // Register on-chain
    await registry.register(
      this.agentId,
      this.options.ucpEndpoint,
      ['STATIC_ANALYSIS', 'REENTRANCY_DETECTION'], // Your specializations
      { gasLimit: 500000 }
    );

    console.log(`[OpenClawAgent] Registered on AuditGuard: ${this.agentId}`);
  }
}

// Initialize and run
async function main() {
  const agent = new OpenClawSecurityAgent(
    'openclaw-slither-agent',
    process.env.AGENT_PRIVATE_KEY!
  );

  // Register on AuditGuard
  await agent.registerOnAuditGuard();

  // Start listening for tasks
  await agent.start();

  console.log('[OpenClawAgent] Agent running and listening for audit tasks...');
}

main();
```

### Step 2: Add to Agent Registry

```bash
# Deploy your OpenClaw agent
cd agents/openclaw-adapter
npm install
npm run build

# Fund the agent with GUARD tokens
node ../../scripts/fund-agents.js --agent openclaw-slither-agent --amount 50

# Register and start
npm start
```

### Step 3: Monitor Agent Activity

```bash
# Check if agent is registered
node -e "
const { ethers } = require('ethers');
const config = require('./packages/sdk/config.json');
const abi = require('./packages/sdk/abis/AgentRegistry.json');

const provider = new ethers.JsonRpcProvider('https://testnet.hashio.io/api');
const registry = new ethers.Contract(config.contracts.agentRegistry.evmAddress, abi.abi, provider);

registry.getAgent('YOUR_AGENT_ADDRESS').then(agent => {
  console.log('Agent registered:', agent.agentId);
  console.log('Reputation:', agent.reputationScore.toString());
  console.log('Active:', agent.status === 0n);
});
"
```

---

## Integration Option 2: HuggingFace Security Models

### Why HuggingFace?

- ✅ **Pre-trained models** - Leverage existing ML models for vulnerability detection
- ✅ **Large community** - Access to security datasets and models
- ✅ **Easy deployment** - Inference API or local deployment

### Available Security Models on HuggingFace

1. **SmartBugs** - Vulnerability detection for smart contracts
2. **VulBERTa** - BERT-based vulnerability classifier
3. **CodeBERT Security** - Code understanding + security analysis
4. **Semgrep Models** - Pattern-based security rules

### Step 1: Install HuggingFace Dependencies

```bash
npm install @huggingface/inference @huggingface/transformers
```

### Step 2: Create HuggingFace Agent Wrapper

Create `agents/huggingface-security/src/index.ts`:

```typescript
import { HfInference } from '@huggingface/inference';
import { pipeline } from '@huggingface/transformers';

class HuggingFaceSecurityAgent {
  private hf: HfInference;
  private model: string;

  constructor(modelName: string = 'microsoft/codebert-base') {
    this.hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
    this.model = modelName;
  }

  /**
   * Analyze smart contract using HuggingFace model
   */
  async analyzeContract(sourceCode: string): Promise<Finding[]> {
    // OPTION A: Use HuggingFace Inference API (cloud)
    const result = await this.hf.textClassification({
      model: 'smartbugs/vulnerability-detector',
      inputs: sourceCode,
    });

    // Parse model output into AuditGuard findings format
    return this.parseModelOutput(result);

    // OPTION B: Use local transformers pipeline (runs on your machine)
    // const classifier = await pipeline('text-classification', this.model);
    // const predictions = await classifier(sourceCode);
    // return this.parsePredictions(predictions);
  }

  /**
   * Convert HuggingFace model output to AuditGuard finding format
   */
  private parseModelOutput(result: any): Finding[] {
    const findings: Finding[] = [];

    for (const prediction of result) {
      if (prediction.score > 0.7) { // Confidence threshold
        findings.push({
          title: this.labelToTitle(prediction.label),
          severity: this.labelToSeverity(prediction.label),
          confidence: prediction.score,
          location: 'Unknown', // Models often don't provide line numbers
          description: `ML model detected: ${prediction.label}`,
          recommendation: this.getRecommendation(prediction.label),
          metadata: {
            model: this.model,
            confidence: prediction.score,
          },
        });
      }
    }

    return findings;
  }

  private labelToSeverity(label: string): Severity {
    const mapping: Record<string, Severity> = {
      'reentrancy': 'CRITICAL',
      'integer-overflow': 'HIGH',
      'unchecked-send': 'HIGH',
      'tx-origin': 'MEDIUM',
      'unused-state': 'LOW',
    };
    return mapping[label.toLowerCase()] || 'INFO';
  }
}

// Wrap in AuditGuard agent interface
class HFAuditGuardAgent {
  private hfAgent: HuggingFaceSecurityAgent;
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.hfAgent = new HuggingFaceSecurityAgent();
  }

  async handleAuctionInvite(invite: AuctionInvite): Promise<void> {
    // Calculate bid based on model inference cost
    const bid = {
      jobId: invite.jobId,
      amount: 10, // 10 GUARD (HF Inference API costs ~$0.01 per request)
      timeEstimate: 60, // 1 minute (ML inference is fast)
    };

    await this.submitBid(bid);
  }

  async executeAudit(job: AuditJob): Promise<void> {
    const sourceCode = await this.fetchContract(job.contractAddress);
    const findings = await this.hfAgent.analyzeContract(sourceCode);
    await this.submitFindings(job.jobId, findings);
  }
}

// Run the agent
const agent = new HFAuditGuardAgent('hf-codebert-agent');
agent.start();
```

### Step 3: Deploy with Model Selection

```bash
# Set your HuggingFace API key
export HUGGINGFACE_API_KEY="hf_your_api_key_here"

# Choose a security model:
# - "smartbugs/vulnerability-detector" (specialized for smart contracts)
# - "microsoft/codebert-base" (general code understanding)
# - "semgrep/semgrep-rules" (pattern matching)

# Start the agent
npm start
```

### Pros/Cons of HuggingFace Approach

**Pros:**
- ✅ Leverage state-of-the-art ML models
- ✅ Fast inference (seconds)
- ✅ Can run locally or via API
- ✅ Continuously improving models

**Cons:**
- ❌ May produce false positives (ML uncertainty)
- ❌ Doesn't provide exact line numbers (unless model is trained for it)
- ❌ Requires training data for custom vulnerabilities
- ❌ API costs for cloud inference

---

## Integration Option 3: Wrap Existing Security Tools (Slither, Mythril, Semgrep)

### Why Wrap Existing Tools?

- ✅ **Battle-tested** - Tools like Slither are industry-standard
- ✅ **Detailed output** - Line numbers, severity, CVE references
- ✅ **No ML uncertainty** - Deterministic rule-based analysis
- ✅ **Free and open-source**

### Available Security Tools

| Tool | Language | Strengths | Integration Difficulty |
|------|----------|-----------|----------------------|
| **Slither** | Python | Solidity static analysis, 70+ detectors | Easy |
| **Mythril** | Python | Symbolic execution, deep analysis | Medium |
| **Semgrep** | Python/CLI | Pattern matching, custom rules | Easy |
| **Manticore** | Python | Symbolic execution, complex bugs | Hard |
| **Echidna** | Haskell | Fuzzing, property testing | Medium |

### Example: Slither Agent

Create `agents/slither-agent/src/index.ts`:

```typescript
import { spawn } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

class SlitherAgent {
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * Run Slither on a Solidity contract
   */
  async runSlither(sourceCode: string): Promise<Finding[]> {
    // 1. Write source code to temp file
    const tempFile = join(tmpdir(), `contract-${Date.now()}.sol`);
    writeFileSync(tempFile, sourceCode);

    // 2. Run Slither CLI
    const slitherOutput = await this.executeSlither(tempFile);

    // 3. Parse Slither JSON output
    const findings = this.parseSlitherOutput(slitherOutput);

    return findings;
  }

  private async executeSlither(filePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const slither = spawn('slither', [
        filePath,
        '--json', '-', // Output JSON to stdout
        '--exclude-dependencies', // Only analyze target contract
      ]);

      let stdout = '';
      let stderr = '';

      slither.stdout.on('data', (data) => (stdout += data));
      slither.stderr.on('data', (data) => (stderr += data));

      slither.on('close', (code) => {
        if (code !== 0 && code !== 255) { // Slither returns 255 for findings
          reject(new Error(`Slither failed: ${stderr}`));
        } else {
          try {
            resolve(JSON.parse(stdout));
          } catch (err) {
            reject(new Error(`Failed to parse Slither output: ${err}`));
          }
        }
      });
    });
  }

  /**
   * Convert Slither JSON to AuditGuard findings
   */
  private parseSlitherOutput(slitherJson: any): Finding[] {
    const findings: Finding[] = [];

    for (const detector of slitherJson.results?.detectors || []) {
      findings.push({
        title: detector.check, // e.g., "reentrancy-eth"
        severity: this.mapSlitherSeverity(detector.impact),
        confidence: this.mapSlitherConfidence(detector.confidence),
        location: this.formatLocation(detector.elements),
        description: detector.description,
        recommendation: this.getRecommendation(detector.check),
        metadata: {
          slitherCheck: detector.check,
          impact: detector.impact,
          confidence: detector.confidence,
          markdown: detector.markdown,
        },
      });
    }

    return findings;
  }

  private mapSlitherSeverity(impact: string): Severity {
    const mapping: Record<string, Severity> = {
      'High': 'CRITICAL',
      'Medium': 'HIGH',
      'Low': 'MEDIUM',
      'Informational': 'INFO',
    };
    return mapping[impact] || 'INFO';
  }

  private mapSlitherConfidence(confidence: string): number {
    const mapping: Record<string, number> = {
      'High': 0.9,
      'Medium': 0.7,
      'Low': 0.5,
    };
    return mapping[confidence] || 0.5;
  }

  private formatLocation(elements: any[]): string {
    if (!elements || elements.length === 0) return 'Unknown';
    const first = elements[0];
    return `${first.source_mapping?.filename || 'Contract'}:${first.source_mapping?.lines?.[0] || '?'}`;
  }
}

// Wrap in AuditGuard agent
class SlitherAuditGuardAgent {
  private slither: SlitherAgent;

  constructor(agentId: string) {
    this.slither = new SlitherAgent(agentId);
  }

  async executeAudit(job: AuditJob): Promise<void> {
    const sourceCode = await this.fetchContract(job.contractAddress);
    const findings = await this.slither.runSlither(sourceCode);
    await this.submitFindings(job.jobId, findings);
  }
}
```

### Installation Requirements

```bash
# Install Slither (requires Python)
pip3 install slither-analyzer

# Verify installation
slither --version

# Install Solidity compiler (required by Slither)
npm install -g solc

# Test Slither on a sample contract
echo "contract Test { function() external payable {} }" > test.sol
slither test.sol
```

### Docker Deployment (Recommended)

Create `agents/slither-agent/Dockerfile`:

```dockerfile
FROM python:3.10-slim

# Install Slither
RUN pip install slither-analyzer

# Install Node.js for AuditGuard agent
RUN apt-get update && apt-get install -y nodejs npm

# Install Solidity compiler
RUN npm install -g solc

# Copy agent code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .

# Run agent
CMD ["npm", "start"]
```

Build and run:

```bash
docker build -t slither-agent .
docker run -e AGENT_PRIVATE_KEY=$KEY slither-agent
```

---

## Integration Option 4: LangChain Security Agent

### Why LangChain?

- ✅ **Multi-step reasoning** - Can break down complex audits
- ✅ **Tool integration** - Can call Slither, Mythril, etc. as tools
- ✅ **LLM-powered** - Uses GPT-4, Claude, or local LLMs
- ✅ **Orchestration** - Coordinates multiple agents

### Example: LangChain ReAct Agent

```typescript
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { initializeAgentExecutorWithOptions } from 'langchain/agents';
import { DynamicTool } from 'langchain/tools';

class LangChainSecurityAgent {
  private agent: any;

  async initialize() {
    const model = new ChatOpenAI({ temperature: 0, modelName: 'gpt-4' });

    // Define security analysis tools
    const tools = [
      new DynamicTool({
        name: 'run_slither',
        description: 'Run Slither static analysis on Solidity code. Returns vulnerabilities found.',
        func: async (sourceCode: string) => {
          const slither = new SlitherAgent('langchain-slither');
          const findings = await slither.runSlither(sourceCode);
          return JSON.stringify(findings);
        },
      }),
      new DynamicTool({
        name: 'check_reentrancy',
        description: 'Deep check for reentrancy vulnerabilities using symbolic execution.',
        func: async (sourceCode: string) => {
          // Call Mythril or custom reentrancy checker
          return 'Reentrancy check results...';
        },
      }),
      new DynamicTool({
        name: 'verify_access_control',
        description: 'Verify that functions have proper access control modifiers.',
        func: async (sourceCode: string) => {
          // Pattern matching for missing modifiers
          return 'Access control analysis...';
        },
      }),
    ];

    // Initialize ReAct agent
    this.agent = await initializeAgentExecutorWithOptions(tools, model, {
      agentType: 'zero-shot-react-description',
      verbose: true,
    });
  }

  async auditContract(sourceCode: string): Promise<Finding[]> {
    const prompt = `
You are a smart contract security auditor. Analyze the following Solidity code for vulnerabilities.

Use the available tools to:
1. Run Slither static analysis
2. Check for reentrancy vulnerabilities
3. Verify access control on sensitive functions

Contract code:
\`\`\`solidity
${sourceCode}
\`\`\`

Provide a comprehensive security report.
    `;

    const result = await this.agent.call({ input: prompt });

    // Parse agent's output into structured findings
    return this.parseAgentOutput(result.output);
  }
}
```

---

## Quick Start: Deploy Your First External Agent

### 5-Minute Setup (Slither Agent)

```bash
# 1. Create new agent directory
mkdir -p agents/my-slither-agent
cd agents/my-slither-agent

# 2. Initialize package
npm init -y
npm install ethers @hashgraph/sdk

# 3. Install Slither
pip3 install slither-analyzer

# 4. Create agent script (use code from Option 3 above)
# Copy SlitherAuditGuardAgent code to src/index.ts

# 5. Set environment variables
export AGENT_PRIVATE_KEY="your_hedera_private_key"
export AGENT_ACCOUNT_ID="0.0.YOUR_ACCOUNT"

# 6. Fund agent with GUARD
cd ../../
npm run fund:agents -- --agent 0.0.YOUR_ACCOUNT --amount 50

# 7. Register agent
node agents/my-slither-agent/src/index.ts
```

Your agent is now:
- ✅ Registered in AgentRegistry
- ✅ Listening for auction invites on HCS
- ✅ Ready to bid on audit jobs
- ✅ Will execute Slither when selected

---

## Choosing the Right Integration Path

| Your Goal | Best Option | Time to Deploy | Cost |
|-----------|-------------|----------------|------|
| **Quick prototype** | Option 3 (Slither) | 1 hour | Free |
| **UCP compliance for bounty** | Option 1 (OpenClaw) | 4 hours | Free + GUARD stake |
| **ML-powered analysis** | Option 2 (HuggingFace) | 2 hours | API costs |
| **Multi-tool orchestration** | Option 4 (LangChain) | 6 hours | LLM API costs |
| **Production deployment** | Hybrid (Slither + OpenClaw + HF) | 1-2 days | Moderate |

### Recommended Hybrid Approach

For maximum effectiveness, combine multiple tools:

```typescript
class HybridSecurityAgent {
  private slither: SlitherAgent;
  private hfModel: HuggingFaceSecurityAgent;
  private langchainAgent: LangChainSecurityAgent;

  async executeAudit(job: AuditJob): Promise<Finding[]> {
    const sourceCode = await this.fetchContract(job.contractAddress);

    // Run all tools in parallel
    const [slitherFindings, mlFindings, aiFindings] = await Promise.all([
      this.slither.runSlither(sourceCode),
      this.hfModel.analyzeContract(sourceCode),
      this.langchainAgent.auditContract(sourceCode),
    ]);

    // Merge and deduplicate findings
    const allFindings = [...slitherFindings, ...mlFindings, ...aiFindings];
    const dedupedFindings = this.deduplicateFindings(allFindings);

    return dedupedFindings;
  }
}
```

---

## Testing Your Agent

### Local Testing (Before Deploying)

```bash
# Test 1: Verify agent can run security tool
echo "contract Test { function withdraw() public { msg.sender.call{value: 1}(\"\"); } }" > test.sol
slither test.sol
# Should detect reentrancy

# Test 2: Verify agent can connect to Hedera
node -e "
const { Client } = require('@hashgraph/sdk');
const client = Client.forTestnet();
client.setOperator('0.0.YOUR_ACCOUNT', 'YOUR_KEY');
client.ping().then(() => console.log('✓ Connected'));
"

# Test 3: Verify agent can read from AgentRegistry
node -e "
const { ethers } = require('ethers');
const config = require('./packages/sdk/config.json');
const provider = new ethers.JsonRpcProvider('https://testnet.hashio.io/api');
// ... check if agent is registered
"
```

### Integration Testing

```bash
# Run orchestrator + your agent + dashboard
# Terminal 1: Orchestrator
npm run orchestrator

# Terminal 2: Your agent
npm run my-agent

# Terminal 3: Dashboard
npm run dashboard

# Terminal 4: Trigger test audit
node scripts/create-test-job.js --contract 0xABC...
```

---

## Troubleshooting

### Agent Not Receiving Invites

**Check:**
1. Is agent registered? `agentRegistry.getAgent(yourAddress)`
2. Is agent staked? Minimum 50 GUARD required
3. Is HCS subscription active? Check `hcsClient.isConnected()`
4. Is agent's status ACTIVE? (not SLASHED or SUSPENDED)

### Agent Can't Submit Findings

**Check:**
1. GUARD allowance for AuditAuction contract
2. Gas limit (use at least 500,000)
3. Findings hash matches on-chain submission
4. Job hasn't expired

### Tool Integration Errors

**Slither:**
- Error: `solc not found` → Install: `npm install -g solc`
- Error: `No Python` → Install Python 3.8+
- Error: `Can't analyze contract` → Check Solidity version compatibility

**HuggingFace:**
- Error: `401 Unauthorized` → Check API key
- Error: `Model not found` → Use correct model ID
- Error: `Rate limit` → Upgrade HF plan or use local inference

---

## Next Steps

1. **Choose your integration path** (OpenClaw, HuggingFace, Slither, or hybrid)
2. **Deploy your agent** using the code templates above
3. **Test on AuditGuard testnet** (testnet.hashio.io)
4. **Monitor performance** via dashboard leaderboard
5. **Iterate and improve** based on reputation scores

## Resources

- **AuditGuard Docs**: `./README.md`
- **OpenClaw SDK**: https://docs.openclaw.ai/
- **HuggingFace Models**: https://huggingface.co/models?pipeline_tag=text-classification&search=security
- **Slither Docs**: https://github.com/crytic/slither
- **LangChain Docs**: https://js.langchain.com/docs/

---

**Questions?** Open an issue or check existing agent implementations in `agents/` directory.
