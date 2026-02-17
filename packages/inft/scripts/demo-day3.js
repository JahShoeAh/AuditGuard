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
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

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
    console.log(`  Minted Agent Profile iNFT #${agentSerial} for SecuritySentinel-9000\n`);

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
    console.log(`  Minted Audit Job iNFT #${jobSerial} and Contract Health iNFT #${healthSerial}\n`);

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
    console.log("  Reputation and Contract Health updated via processAuditFindings\n");

    // 4. VERIFY REPUTATION & METRICS
    console.log("Step 4: Verify Agent State");
    // processAuditFindings resolves by address, may have updated a prior-run agent iNFT
    const resolvedAgentSerial = inftService.findSerial("agentProfile", "agentAddress", agentAddr) || agentSerial;
    const agentData = await inftService.getINFT("agentProfile", resolvedAgentSerial);
    console.log(`  New Reputation: ${agentData.reputation.current} (+${agentData.reputation.current - 6000} bps)`);
    console.log(`  Accuracy Rate: ${agentData.performance.accuracyRate}%`);
    console.log(`  Successful Findings: ${agentData.performance.successfulFindings}\n`);

    // 5. DYNAMIC PRICING
    console.log("Step 5: Dynamic Pricing Update");
    // Since reputation is now > 6000, agent decides to increase premium markup
    await inftService.updateAgentPricing(agentSerial, {
      premiumMarkup: 15,
      baseBidMultiplier: 1.2,
    });
    console.log("  Agent updated pricing strategy based on increased reputation\n");

    // 6. CONTRACT HEALTH & VULNERABILITIES
    console.log("Step 6: Verify Contract Health & Vulnerability Catalog");
    // processAuditFindings resolves by contract address, may have updated a different serial
    // if prior runs exist — find the most-updated health iNFT for this contract
    const resolvedHealthSerial = inftService.findSerial("contractHealth", "contract.contractAddress", contractAddr) || healthSerial;
    const healthData = await inftService.getINFT("contractHealth", resolvedHealthSerial);
    console.log(`  Security Score: ${healthData.health.securityScore}/100`);
    console.log(`  Vulnerability Count: ${healthData.vulnerabilities.summary.total}`);
    if (healthData.vulnerabilities.catalog.length > 0) {
      console.log(`  Catalog entry [0]: ${healthData.vulnerabilities.catalog[0].title} (${healthData.vulnerabilities.catalog[0].severity})\n`);
    } else {
      console.log("  (Vulnerability catalog empty on this iNFT — findings may have gone to a prior-run iNFT)\n");
    }

    // 7. SLASHING SIMULATION
    console.log("Step 7: Slashing Simulation (Misconduct)");
    await inftService.slashAgent(agentSerial, 50, 1500, "Collusion detected in auction #102");
    
    const slashedAgent = await inftService.getINFT("agentProfile", agentSerial);
    console.log(`  Reputation after slash: ${slashedAgent.reputation.current}`);
    console.log(`  Stake after slash: ${slashedAgent.economics.stakedAmount} GUARD`);
    console.log(`  Agent Status: ${slashedAgent.identity.status}\n`);

    console.log("Day 3 Demo Completed Successfully! 🛡️");

  } catch (error) {
    console.error(`\n  [FATAL ERROR] ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    inftService.close();
  }
}

main();
