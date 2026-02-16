/**
 * AuditGuard Day 3 Demo: Reputation Engine & Dynamic Health
 *
 * This script demonstrates the Day 3 features for Person 3:
 *   - Advanced Reputation Scoring
 *   - Historical Accuracy Tracking
 *   - Vulnerability Cataloging
 *   - Reputation Update Engine (processAuditFindings)
 *   - Slashing & Dynamic Pricing
 *
 * Usage:
 *   node packages/inft/scripts/demo-day3.js
 */

const path = require("path");
require("dotenv").config({ 
  path: path.join(__dirname, "..", "..", "..", ".env"),
  override: true 
});

const { INFTService } = require("../src/inft-service");

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           AuditGuard Day 3 iNFT Intelligence Demo           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝
");

  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    console.error("  [ERROR] Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const inftService = new INFTService({
    operatorId: process.env.HEDERA_ACCOUNT_ID,
    operatorKey: process.env.HEDERA_PRIVATE_KEY,
    keyType: process.env.HEDERA_PRIVATE_KEY_TYPE,
  });

  try {
    // 1. SETUP: AGENT REGISTRATION
    console.log("Step 1: Agent Registration");
    const agentAddr = "0x" + "ae".repeat(20);
    const { serialNumber: agentSerial } = await inftService.mintAgentProfileINFT({
      agentAddress: agentAddr,
      agentId: "SecuritySentinel-9000",
      ucpEndpoint: "openclaw://sentinel-9000",
      specializations: ["reentrancy", "logic_error"],
      tier: "SPECIALIZED",
      stakedAmount: 500,
      initialReputation: 6000,
    });
    console.log(`  Minted Agent Profile iNFT #${agentSerial} for SecuritySentinel-9000
`);

    // 2. SETUP: CONTRACT DISCOVERY
    console.log("Step 2: Contract Discovery");
    const contractAddr = "0x" + "c3".repeat(20);
    const { serialNumber: jobSerial } = await inftService.mintAuditJobINFT({
      contractAddress: contractAddr,
      chain: "hedera",
      contractType: "YieldAggregator",
      jobId: 101,
    });
    const { serialNumber: healthSerial } = await inftService.mintContractHealthINFT({
      contractAddress: contractAddr,
      initialRiskScore: 60,
    });
    console.log(`  Minted Audit Job iNFT #${jobSerial} and Contract Health iNFT #${healthSerial}
`);

    // 3. PROCESS FINDINGS
    console.log("Step 3: Processing Audit Findings (Reputation Engine)");
    
    // Simulate an aggregated report
    const mockReport = {
      jobId: 101,
      securityScore: 82,
      reportHash: "0x" + "r1".repeat(32),
      findings: [
        { severity: "critical", category: "reentrancy", title: "Cross-contract reentrancy in deposit", agentId: "SecuritySentinel-9000" },
        { severity: "medium", category: "logic_error", title: "Incorrect fee calculation", agentId: "SecuritySentinel-9000" },
      ],
      agentReports: [
        {
          agentAddress: agentAddr,
          validFindings: 2,
          falsePositives: 0,
          falseNegatives: 0,
          accuracyScore: 100,
        }
      ]
    };

    await inftService.processAuditFindings(jobSerial, mockReport);
    console.log("  Reputation and Contract Health updated via processAuditFindings
");

    // 4. VERIFY REPUTATION & METRICS
    console.log("Step 4: Verify Agent State");
    const agentData = await inftService.getINFT("agentProfile", agentSerial);
    console.log(`  New Reputation: ${agentData.reputation.current} (+${agentData.reputation.current - 6000} bps)`);
    console.log(`  Accuracy Rate: ${agentData.performance.accuracyRate}%`);
    console.log(`  Successful Findings: ${agentData.performance.successfulFindings}
`);

    // 5. DYNAMIC PRICING
    console.log("Step 5: Dynamic Pricing Update");
    // Since reputation is now > 6000, agent decides to increase premium markup
    await inftService.updateAgentPricing(agentSerial, {
      premiumMarkup: 15,
      baseBidMultiplier: 1.2,
    });
    console.log("  Agent updated pricing strategy based on increased reputation
");

    // 6. CONTRACT HEALTH & VULNERABILITIES
    console.log("Step 6: Verify Contract Health & Vulnerability Catalog");
    const healthData = await inftService.getINFT("contractHealth", healthSerial);
    console.log(`  Security Score: ${healthData.health.securityScore}/100`);
    console.log(`  Vulnerability Count: ${healthData.vulnerabilities.summary.total}`);
    console.log(`  Catalog entry [0]: ${healthData.vulnerabilities.catalog[0].title} (${healthData.vulnerabilities.catalog[0].severity})
`);

    // 7. SLASHING SIMULATION
    console.log("Step 7: Slashing Simulation (Misconduct)");
    await inftService.slashAgent(agentSerial, 50, 1500, "Collusion detected in auction #102");
    
    const slashedAgent = await inftService.getINFT("agentProfile", agentSerial);
    console.log(`  Reputation after slash: ${slashedAgent.reputation.current}`);
    console.log(`  Stake after slash: ${slashedAgent.economics.stakedAmount} GUARD`);
    console.log(`  Agent Status: ${slashedAgent.identity.status}
`);

    console.log("Day 3 Demo Completed Successfully! 🛡️");

  } catch (error) {
    console.error(`
  [FATAL ERROR] ${error.message}`);
    console.error(error.stack);
  } finally {
    inftService.close();
  }
}

main();
