import { ethers } from "ethers";
import { CONFIG, getOperatorKeys } from "./config.js";
import { HCSClient } from "./hcs-client.js";
import { ContractClient } from "./contract-client.js";
import { Roster } from "./roster.js";
import { createLogger } from "./logger.js";
import { InftBridge } from "./inft-bridge.js";
import { MessageType, now } from "../../agents/shared/types.js";
import { parseUnits } from "ethers";

/**
 * Orchestrator Agent — isolated implementation.
 * Listens to discovery + registration, invites eligible agents,
 * opens auctions on-chain, and applies simple winner selection fallback.
 *
 * Dependencies (HCS, contracts, roster, logger) are injectable for testing.
 */
export class OrchestratorAgent {
  constructor(opts = {}) {
    this.log = opts.log ?? createLogger("orchestrator");
    this.hcs = opts.hcs ?? new HCSClient();
    this.contracts = opts.contracts ?? this.buildContractClientWithFallback();
    this.orchestratorAddress = this.contracts.getAddress?.() ?? "";
    this.roster = opts.roster ?? new Roster(this.log);
    this.inft = opts.inft ?? new InftBridge();
    this.jobs = new Map(); // jobId -> state
    this.enablePing = opts.enablePing ?? true;
  }

  buildContractClientWithFallback() {
    try {
      return ContractClient.fromOperatorKey(getOperatorKeys().privateKey.replace(/^0x/, ""));
    } catch (err) {
      this.log.warn(`Contract client init failed; running HCS-only mode: ${err.message}`);
      return {
        auction: {},
        subAuction: {},
        dataMarketplace: {},
        paymentSettlement: {},
        agentRegistry: {},
        budgetVault: {},
        getAddress: () => "",
      };
    }
  }

  start() {
    this.subscribeDiscovery();
    this.subscribeAgentComms();
    this.subscribeAuditLog();
    this.subscribeContractEvents();
    if (this.enablePing) this.startPingLoop();
    this.log.info("Orchestrator started (isolated branch)");
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  subscribeDiscovery() {
    this.hcs.subscribeDiscovery(async (msg) => {
      if (msg.type !== MessageType.CONTRACT_DISCOVERED) return;
      await this.handleDiscovery(msg);
    });
    this.log.info(`Listening on discovery topic ${CONFIG.hcsTopics.discovery}`);
  }

  subscribeAgentComms() {
    this.hcs.subscribeAgentComms(async (msg) => {
      if (msg.type === MessageType.PONG) this.roster.recordPong(msg.agentId);
      if (msg.type === MessageType.FINDINGS_SUBMITTED) await this.handleFindings(msg);
      if (msg.type === "REPORT_PUBLISHED") await this.handleReportPublished(msg);
      if (msg.type === MessageType.DATA_LISTING_CREATED) await this.handleDataListing(msg);
      if (msg.type === MessageType.SUB_AUCTION_POSTED) await this.handleSubAuctionRequest(msg);
      if (msg.type === MessageType.SUB_RESULT_DELIVERED) await this.handleSubResult(msg);
    });
    this.log.info(`Listening on agentComms topic ${CONFIG.hcsTopics.agentComms}`);
  }

  subscribeAuditLog() {
    this.hcs.subscribeAuditLog((msg) => {
      if (msg.type === MessageType.AGENT_REGISTERED) this.handleAgentRegistered(msg);
      if (msg.type === "BID_SUBMITTED") this.handleBidSubmitted(msg);
    });
    this.log.info(`Listening on auditLog topic ${CONFIG.hcsTopics.auditLog}`);
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  handleAgentRegistered(msg) {
    const payload = msg.payload || {};
    this.roster.upsert({
      agentId: msg.agentId,
      evmAddress: payload.evmAddress,
      specializations: payload.specializations ?? ["any"],
      stake: payload.stake ?? 0,
      reputation: payload.reputation ?? 0,
      endpoint: payload.ucpEndpoint,
    });
  }

  handleBidSubmitted(msg) {
    const { contractAddress, bidAmount, collateral, estimatedTimeSec, reputation, evmAddress } = msg.payload || {};

    // Find the job this bid belongs to (match by contractAddress across open jobs)
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.contractAddress === contractAddress) {
        const agent = this.roster.get(msg.agentId);
        const minStake = CONFIG.stakes.minStake;
        if (agent && (agent.stake ?? 0) < minStake) {
          this.log.warn(`Bid rejected from ${msg.agentId}: stake ${agent.stake} < ${minStake}`);
          return;
        }
        if (bidAmount <= 0) {
          this.log.warn(`Bid rejected from ${msg.agentId}: invalid amount ${bidAmount}`);
          return;
        }

        job.bidders.push({
          agentId: msg.agentId,
          evmAddress: evmAddress ?? agent?.evmAddress,
          bidAmount: bidAmount ?? 0,
          collateral: collateral ?? 0,
          estimatedTimeSec: estimatedTimeSec ?? 0,
          reputation: reputation ?? agent?.reputation ?? 0,
          timestamp: msg.timestamp ?? now(),
        });

        this.log.info(
          `Bid recorded: ${msg.agentId} bid ${bidAmount} GUARD for job ${jobId} ` +
          `(total bids: ${job.bidders.length})`
        );
        return;
      }
    }

    this.log.warn(`Bid from ${msg.agentId} — no matching open job for ${contractAddress?.slice(0, 12)}`);
  }

