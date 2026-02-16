/**
 * AuditGuard Day 4 Demo: Autonomous Intelligence & Ecosystem Analytics
 *
 * This script demonstrates the Day 4 features for Person 3:
 *   - Leaderboard generation for agents
 *   - Autonomous re-audit triggers on code changes
 *   - Agent portfolio optimization hints
 *   - Cross-iNFT data querying
 *
 * Usage:
 *   node packages/inft/scripts/demo-day4.js
 */

const path = require("path");
require("dotenv").config({ 
  path: path.join(__dirname, "..", "..", "..", ".env"),
  override: true 
});

const { INFTService } = require("../src/inft-service");

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           AuditGuard Day 4 Ecosystem Intelligence Demo       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const inftService = new INFTService({
    operatorId: process.env.HEDERA_ACCOUNT_ID,
    operatorKey: process.env.HEDERA_PRIVATE_KEY,
    keyType: process.env.HEDERA_PRIVATE_KEY_TYPE,
  });

  try {
    // 1. LEADERBOARD
    console.log("Step 1: System Leaderboard (Top Agents)");
    const leaderboard = inftService.getLeaderboard(5);
    console.table(leaderboard);
    console.log("");

    // 2. PORTFOLIO HINTS
    console.log("Step 2: Agent Portfolio Hints (Personalized Recommendations)");
    // Find our agent from Day 3
    const agentSerial = inftService.findSerial("agentProfile", "agentId", "SecuritySentinel-9000");
    if (agentSerial) {
      const hints = await inftService.getAgentPortfolioHints(agentSerial);
      console.log(`  Recommendations for SecuritySentinel-9000:`);
      hints.forEach(h => {
        console.log(`    - Job #${h.jobId} (${h.contractType}): Match Score ${h.matchScore.toFixed(1)} [${h.recommendation}]`);
      });
    } else {
      console.log("  Agent SecuritySentinel-9000 not found. Run Day 3 demo first.");
    }
    console.log("");

    // 3. AUTONOMOUS RE-AUDIT
    console.log("Step 3: Autonomous Intelligence Trigger (Code Change)");
    const healthSerial = inftService.findSerial("contractHealth", "contract.contractAddress", "0x" + "c3".repeat(20));
    if (healthSerial) {
      const newHash = "0x" + "f2".repeat(32);
      console.log(`  Detecting code change for contract...`);
      const triggered = await inftService.checkAndTriggerReaudit(healthSerial, newHash);
      
      if (triggered) {
        const updatedHealth = await inftService.getINFT("contractHealth", healthSerial);
        console.log(`  Re-audit TRIGGERED!`);
        console.log(`  New Risk Level: ${updatedHealth.health.riskLevel}`);
        console.log(`  Predicted Risk Change: +${updatedHealth.intelligence.predictedRiskChange}%`);
      }
    } else {
      console.log("  Contract Health iNFT not found. Run Day 3 demo first.");
    }
    console.log("");

    // 4. ECOSYSTEM SUMMARY
    console.log("Step 4: Ecosystem Health Summary");
    const allHealth = inftService.listINFTs("contractHealth");
    if (allHealth.length > 0) {
      const avgScore = allHealth.reduce((sum, h) => sum + h.health.securityScore, 0) / allHealth.length;
      const criticalCount = allHealth.filter(h => h.health.riskLevel === "critical").length;
      
      console.log(`  Average Ecosystem Security Score: ${avgScore.toFixed(1)}/100`);
      console.log(`  Contracts at Critical Risk: ${criticalCount}`);
    }
    console.log(`  Total Active iNFTs: ${allHealth.length + inftService.listINFTs("agentProfile").length + inftService.listINFTs("auditJob").length}`);

    console.log("\nDay 4 Demo Completed Successfully! 🧠✨");

  } catch (error) {
    console.error(`\n  [FATAL ERROR] ${error.message}`);
  } finally {
    inftService.close();
  }
}

main();
