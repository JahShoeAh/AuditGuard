const SlitherAgent = require('./index');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Sample vulnerable contract for testing
const VULNERABLE_CONTRACT = `
pragma solidity ^0.8.0;

contract VulnerableBank {
    mapping(address => uint256) public balances;

    // VULNERABILITY: Reentrancy attack possible
    function withdraw(uint256 amount) public {
        require(balances[msg.sender] >= amount, "Insufficient balance");

        // Sends ETH before updating state (BAD!)
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        balances[msg.sender] -= amount;
    }

    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }

    // VULNERABILITY: Locked ether (no way to withdraw)
    receive() external payable {}
}
`;

async function runOfflineTests() {
  // Test 1: Check Slither installation
  console.log('📋 Test 1: Checking Slither installation...');
  const installed = await checkSlitherInstalled();
  if (!installed) {
    console.error('❌ Slither not installed. Install with:');
    console.error('   pip3 install slither-analyzer\n');
    process.exit(1);
  }
  console.log('✅ Slither is installed\n');

  // Test 2: Run Slither analysis
  console.log('📋 Test 2: Running Slither analysis on vulnerable contract...');
  const findings = await runSlitherDirectly(VULNERABLE_CONTRACT);

  console.log(`\n📊 Analysis Results:`);
  console.log(`   Findings: ${findings.length}`);

  if (findings.length > 0) {
    console.log(`\n🔍 Detected Vulnerabilities:`);
    findings.forEach((finding, i) => {
      console.log(`\n   ${i + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`);
      console.log(`      ${finding.description.substring(0, 100)}...`);
      console.log(`      Confidence: ${finding.confidence}`);
      console.log(`      Fix: ${finding.recommendation}`);
    });
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║              ✅ Offline Tests Passed                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('💡 To test Hedera integration, add SLITHER_AGENT_PRIVATE_KEY to .env\n');
}

function checkSlitherInstalled() {
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

async function runSlitherDirectly(sourceCode) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slither-test-'));
  const contractPath = path.join(tmpDir, 'Contract.sol');

  try {
    await fs.writeFile(contractPath, sourceCode);

    const findings = await new Promise((resolve, reject) => {
      const results = [];
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
              results.push({
                severity: mapSeverity(detector.impact),
                title: detector.check,
                description: detector.description,
                confidence: detector.confidence || 'medium',
                recommendation: getRecommendation(detector.check)
              });
            });
          }
          resolve(results);
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

    await fs.rm(tmpDir, { recursive: true });
    return findings;
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function mapSeverity(impact) {
  const severityMap = {
    'High': 'critical',
    'Medium': 'high',
    'Low': 'medium',
    'Informational': 'low'
  };
  return severityMap[impact] || 'medium';
}

function getRecommendation(checkName) {
  const recommendations = {
    'reentrancy-eth': 'Use checks-effects-interactions pattern or ReentrancyGuard',
    'unchecked-transfer': 'Check return value of transfer/transferFrom',
    'uninitialized-state': 'Initialize state variables in constructor',
    'arbitrary-send-eth': 'Validate recipient address before sending ETH',
    'locked-ether': 'Add withdrawal function or remove payable',
  };
  return recommendations[checkName] || 'Review Slither documentation for details';
}

async function testSlitherAgent() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║              Slither Agent - Local Test                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Check for required environment variables
  if (!process.env.SLITHER_AGENT_PRIVATE_KEY) {
    console.log('⚠️  SLITHER_AGENT_PRIVATE_KEY not found in .env\n');
    console.log('To run full tests with Hedera integration, add to your .env:');
    console.log('  SLITHER_AGENT_ACCOUNT_ID=0.0.7951945');
    console.log('  SLITHER_AGENT_PRIVATE_KEY=<your_private_key>\n');
    console.log('Running offline tests only...\n');

    // Run offline tests only
    await runOfflineTests();
    return;
  }

  const configPath = path.join(__dirname, '..', '..', 'packages', 'sdk', 'config.json');
  const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));

  const agent = new SlitherAgent({
    agentName: 'slither-test-agent',
    accountId: process.env.SLITHER_AGENT_ACCOUNT_ID || '0.0.7951945',
    privateKey: process.env.SLITHER_AGENT_PRIVATE_KEY,
    guardTokenId: config.guardTokenId,
    discoveryTopicId: '0.0.123456',
    bidSubmissionTopicId: '0.0.123457',
    resultSubmissionTopicId: '0.0.123458',
    agentRegistryAddress: config.contracts.AgentRegistry,
    rpcUrl: process.env.HEDERA_RPC_URL || 'https://testnet.hashio.io/api'
  });

  // Test 1: Check Slither installation
  console.log('📋 Test 1: Checking Slither installation...');
  const installed = await agent.checkSlitherInstalled();
  if (!installed) {
    console.error('❌ Slither not installed. Install with:');
    console.error('   pip3 install slither-analyzer\n');
    process.exit(1);
  }
  console.log('✅ Slither is installed\n');

  // Test 2: Check GUARD balance
  console.log('📋 Test 2: Checking GUARD balance...');
  const balance = await agent.getGuardBalance();
  console.log(`✅ Balance: ${balance.toFixed(2)} GUARD\n`);

  // Test 3: Evaluate task
  console.log('📋 Test 3: Evaluating audit task...');
  const mockTask = {
    jobId: 'test-job-001',
    contractAddress: '0x1234567890123456789012345678901234567890',
    sourceCode: VULNERABLE_CONTRACT,
    metadata: {
      language: 'solidity',
      compiler: '0.8.0'
    }
  };

  const bid = await agent.evaluateTask(mockTask);
  if (bid) {
    console.log(`✅ Bid generated: ${bid.amount} GUARD`);
    console.log(`   Complexity: ${bid.metadata.complexity}`);
    console.log(`   Est. time: ${bid.estimatedTime}s\n`);
  } else {
    console.log('❌ Task evaluation failed\n');
    process.exit(1);
  }

  // Test 4: Run analysis
  console.log('📋 Test 4: Running Slither analysis on vulnerable contract...');
  const results = await agent.runSlitherAnalysis(VULNERABLE_CONTRACT, mockTask.metadata);

  console.log(`\n📊 Analysis Results:`);
  console.log(`   Status: ${results.status}`);
  console.log(`   Findings: ${results.findings.length}`);

  if (results.findings.length > 0) {
    console.log(`\n🔍 Detected Vulnerabilities:`);
    results.findings.forEach((finding, i) => {
      console.log(`\n   ${i + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`);
      console.log(`      ${finding.description.substring(0, 100)}...`);
      console.log(`      Confidence: ${finding.confidence}`);
      console.log(`      Fix: ${finding.recommendation}`);
    });
  }

  console.log(`\n📈 Summary:`);
  console.log(`   Total findings: ${results.summary.totalFindings}`);
  console.log(`   Risk level: ${results.summary.riskLevel.toUpperCase()}`);
  console.log(`   Recommendation: ${results.summary.recommendation}`);

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                    ✅ All Tests Passed                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  await agent.shutdown();
}

testSlitherAgent().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
