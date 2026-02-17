import { ethers } from "ethers";
import { CONFIG, getOperatorKeys } from "./config.js";
import { HCSClient } from "./hcs-client.js";
import { ContractClient } from "./contract-client.js";
import { Roster } from "./roster.js";
import { createLogger } from "./logger.js";
import { MessageType, now } from "./types.js";

/**
 * Orchestrator Agent — isolated implementation.
 * Listens to discovery + registration, invites eligible agents,
 * opens auctions on-chain, and applies simple winner selection fallback.
 */
export class OrchestratorAgent {
  constructor() {
    this.log = createLogger("orchestrator");
    this.hcs = new HCSClient();
    const { privateKey } = getOperatorKeys();
    this.contracts = ContractClient.fromOperatorKey(privateKey.replace(/^0x/, ""));
    this.roster = new Roster(this.log);
    this.jobs = new Map(); // jobId -> state
  }

  start() {
    this.subscribeDiscovery();
    this.subscribeAgentComms();
    this.subscribeAuditLog();
    this.startPingLoop();
    this.log.info("Orchestrator started (isolated branch)");
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  subscribeDiscovery() {
    this.hcs.subscribe(CONFIG.hcsTopics.discovery, async (msg) => {
      if (msg.type !== MessageType.CONTRACT_DISCOVERED) return;
      await this.handleDiscovery(msg);
    });
    this.log.info(`Listening on discovery topic ${CONFIG.hcsTopics.discovery}`);
  }

  subscribeAgentComms() {
    this.hcs.subscribe(CONFIG.hcsTopics.agentComms, async (msg) => {
      if (msg.type === MessageType.PONG) this.roster.recordPong(msg.agentId);
      if (msg.type === MessageType.FINDINGS_SUBMITTED) await this.handleFindings(msg);
    });
    this.log.info(`Listening on agentComms topic ${CONFIG.hcsTopics.agentComms}`);
  }

  subscribeAuditLog() {
    this.hcs.subscribe(CONFIG.hcsTopics.auditLog, (msg) => {
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
    });

    // Fallback timer if no WinnersSelected event arrives
    setTimeout(() => this.selectWinnersFallback(jobId), CONFIG.timeouts.winnerWaitMs);
  }

  async handleFindings(msg) {
    const { jobId, findingsHash } = msg.payload;
    this.log.info(`Findings submitted for job ${jobId}: ${findingsHash?.slice(0, 12)}…`);
    // In full flow we would gather all submissions then call settleJob; omitted here to avoid conflicts.
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  async inviteAgents(jobId, agents, payload) {
    for (const agent of agents) {
      await this.hcs.publishAgentComms({
        type: "AUCTION_INVITE",
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
