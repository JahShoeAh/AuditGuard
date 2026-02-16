/**
 * AuditGuard Day 2 Demo: iNFT State Evolution & 0g Labs Storage
 *
 * This script demonstrates the autonomous evolution of iNFTs as agents
 * interact with the marketplace. It simulates the lifecycle of an audit
 * job and shows how metadata is enriched and stored across Hedera and 0g.
 *
 * Usage:
 *   node packages/inft/scripts/demo-day2.js
 */

const path = require("path");
require("dotenv").config({ 
  path: path.join(__dirname, "..", "..", "..", ".env"),
  override: true 
});

const { INFTService } = require("../src/inft-service");

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           AuditGuard Day 2 iNFT Evolution Demo              ║");
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
    // 1. DISCOVERY PHASE
    console.log("Step 1: Contract Discovery");
    const mockDiscovery = {
      contractAddress: "0x" + "a1".repeat(20),
      chain: "hedera",
      contractType: "LendingProtocol",
      estimatedLineCount: 3500,
      initialRiskScore: 75,
      deployerAddress: "0x" + "d1".repeat(20),
      discoveryTimestamp: Math.floor(Date.now() / 1000),
      scannerAgentId: "scanner-42",
      codeHash: "0x" + "c1".repeat(32),
    };

    const { serialNumber: jobSerial, metadata: jobMeta } = await inftService.mintAuditJobINFT(mockDiscovery);
    const { serialNumber: healthSerial } = await inftService.mintContractHealthINFT({
      contractAddress: mockDiscovery.contractAddress,
      chain: mockDiscovery.chain,
      contractType: mockDiscovery.contractType,
      initialRiskScore: mockDiscovery.initialRiskScore,
    });
    console.log(`  Minted Audit Job iNFT #${jobSerial}`);
    console.log(`  Minted Contract Health iNFT #${healthSerial}\n`);

    // 2. AUCTION PHASE
    console.log("Step 2: Auction Open");
    await inftService.transitionAuditJobState(jobSerial, "AUCTION_OPEN", "AuditAuction.JobPosted");
    await inftService.updateAuctionData(jobSerial, {
      deadline: new Date(Date.now() + 3600000).toISOString(),
      budgetGuard: 100,
      totalBids: 0,
    });
    console.log("  Audit Job state: DISCOVERED -> AUCTION_OPEN\n");

    // 3. AGENT BIDDING
    console.log("Step 3: Agent Bidding (Simulation)");
    const mockAgents = [
      { addr: "0x" + "aa".repeat(20), id: "StaticAnalysis-47", spec: "static_analysis", bid: 15, rep: 9400 },
      { addr: "0x" + "bb".repeat(20), id: "LLMContextual-3", spec: "llm_contextual", bid: 35, rep: 8700 },
    ];

    for (const agent of mockAgents) {
      await inftService.addJobParticipant(jobSerial, {
        agentAddress: agent.addr,
        agentId: agent.id,
        role: "primary_auditor",
        specialization: agent.spec,
        bidAmount: agent.bid,
        reputationAtBid: agent.rep,
      });
      console.log(`  Agent ${agent.id} submitted bid for ${agent.bid} GUARD`);
    }
    console.log("");

    // 4. AUDITING PHASE
    console.log("Step 4: Auditing In Progress");
    await inftService.transitionAuditJobState(jobSerial, "AUDITING_IN_PROGRESS", "AuditAuction.WinnersSelected");
    await inftService.updateAuctionData(jobSerial, {
      winningAgents: [mockAgents[0].addr, mockAgents[1].addr],
      platformFeePaid: 5,
    });
    console.log("  Audit Job state: AUCTION_OPEN -> AUDITING_IN_PROGRESS\n");

    // 5. COLLABORATION (SUB-CONTRACTING)
    console.log("Step 5: Agent Collaboration (Sub-Auction)");
    await inftService.addJobParticipant(jobSerial, {
      agentAddress: "0x" + "cc".repeat(20),
      agentId: "Dependency-8",
      role: "sub_contractor",
      specialization: "dependency_analysis",
      paymentReceived: 3,
    });
    console.log("  Agent LLMContextual-3 sub-contracted Dependency-8 for 3 GUARD\n");

    // 6. REPORTING & 0g LABS STORAGE
    console.log("Step 6: Report Synthesis & 0g Labs DA");
    const mockReport = JSON.stringify({
      jobId: jobSerial,
      findings: [
        { severity: "critical", category: "reentrancy", title: "Unprotected withdrawal" },
        { severity: "medium", category: "logic_error", title: "Rounding error in interest calc" },
      ],
      timestamp: new Date().toISOString(),
    });

    const reportHash = await inftService.uploadReport(mockReport, `audit-report-${jobSerial}`);
    console.log(`  Uploaded final report to 0g Labs DA. Hash: ${reportHash}`);

    const metadata = await inftService.storage.load("auditJob", jobSerial);
    metadata.reports = {
      ...metadata.reports,
      finalReportHash: reportHash,
      reportStorageRef: "0g-da://" + reportHash,
      findings: {
        critical: 1,
        high: 0,
        medium: 1,
        low: 0,
        informational: 0,
        total: 2,
        duplicatesDetected: 0,
      },
    };
    await inftService.storage.save("auditJob", jobSerial, metadata);
    console.log("  Enriched Audit Job iNFT with findings and 0g storage refs\n");

    // 7. SETTLEMENT & REPUTATION
    console.log("Step 7: Payment Settlement & Reputation Update");
    await inftService.transitionAuditJobState(jobSerial, "COMPLETED", "AuditAuction.JobCompleted");
    
    // Update LLM agent's reputation
    const llmAgentAddr = mockAgents[1].addr;
    // We don't have a profile iNFT for this demo, but we can mint one
    const { serialNumber: agentSerial } = await inftService.mintAgentProfileINFT({
      agentAddress: llmAgentAddr,
      agentId: "LLMContextual-3",
      ucpEndpoint: "openclaw://llm-3",
      specializations: ["llm_contextual"],
      tier: "PREMIUM",
      initialReputation: 8700,
    });
    
    await inftService.updateAgentReputation(agentSerial, 400, "job_completion", jobSerial);
    await inftService.updateAgentMetrics(agentSerial, {
      performance: { completedJobs: 1, successfulFindings: 1, auctionsWon: 1 },
      economics: { totalEarned: 35 },
    });

    // Update Contract Health
    await inftService.recordAuditOnContractHealth(healthSerial, {
      jobId: jobSerial,
      newSecurityScore: 88,
      agentsInvolved: ["StaticAnalysis-47", "LLMContextual-3"],
      findingsCount: 2,
      criticalFindings: 1,
      totalCostGuard: 50,
      reportHash: reportHash,
    });
    console.log("  Updated Agent Profile and Contract Health iNFTs\n");

    // 8. FINAL STATE
    console.log("Step 8: Final iNFT State Summary");
    const finalJob = await inftService.getINFT("auditJob", jobSerial);
    const finalHealth = await inftService.getINFT("contractHealth", healthSerial);
    const finalAgent = await inftService.getINFT("agentProfile", agentSerial);

    console.log(`  [Audit Job #${jobSerial}] State: ${finalJob.state.current}`);
    console.log(`    Participants: ${finalJob.participants.length}`);
    console.log(`    Report Hash: ${finalJob.reports.finalReportHash.slice(0, 20)}...`);
    
    console.log(`  [Contract Health #${healthSerial}] Score: ${finalHealth.health.securityScore}/100`);
    console.log(`    Risk Level: ${finalHealth.health.riskLevel}`);
    
    console.log(`  [Agent Profile #${agentSerial}] Reputation: ${finalAgent.reputation.current}`);
    console.log(`    Trend: ${finalAgent.reputation.trend}`);

    console.log("\n  Day 2 Demo Completed Successfully! 🚀");

  } catch (error) {
    console.error(`\n  [FATAL ERROR] ${error.message}`);
    console.error(error.stack);
  } finally {
    inftService.close();
  }
}

main();
