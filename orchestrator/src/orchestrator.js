import { ethers } from "ethers";
import { CONFIG, getOperatorKeys } from "./config.js";
import { HCSClient } from "./hcs-client.js";
import { ContractClient } from "./contract-client.js";
import { Roster } from "./roster.js";
import { createLogger } from "./logger.js";
import { MessageType, now } from "./types.js";
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
    this.contracts =
      opts.contracts ??
      ContractClient.fromOperatorKey(getOperatorKeys().privateKey.replace(/^0x/, ""));
    this.roster = opts.roster ?? new Roster(this.log);
    this.jobs = new Map(); // jobId -> state
    this.enablePing = opts.enablePing ?? true;
  }

  start() {
    this.subscribeDiscovery();
    this.subscribeAgentComms();
    this.subscribeAuditLog();
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
      if (msg.type === MessageType.DATA_LISTING_CREATED) await this.handleDataListing(msg);
      if (msg.type === MessageType.SUB_AUCTION_POSTED) await this.handleSubAuctionRequest(msg);
      if (msg.type === MessageType.SUB_RESULT_DELIVERED) await this.handleSubResult(msg);
    });
    this.log.info(`Listening on agentComms topic ${CONFIG.hcsTopics.agentComms}`);
  }

  subscribeAuditLog() {
    this.hcs.subscribeAuditLog((msg) => {
      if (msg.type === MessageType.AGENT_REGISTERED) this.handleAgentRegistered(msg);
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

  async handleDiscovery(msg) {
    const { contractAddress, contractType, budget } = msg.payload;
    const jobId = Date.now(); // demo job id, real impl should come from on-chain JobPosted event
    this.log.info(`New discovery ${contractAddress.slice(0, 12)}… type=${contractType}`);

    // Open auction on-chain
    try {
      // Placeholder: assumes auction contract exposes createJob(...) signature; adjust when ABI final.
      await this.contracts.auction.createJob?.(contractAddress, contractType ?? "unknown", budget ?? 0, now() + 600_000);
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
    });

    // Fallback timer if no WinnersSelected event arrives
    setTimeout(() => this.selectWinnersFallback(jobId), CONFIG.timeouts.winnerWaitMs);
  }

  async handleFindings(msg) {
    const { jobId, findingsHash, evmAddress } = msg.payload;
    this.log.info(`Findings submitted for job ${jobId}: ${findingsHash?.slice(0, 12)}…`);

    const job = this.jobs.get(Number(jobId)) ?? { findings: [], winners: [] };
    job.findings.push({ agentId: msg.agentId, evmAddress, findingsHash });
    this.jobs.set(Number(jobId), job);

    // Demo settlement: pay the submitting agent immediately
    try {
      const base = parseUnits(CONFIG.payments.baseGuard.toString(), CONFIG.guardToken.decimals);
      const bonus = parseUnits(CONFIG.payments.bonusGuard.toString(), CONFIG.guardToken.decimals);
      const reportFee = parseUnits(CONFIG.payments.reportFeeGuard.toString(), CONFIG.guardToken.decimals);
      await this.contracts.paymentSettlement.settleJob(
        Number(jobId ?? 0),
        [{
          recipient: evmAddress ?? "0x0000000000000000000000000000000000000000",
          basePayment: base,
          bonus,
          reportFee,
          paymentType: 0,
          description: "Auto-settlement (demo)",
        }],
        evmAddress ?? "0x0000000000000000000000000000000000000000"
      );
      await this.hcs.publishAuditLog({
        type: "PAYMENT_SETTLED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { jobId, recipient: evmAddress, findingsHash },
      });
      this.log.info(`Settled payment for job ${jobId} to ${evmAddress ?? msg.agentId}`);
    } catch (err) {
      this.log.warn(`Settlement failed for job ${jobId}: ${err}`);
    }
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
    // Demo heuristic: pick up to 3 highest reputation agents
    const candidates = this.roster.eligibleFor(job.contractType)
      .sort((a, b) => (b.reputation ?? 0) - (a.reputation ?? 0))
      .slice(0, 3);

    if (!candidates.length) {
      this.log.warn(`No eligible agents for job ${jobId}; leaving unassigned`);
      return;
    }

    const winnerAddresses = candidates.map((c) => c.evmAddress);
    this.log.info(`Fallback winners for job ${jobId}: ${winnerAddresses.join(", ")}`);

    this.hcs.publishAuditLog({
      type: MessageType.WINNERS_SELECTED_FALLBACK,
      agentId: "orchestrator",
      timestamp: now(),
      payload: { jobId, winners: winnerAddresses },
    }).catch((err) => this.log.warn(`Failed to publish fallback winners: ${err}`));
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