  async handleDiscovery(msg) {
    const { contractAddress, contractType, budget, riskScore, estimatedLOC } = msg.payload;
    let jobId = Date.now(); // fallback
    this.log.info(`New discovery ${contractAddress.slice(0, 12)}… type=${contractType}`);

    // Open auction on-chain using real ABI
    try {
      const auctionDurationSec = CONFIG.timeouts.winnerWaitMs / 1000;
      const budgetWei = parseUnits(String(budget ?? 0), CONFIG.guardToken.decimals);
      const tx = await this.contracts.auction.createAuditJob?.(
        contractAddress,
        "hedera-testnet",
        contractType ?? "unknown",
        riskScore ?? 0,
        budgetWei,
        estimatedLOC ?? 0,
        auctionDurationSec
      );
      const receipt = await tx?.wait?.();
      if (receipt?.logs) {
        for (const log of receipt.logs) {
          try {
            const parsed = this.contracts.auction.interface.parseLog(log);
            if (parsed?.name === "JobPosted") {
              jobId = Number(parsed.args.jobId);
              break;
            }
          } catch { /* ignore */ }
        }
      }
      this.log.info(`Auction opened on-chain for job ${jobId}`);
    } catch (err) {
      this.log.warn(`Auction create failed (continuing off-chain demo): ${err}`);
    }

    const eligible = this.roster.eligibleFor(contractType);
    await this.inviteAgents(jobId, eligible, msg.payload);

    this.jobs.set(jobId, {
      contractAddress,
      contractType,
      bidders: [],
      openedAt: now(),
      winners: [],
      findings: [],
      reportPublished: false,
    });

    // Fallback timer if no WinnersSelected event arrives
    setTimeout(() => this.selectWinnersFallback(jobId), CONFIG.timeouts.winnerWaitMs);
  }

  async handleFindings(msg) {
    const { jobId, findingsHash, evmAddress, findingsCount = 0, criticalCount = 0 } = msg.payload;
    this.log.info(`Findings submitted for job ${jobId}: ${findingsHash?.slice(0, 12)}…`);

    const key = Number(jobId);
    const job = this.jobs.get(key) ?? { findings: [], winners: [], bidders: [], reportPublished: false };
    job.findings.push({ agentId: msg.agentId, evmAddress, findingsHash, findingsCount, criticalCount });
    this.jobs.set(key, job);

    // Start time-based auto-publish timer on first finding
    if (job.findings.length === 1 && !job.reportPublished) {
      setTimeout(async () => {
        const latest = this.jobs.get(key);
        if (latest && !latest.reportPublished) {
          this.log.info(`Auto-publish timeout for job ${jobId} — publishing report`);
          await this.autoPublishReport(key, latest);
        }
      }, CONFIG.reporting.autoPublishTimeoutMs);
    }

    // Threshold-based auto-publish
    if (job.findings.length >= CONFIG.reporting.autoPublishAfterFindings && !job.reportPublished) {
      await this.autoPublishReport(key, job);
    }
  }

  async autoPublishReport(jobId, job) {
    if (job.reportPublished) return;
    await this.handleReportPublished({
      payload: {
        jobId,
        totalFindings: job.findings.reduce((s, f) => s + (f.findingsCount ?? 0), 0),
        criticalFindings: job.findings.reduce((s, f) => s + (f.criticalCount ?? 0), 0),
        reportHash: job.findings.map((f) => f.findingsHash).join("|").slice(0, 66),
      },
    });
  }

