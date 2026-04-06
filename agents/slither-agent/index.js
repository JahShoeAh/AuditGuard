const { Client, TopicMessageSubmitTransaction, PrivateKey, AccountId, TokenId, TransferTransaction, AccountBalanceQuery } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class SlitherAgent {
  constructor(config) {
    this.agentName = config.agentName || 'slither-static-analyzer';
    this.accountId = AccountId.fromString(config.accountId);
    this.privateKey = PrivateKey.fromString(config.privateKey);
    this.guardTokenId = TokenId.fromString(config.guardTokenId);

    // Topics
    this.discoveryTopicId = config.discoveryTopicId;
    this.bidSubmissionTopicId = config.bidSubmissionTopicId;
    this.resultSubmissionTopicId = config.resultSubmissionTopicId;

    // Contracts
    this.agentRegistryAddress = config.agentRegistryAddress;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    // Hedera client
    this.client = Client.forTestnet();
    this.client.setOperator(this.accountId, this.privateKey);

    this.activeTasks = new Map();

    console.log(`🔍 Slither Agent initialized: ${this.agentName}`);
    console.log(`   Account: ${this.accountId.toString()}`);
  }

  async start() {
    console.log(`\n🚀 Starting Slither Agent...`);

    // Check if slither is installed
    const slitherInstalled = await this.checkSlitherInstalled();
    if (!slitherInstalled) {
      console.error(`❌ Slither not installed. Run: pip3 install slither-analyzer`);
      process.exit(1);
    }

    console.log(`✅ Slither analyzer ready`);

    // Subscribe to discovery topic
    await this.subscribeToDiscovery();
  }

  async checkSlitherInstalled() {
    return new Promise((resolve) => {
      const process = spawn('slither', ['--version']);
      process.on('close', (code) => {
        resolve(code === 0);
      });
      process.on('error', () => {
        resolve(false);
      });
    });
  }

  async subscribeToDiscovery() {
    console.log(`\n👂 Listening to discovery topic: ${this.discoveryTopicId}`);

    // Mock implementation - in production, use Mirror Node REST API or HCS subscriptions
    // For now, we'll poll every 30 seconds
    setInterval(async () => {
      await this.pollForTasks();
    }, 30000);

    console.log(`📡 Polling for audit tasks every 30 seconds...`);
  }

  async pollForTasks() {
    // In production: query mirror node for new messages on discoveryTopicId
    // For demo: just log that we're listening
    const balance = await this.getGuardBalance();
    console.log(`💰 Current balance: ${balance.toFixed(2)} GUARD`);
  }

  async getGuardBalance() {
    try {
      const balance = await new AccountBalanceQuery()
        .setAccountId(this.accountId)
        .execute(this.client);

      const tokenBalance = balance.tokens.get(this.guardTokenId);
      return tokenBalance ? tokenBalance.toNumber() / Math.pow(10, 8) : 0;
    } catch (err) {
      console.error(`Error checking balance: ${err.message}`);
      return 0;
    }
  }

  async processAuditTask(task) {
    const { jobId, contractAddress, sourceCode, metadata } = task;

    console.log(`\n📋 New audit task received:`);
    console.log(`   Job ID: ${jobId}`);
    console.log(`   Contract: ${contractAddress}`);

    // 1. Evaluate task and submit bid
    const bid = await this.evaluateTask(task);
    if (!bid) {
      console.log(`⏭️  Skipping task (not suitable for static analysis)`);
      return;
    }

    await this.submitBid(jobId, bid);

    // 2. Wait for bid acceptance (mock - in production, listen to BidAccepted events)
    console.log(`⏳ Waiting for bid acceptance...`);

    // 3. Execute analysis
    const results = await this.runSlitherAnalysis(sourceCode, metadata);

    // 4. Submit results
    await this.submitResults(jobId, results);
  }

  async evaluateTask(task) {
    const { sourceCode, metadata } = task;

    // Slither works best with Solidity contracts
    const isSolidity = metadata?.language === 'solidity' ||
                       sourceCode.includes('pragma solidity');

    if (!isSolidity) {
      return null; // Skip non-Solidity contracts
    }

    // Estimate complexity based on LOC
    const lines = sourceCode.split('\n').length;
    const complexity = lines < 100 ? 'low' : lines < 500 ? 'medium' : 'high';

    // Price based on complexity
    const prices = { low: 10, medium: 25, high: 50 };
    const basePrice = prices[complexity];

    return {
      agentId: this.accountId.toString(),
      amount: basePrice,
      estimatedTime: complexity === 'low' ? 300 : complexity === 'medium' ? 600 : 1200, // seconds
      metadata: {
        tool: 'slither',
        version: '0.10.0',
        complexity
      }
    };
  }

  async submitBid(jobId, bid) {
    console.log(`\n💰 Submitting bid: ${bid.amount} GUARD`);

    const bidMessage = {
      type: 'BID_SUBMISSION',
      jobId,
      agentId: this.accountId.toString(),
      amount: bid.amount,
      estimatedTime: bid.estimatedTime,
      metadata: bid.metadata,
      timestamp: Date.now()
    };

    try {
      const submitTx = await new TopicMessageSubmitTransaction({
        topicId: this.bidSubmissionTopicId,
        message: JSON.stringify(bidMessage)
      }).execute(this.client);

      const receipt = await submitTx.getReceipt(this.client);
      console.log(`✅ Bid submitted (sequence: ${receipt.topicSequenceNumber})`);
    } catch (err) {
      console.error(`❌ Bid submission failed: ${err.message}`);
    }
  }

  async runSlitherAnalysis(sourceCode, metadata) {
    console.log(`\n🔍 Running Slither analysis...`);

    // Create temp directory for contract
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slither-'));
    const contractPath = path.join(tmpDir, 'Contract.sol');

    try {
      // Write source code to temp file
      await fs.writeFile(contractPath, sourceCode);

      // Run Slither
      const findings = await this.runSlither(contractPath);

      // Clean up
      await fs.rm(tmpDir, { recursive: true });

      console.log(`✅ Analysis complete: ${findings.length} findings`);

      return {
        status: 'completed',
        findings,
        summary: this.generateSummary(findings),
        metadata: {
          tool: 'slither',
          timestamp: Date.now()
        }
      };
    } catch (err) {
      // Clean up on error
      await fs.rm(tmpDir, { recursive: true, force: true });

      console.error(`❌ Analysis failed: ${err.message}`);

      return {
        status: 'failed',
        error: err.message,
        findings: [],
        metadata: {
          tool: 'slither',
          timestamp: Date.now()
        }
      };
    }
  }

  async runSlither(contractPath) {
    return new Promise((resolve, reject) => {
      const findings = [];
      let stdout = '';
      let stderr = '';

      const slitherProcess = spawn('slither', [
        contractPath,
        '--json', '-',
        '--solc-disable-warnings'
      ]);

      slitherProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      slitherProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        // Ignore urllib3 SSL warnings - they're harmless
        if (!stderrText.includes('NotOpenSSLWarning') && !stderrText.includes('urllib3')) {
          stderr += stderrText;
        }
      });

      slitherProcess.on('close', (code) => {
        // Parse JSON from stdout
        try {
          // Slither outputs JSON even on non-zero exit codes
          const output = JSON.parse(stdout);

          if (output.results && output.results.detectors) {
            output.results.detectors.forEach(detector => {
              findings.push({
                severity: this.mapSeverity(detector.impact),
                title: detector.check,
                description: detector.description,
                location: detector.elements?.[0]?.source_mapping?.filename_short || 'unknown',
                line: detector.elements?.[0]?.source_mapping?.lines?.[0] || 0,
                recommendation: this.getRecommendation(detector.check),
                confidence: detector.confidence || 'medium'
              });
            });
          }
          resolve(findings);
        } catch (err) {
          // If JSON parsing fails and we have stderr, report the error
          if (stderr) {
            reject(new Error(`Slither failed: ${stderr}`));
          } else {
            reject(new Error(`Failed to parse Slither output: ${err.message}`));
          }
        }
      });

      slitherProcess.on('error', (err) => {
        reject(new Error(`Failed to run Slither: ${err.message}`));
      });
    });
  }

  mapSeverity(impact) {
    const severityMap = {
      'High': 'critical',
      'Medium': 'high',
      'Low': 'medium',
      'Informational': 'low'
    };
    return severityMap[impact] || 'medium';
  }

  getRecommendation(checkName) {
    const recommendations = {
      'reentrancy-eth': 'Use checks-effects-interactions pattern or ReentrancyGuard',
      'unchecked-transfer': 'Check return value of transfer/transferFrom',
      'uninitialized-state': 'Initialize state variables in constructor',
      'arbitrary-send-eth': 'Validate recipient address before sending ETH',
      'locked-ether': 'Add withdrawal function or remove payable',
    };
    return recommendations[checkName] || 'Review Slither documentation for details';
  }

  generateSummary(findings) {
    const severityCounts = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {});

    const total = findings.length;
    const critical = severityCounts.critical || 0;
    const high = severityCounts.high || 0;

    let riskLevel = 'low';
    if (critical > 0) riskLevel = 'critical';
    else if (high > 2) riskLevel = 'high';
    else if (high > 0) riskLevel = 'medium';

    return {
      totalFindings: total,
      severityCounts,
      riskLevel,
      recommendation: critical > 0
        ? 'Do not deploy - critical vulnerabilities found'
        : high > 0
        ? 'Review and fix high-severity issues before deployment'
        : 'Contract passed static analysis checks'
    };
  }

  async submitResults(jobId, results) {
    console.log(`\n📤 Submitting results for job ${jobId}...`);

    const resultMessage = {
      type: 'RESULT_SUBMISSION',
      jobId,
      agentId: this.accountId.toString(),
      results,
      timestamp: Date.now()
    };

    try {
      const submitTx = await new TopicMessageSubmitTransaction({
        topicId: this.resultSubmissionTopicId,
        message: JSON.stringify(resultMessage)
      }).execute(this.client);

      const receipt = await submitTx.getReceipt(this.client);
      console.log(`✅ Results submitted (sequence: ${receipt.topicSequenceNumber})`);
    } catch (err) {
      console.error(`❌ Result submission failed: ${err.message}`);
    }
  }

  async shutdown() {
    console.log(`\n👋 Shutting down Slither Agent...`);
    this.client.close();
  }
}

// Main execution
if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

  const configPath = path.join(__dirname, '..', '..', 'packages', 'sdk', 'config.json');
  const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));

  const agent = new SlitherAgent({
    agentName: 'slither-static-analyzer',
    accountId: process.env.SLITHER_AGENT_ACCOUNT_ID || '0.0.7951945',
    privateKey: process.env.SLITHER_AGENT_PRIVATE_KEY,
    guardTokenId: config.guardTokenId,
    discoveryTopicId: process.env.DISCOVERY_TOPIC_ID,
    bidSubmissionTopicId: process.env.BID_SUBMISSION_TOPIC_ID,
    resultSubmissionTopicId: process.env.RESULT_SUBMISSION_TOPIC_ID,
    agentRegistryAddress: config.contracts.AgentRegistry,
    rpcUrl: process.env.HEDERA_RPC_URL || 'https://testnet.hashio.io/api'
  });

  agent.start().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await agent.shutdown();
    process.exit(0);
  });
}

module.exports = SlitherAgent;