  async handleReportPublished(msg) {
    const { jobId, totalFindings = 0, criticalFindings = 0, reportHash } = msg.payload || {};
    const key = Number(jobId);
    const job = this.jobs.get(key) ?? { findings: [], winners: [], reportPublished: false };
    if (job.reportPublished) return;

    this.log.info(`Report published for job ${jobId} (hash ${String(reportHash).slice(0,16)}...)`);
    job.reportPublished = true;
    this.jobs.set(key, job);

    // Relay report publish to auditLog (ensures HCS has the hash)
    await this.hcs.publishAuditLog({
      type: "REPORT_PUBLISHED",
      agentId: msg.agentId ?? "report-agent",
      timestamp: now(),
      payload: {
        jobId,
        totalFindings,
        criticalFindings,
        reportHash,
        contributors: job.findings.map((f) => f.agentId),
      },
    });

    await this.maybeAlert(jobId, criticalFindings);
    await this.settleAll(jobId, job.findings);
    await this.updateReputation(jobId, job.findings);
    await this.inft.markJobCompleted(jobId, null);
  }

  async handleDataListing(msg) {
    const payload = msg.payload || {};
    const { listingId, category, price, jobId } = payload;
    if (!CONFIG.dataMarketplace.allowedCategories.includes(category)) return;
    if (price > CONFIG.dataMarketplace.maxAutoBuyGuard) return;

    try {
      await this.contracts.dataMarketplace.purchaseData(Number(listingId ?? 0));
      this.log.info(`Auto-bought listing ${listingId} (${category}) for ${price} GUARD`);
      await this.hcs.publishAuditLog({
        type: "DATA_PURCHASED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { listingId, price, jobId, buyer: "orchestrator" },
      });
    } catch (err) {
      this.log.warn(`Auto-buy failed for listing ${listingId}: ${err}`);
    }
  }

  async handleSubAuctionRequest(msg) {
    const p = msg.payload || {};
    const { parentJobId, taskType, paymentAmount } = p;
    const payGuard = paymentAmount ?? CONFIG.subAuction.paymentGuard;
    const paymentWei = parseUnits(payGuard.toString(), CONFIG.guardToken.decimals);

    try {
      await this.contracts.subAuction.createSubAuction(
        Number(parentJobId ?? 0),
        taskType ?? "dependency_analysis",
        taskType ?? "dependency_analysis",
        paymentWei,
        CONFIG.subAuction.slaSeconds,
        CONFIG.subAuction.auctionDurationSeconds,
      );
      this.log.info(`Created sub-auction for job ${parentJobId} task=${taskType}`);
      await this.hcs.publishAuditLog({
        type: "SUB_AUCTION_CREATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { parentJobId, taskType, paymentGuard: payGuard },
      });
    } catch (err) {
      this.log.warn(`Sub-auction creation failed: ${err}`);
    }
  }

  async handleSubResult(msg) {
    const { subAuctionId } = msg.payload || {};
    try {
      await this.contracts.subAuction.acceptResult(Number(subAuctionId ?? 0));
      this.log.info(`Accepted sub-auction result ${subAuctionId}`);
      await this.hcs.publishAuditLog({
        type: "SUB_RESULT_ACCEPTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { subAuctionId },
      });
    } catch (err) {
      this.log.warn(`Accepting sub result failed: ${err}`);
    }
  }

  // Report publishing now handled by the Report Agent; orchestrator waits for REPORT_PUBLISHED

  async maybeAlert(jobId, criticalTotal) {
    if (criticalTotal < CONFIG.alerts.criticalThreshold) return;
    await this.hcs.publishAuditLog({
      type: "ALERT_FIRED",
      agentId: "orchestrator",
      timestamp: now(),
      payload: { jobId, criticalFindings: criticalTotal },
    });
    this.log.info(`Alert fired for job ${jobId} (critical=${criticalTotal})`);
  }

  async settleAll(jobId, findingsArr) {
    if (!findingsArr?.length) return;
    const totalPool = parseUnits(CONFIG.payments.totalGuard.toString(), CONFIG.guardToken.decimals);
    const bonusPerCritical = parseUnits(CONFIG.payments.bonusPerCritical.toString(), CONFIG.guardToken.decimals);
    const reportFee = parseUnits(CONFIG.payments.reportFeeGuard.toString(), CONFIG.guardToken.decimals);

    const scores = findingsArr.map((f) => ({
      agentId: f.agentId,
      evmAddress: f.evmAddress,
      score: (f.findingsCount ?? 0) + 2 * (f.criticalCount ?? 0),
      critical: f.criticalCount ?? 0,
    }));
    const totalScore = scores.reduce((s, f) => s + f.score, 0) || 1;

    const payments = scores.map((f) => {
      const share = BigInt(Math.floor(Number(totalPool) * (f.score / totalScore)));
      const bonus = bonusPerCritical * BigInt(f.critical);
      return {
        recipient: f.evmAddress ?? "0x0000000000000000000000000000000000000000",
        basePayment: share,
        bonus,
        reportFee,
        paymentType: 0,
        description: "Report-settlement",
      };
    });

    try {
      await this.contracts.paymentSettlement.settleJob(
        Number(jobId ?? 0),
        payments,
        this.orchestratorAddress || payments[0].recipient
      );
      await this.hcs.publishAuditLog({
        type: "PAYMENT_SETTLED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { jobId, recipients: payments.map((p) => p.recipient) },
      });
      this.log.info(`Settled job ${jobId} to ${payments.length} recipients`);
    } catch (err) {
      this.log.warn(`Settlement failed for job ${jobId}: ${err}`);
    }
  }

  async updateReputation(jobId, findingsArr) {
    for (const f of findingsArr) {
      const delta = (f.findingsCount ?? 0) + 2 * (f.criticalCount ?? 0);
      await this.hcs.publishAuditLog({
        type: "REPUTATION_UPDATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { jobId, agentId: f.agentId, delta },
      });
      // Optional iNFT hook (basis points)
      const deltaBps = delta * 100;
      await this.inft.updateReputation(f.agentId, deltaBps, jobId);
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  async inviteAgents(jobId, agents, payload) {
    for (const agent of agents) {
      await this.hcs.publishAgentComms({
        type: MessageType.AUCTION_INVITE,
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractAddress: payload.contractAddress,
          contractType: payload.contractType,
          budget: payload.budget ?? 0,
        },
      });
    }
    this.log.info(`Invited ${agents.length} agents to job ${jobId}`);
  }

  selectWinnersFallback(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let winnerAddresses;

    if (job.bidders && job.bidders.length > 0) {
      // Score bids: 55% reputation + 25% price (inverse) + 20% speed (inverse)
      const maxBid = Math.max(...job.bidders.map(b => b.bidAmount || 1));
      const maxTime = Math.max(...job.bidders.map(b => b.estimatedTimeSec || 1));

      const scored = job.bidders.map(b => {
        const repScore = ((b.reputation ?? 0) / 100) * 0.55;
        const priceScore = (1 - (b.bidAmount ?? 0) / maxBid) * 0.25;
        const speedScore = (1 - (b.estimatedTimeSec ?? 0) / maxTime) * 0.20;
        return { ...b, score: repScore + priceScore + speedScore };
      });

      scored.sort((a, b) => b.score - a.score);
      const winners = scored.slice(0, 3);
      winnerAddresses = winners.map(w => w.evmAddress).filter(Boolean);
      this.log.info(
        `Bid-scored winners for job ${jobId} (${job.bidders.length} bids): ` +
        `${winnerAddresses.join(", ")}`
      );
    } else {
      // No bids collected — fall back to roster reputation
      const candidates = this.roster.eligibleFor(job.contractType)
        .sort((a, b) => (b.reputation ?? 0) - (a.reputation ?? 0))
        .slice(0, 3);

      if (!candidates.length) {
        this.log.warn(`No eligible agents for job ${jobId}; leaving unassigned`);
        return;
      }

      winnerAddresses = candidates.map((c) => c.evmAddress);
      this.log.info(`Roster-fallback winners for job ${jobId}: ${winnerAddresses.join(", ")}`);
    }

    job.winners = winnerAddresses;

    this.hcs.publishAuditLog({
      type: MessageType.WINNERS_SELECTED_FALLBACK,
      agentId: "orchestrator",
      timestamp: now(),
      payload: { jobId, winners: winnerAddresses },
    }).catch((err) => this.log.warn(`Failed to publish fallback winners: ${err}`));
  }

  subscribeContractEvents() {
    try {
      if (!this.contracts.auction?.on) return;
      this.contracts.auction.on("WinnersSelected", (jobId, winners, totalEscrowed, platformFee) => {
        const key = Number(jobId);
        const job = this.jobs.get(key);
        if (!job) return;

        const winnerAddrs = Array.isArray(winners) ? winners.map(String) : [];
        job.winners = winnerAddrs;
        this.log.info(`On-chain WinnersSelected for job ${key}: ${winnerAddrs.join(", ")}`);

        this.hcs.publishAuditLog({
          type: "WINNER_SELECTED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { jobId: key, winners: winnerAddrs, totalEscrowed: totalEscrowed?.toString(), platformFee: platformFee?.toString() },
        }).catch(() => {});
      });
      this.log.info("Listening for on-chain WinnersSelected events");
    } catch (err) {
      this.log.warn(`Contract event subscription failed (fallback selection only): ${err.message}`);
    }
  }

  startPingLoop() {
    const sendPing = () => {
      this.hcs.publishAgentComms({
        type: MessageType.PING,
        agentId: "orchestrator",
        timestamp: now(),
        payload: {},
      }).catch(() => {});
      setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
    };
    setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
  }
}
