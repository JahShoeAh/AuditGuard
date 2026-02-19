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
    this.strictLive = opts.strictLive ?? CONFIG.strictLive;
    this.contracts = opts.contracts ?? this.buildContractClientWithFallback();
    this.orchestratorAddress = this.contracts.getAddress?.() ?? "";
    this.roster = opts.roster ?? new Roster(this.log);
    this.inft = opts.inft ?? new InftBridge();
    this.jobs = new Map(); // jobId(string) -> state
    this.enablePing = opts.enablePing ?? true;
  }

  buildContractClientWithFallback() {
    try {
      return ContractClient.fromOperatorKey(getOperatorKeys().privateKey.replace(/^0x/, ""));
    } catch (err) {
      if (this.strictLive && !CONFIG.demoMode) {
        throw new Error(`Contract client init failed in strict live mode: ${err.message}`);
      }
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

  normalizeId(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "bigint") return value.toString();
    return String(value);
  }

  normalizeJobId(jobId) {
    return this.normalizeId(jobId);
  }

  toChainJobId(jobId) {
    const key = this.normalizeJobId(jobId);
    if (!/^\d+$/.test(key)) {
      throw new Error(`Invalid numeric jobId for chain call: ${key}`);
    }
    return BigInt(key);
  }

  toChainUint(value, label) {
    const key = this.normalizeId(value);
    if (!/^\d+$/.test(key)) {
      throw new Error(`Invalid numeric ${label}: ${key}`);
    }
    return BigInt(key);
  }

  getJobByKey(jobId) {
    const key = this.normalizeJobId(jobId);
    if (this.jobs.has(key)) return this.jobs.get(key);
    return this.jobs.get(jobId);
  }

  setJobByKey(jobId, job) {
    const key = this.normalizeJobId(jobId);
    this.jobs.set(key, job);
  }

  validateDiscoveryPayload(payload) {
    if (!ethers.isAddress(payload.contractAddress)) {
      throw new Error(`invalid contractAddress: ${payload.contractAddress}`);
    }
    if (!Number.isFinite(Number(payload.budget)) || Number(payload.budget) <= 0) {
      throw new Error(`invalid budget: ${payload.budget}`);
    }
    if (!Number.isInteger(Number(payload.riskScore)) || Number(payload.riskScore) < 0 || Number(payload.riskScore) > 100) {
      throw new Error(`invalid riskScore: ${payload.riskScore}`);
    }
    if (!Number.isFinite(Number(payload.estimatedLOC)) || Number(payload.estimatedLOC) < 0) {
      throw new Error(`invalid estimatedLOC: ${payload.estimatedLOC}`);
    }
  }

  start() {
    this.subscribeDiscovery();
    this.subscribeAgentComms();
    this.subscribeAuditLog();
    this.subscribeContractEvents();
    this.subscribeSchedulerEvents();  // HSS audit triggers
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
    try {
      this.validateDiscoveryPayload({ contractAddress, budget, riskScore, estimatedLOC });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`Discovery rejected: ${reason}`);
      await this.hcs.publishAuditLog({
        type: "DISCOVERY_REJECTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          reason,
          strictLive: this.strictLive,
          contractAddress: contractAddress ?? "",
          contractType: contractType ?? "unknown",
        },
      });
      return;
    }

    let jobId = this.normalizeJobId(Date.now()); // fallback
    let auctionOpenedOnChain = false;
    this.log.info(`New discovery ${contractAddress.slice(0, 12)}… type=${contractType}`);

    // Store job FIRST so incoming bids can be matched immediately
    this.setJobByKey(jobId, {
      contractAddress,
      contractType,
      bidders: [],
      openedAt: now(),
      winners: [],
      findings: [],
      reportPublished: false,
    });

    // Open auction on-chain (async — bids can arrive while this runs)
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
      let onChainJobId = null;
      if (receipt?.logs) {
        for (const log of receipt.logs) {
          try {
            const parsed = this.contracts.auction.interface.parseLog(log);
            if (parsed?.name === "JobPosted") {
              onChainJobId = this.normalizeJobId(parsed.args.jobId);
              break;
            }
          } catch { /* ignore */ }
        }
      }
      if (onChainJobId != null && onChainJobId !== jobId) {
        const existing = this.getJobByKey(jobId);
        this.jobs.delete(this.normalizeJobId(jobId));
        this.jobs.delete(jobId);
        if (existing) {
          existing.onChainJobId = onChainJobId;
          this.setJobByKey(onChainJobId, existing);
        }
        jobId = onChainJobId;
      }
      auctionOpenedOnChain = true;
      this.log.info(`Auction opened on-chain for job ${jobId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Auction create failed: ${message}`);
      await this.hcs.publishAuditLog({
        type: "ONCHAIN_TX_FAILED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          phase: "create_audit_job",
          strictLive: this.strictLive,
          contractAddress,
          jobId,
          error: message,
        },
      });
      if (this.strictLive) {
        this.log.warn(`Strict live mode: halting job ${jobId} after createAuditJob failure`);
        const failed = this.getJobByKey(jobId);
        if (failed) {
          failed.failed = true;
          failed.failureReason = message;
          this.setJobByKey(jobId, failed);
        }
        await this.hcs.publishAuditLog({
          type: "JOB_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            jobId,
            contractAddress,
            phase: "create_audit_job",
            error: message,
          },
        });
        return;
      }
    }

    // Publish a normalized auction-opened signal for dashboard/live listeners.
    try {
      await this.hcs.publishAuditLog({
        type: "JOB_CREATED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractAddress,
          contractType: contractType ?? "unknown",
          budget: budget ?? 0,
          riskScore: riskScore ?? 0,
          estimatedLOC: estimatedLOC ?? 0,
          onChain: auctionOpenedOnChain,
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish JOB_CREATED for ${contractAddress?.slice(0, 12)}: ${err}`);
    }

    const eligibility = typeof this.roster.evaluateEligibility === "function"
      ? this.roster.evaluateEligibility(contractType)
      : { eligible: this.roster.eligibleFor(contractType), excluded: [] };
    const eligible = eligibility.eligible;
    const excludedByReason = {};
    for (const item of eligibility.excluded) {
      for (const reason of item.reasons ?? []) {
        excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
      }
    }
    this.log.info(
      `Invite eligibility for job ${jobId}: eligible=${eligible.length} excluded=${eligibility.excluded.length} ` +
      `${JSON.stringify(excludedByReason)}`
    );
    try {
      await this.hcs.publishAuditLog({
        type: "AUCTION_INVITE_SUMMARY",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          contractType: contractType ?? "unknown",
          eligibleAgents: eligible.map((agent) => ({
            agentId: agent.agentId,
            evmAddress: agent.evmAddress,
          })),
          excludedAgents: eligibility.excluded,
          excludedByReason,
        },
      });
    } catch (err) {
      this.log.warn(`Failed to publish AUCTION_INVITE_SUMMARY for job ${jobId}: ${err}`);
    }
    try {
      await this.inviteAgents(jobId, eligible, msg.payload);
    } catch (err) {
      this.log.warn(`Failed to publish AUCTION_INVITE messages for job ${jobId}: ${err}`);
    }

    // ── Redeploy detection: notify AuditScheduler if contract is in REDEPLOY mode ──
    if (this.contracts.auditScheduler?.getSchedule) {
      try {
        const sched = await this.contracts.auditScheduler.getSchedule(contractAddress);
        // TriggerMode 1 = REDEPLOY; only notify if active
        if (sched?.active && Number(sched.mode) === 1) {
          const bytecodeHash = msg.payload?.bytecodeHash;
          const storedHash = sched._bytecodeHash ?? null; // we track this in memory across calls
          if (bytecodeHash && storedHash && bytecodeHash !== storedHash) {
            await this.contracts.auditScheduler.onRedeployDetected(contractAddress);
            this.log.info(`Redeploy detected for ${contractAddress.slice(0, 12)}… — HSS schedule armed`);
          }
          // Cache current hash for future comparisons
          sched._bytecodeHash = bytecodeHash;
        }
      } catch (err) {
        this.log.warn(`AuditScheduler redeploy check failed: ${err.message}`);
      }
    }

    // Fallback timer if no WinnersSelected event arrives
    if (!this.strictLive || auctionOpenedOnChain) {
      const winnerTimer = setTimeout(() => this.selectWinnersFallback(jobId), CONFIG.timeouts.winnerWaitMs);
      winnerTimer.unref?.();
    }
  }

  async handleFindings(msg) {
    const { jobId, findingsHash, evmAddress, findingsCount = 0, criticalCount = 0 } = msg.payload;
    this.log.info(`Findings submitted for job ${jobId}: ${findingsHash?.slice(0, 12)}…`);

    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key) ?? { findings: [], winners: [], bidders: [], reportPublished: false, settled: false };
    const resolvedAddress =
      (typeof evmAddress === "string" && ethers.isAddress(evmAddress) ? evmAddress : undefined) ??
      this.roster.get(msg.agentId)?.evmAddress;

    job.findings.push({
      agentId: msg.agentId,
      evmAddress: resolvedAddress,
      findingsHash,
      findingsCount,
      criticalCount
    });
    this.setJobByKey(key, job);

    // Start time-based auto-publish timer on first finding
    if (job.findings.length === 1 && !job.reportPublished) {
      const publishTimer = setTimeout(async () => {
        const latest = this.getJobByKey(key);
        if (latest && !latest.reportPublished) {
          this.log.info(`Auto-publish timeout for job ${jobId} — publishing report`);
          await this.autoPublishReport(key, latest);
        }
      }, CONFIG.reporting.autoPublishTimeoutMs);
      publishTimer.unref?.();
    }

    // Threshold-based auto-publish
    if (job.findings.length >= CONFIG.reporting.autoPublishAfterFindings && !job.reportPublished) {
      await this.autoPublishReport(key, job);
    }
  }

  async autoPublishReport(jobId, job) {
    if (job.reportPublished) return;
    const key = this.normalizeJobId(jobId);
    await this.handleReportPublished({
      payload: {
        jobId: key,
        totalFindings: job.findings.reduce((s, f) => s + (f.findingsCount ?? 0), 0),
        criticalFindings: job.findings.reduce((s, f) => s + (f.criticalCount ?? 0), 0),
        reportHash: job.findings.map((f) => f.findingsHash).join("|").slice(0, 66),
      },
    });
  }

  async handleReportPublished(msg) {
    const { jobId, totalFindings = 0, reportHash } = msg.payload || {};
    const criticalFindings = Number(msg.payload?.criticalFindings ?? msg.payload?.criticalCount ?? 0);
    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key) ?? { findings: [], winners: [], reportPublished: false, settled: false };
    if (job.reportPublished) return;

    this.log.info(`Report published for job ${jobId} (hash ${String(reportHash).slice(0,16)}...)`);
    job.reportPublished = true;
    this.setJobByKey(key, job);

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

    if (!job.winners?.length) {
      this.selectWinnersFallback(key);
    }

    await this.maybeAlert(key, criticalFindings);
    const reportAgentAddress = this.resolveReportAgentAddress(msg);
    await this.settleAll(key, job, reportAgentAddress);
    await this.updateReputation(key, job.findings);
    await this.inft.markJobCompleted(key, null);
  }

  async handleDataListing(msg) {
    const payload = msg.payload || {};
    const { listingId, category, price, jobId } = payload;
    if (!CONFIG.dataMarketplace.allowedCategories.includes(category)) return;
    if (price > CONFIG.dataMarketplace.maxAutoBuyGuard) return;

    if (this.strictLive) {
      const buyer = this.orchestratorAddress;
      if (!buyer || !ethers.isAddress(buyer)) {
        this.log.warn(`Strict live: skipping auto-buy for listing ${listingId}, invalid orchestrator buyer address`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "invalid_buyer_address" },
        });
        return;
      }

      if (!this.contracts.agentRegistry?.isActiveAgent) {
        this.log.info(`Strict live: skipping auto-buy for listing ${listingId}, cannot verify buyer activity`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "agent_registry_unavailable", buyer },
        });
        return;
      }

      const isActive = await this.contracts.agentRegistry.isActiveAgent(buyer);
      if (!isActive) {
        this.log.info(`Strict live: skipping auto-buy for listing ${listingId}, buyer ${buyer} is not an active agent`);
        await this.hcs.publishAuditLog({
          type: "DATA_PURCHASE_SKIPPED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: { listingId, price, jobId, reason: "inactive_buyer_agent", buyer },
        });
        return;
      }
    }

    try {
      const listingKey = this.toChainUint(listingId, "listingId");
      await this.contracts.dataMarketplace.purchaseData(listingKey);
      this.log.info(`Auto-bought listing ${listingId} (${category}) for ${price} GUARD`);
      await this.hcs.publishAuditLog({
        type: "DATA_PURCHASED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { listingId, price, jobId, buyer: "orchestrator" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Auto-buy failed for listing ${listingId}: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "data_marketplace_auto_buy",
            listingId,
            strictLive: true,
            error: message,
            jobId,
          },
        });
      }
    }
  }

  async handleSubAuctionRequest(msg) {
    const p = msg.payload || {};
    const { parentJobId, taskType, paymentAmount } = p;
    const payGuard = paymentAmount ?? CONFIG.subAuction.paymentGuard;
    const paymentWei = parseUnits(payGuard.toString(), CONFIG.guardToken.decimals);

    try {
      const parentId = this.toChainUint(parentJobId, "parentJobId");
      await this.contracts.subAuction.createSubAuction(
        parentId,
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
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Sub-auction creation failed: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "create_sub_auction",
            strictLive: true,
            parentJobId: this.normalizeJobId(parentJobId),
            error: message,
          },
        });
      }
    }
  }

  async handleSubResult(msg) {
    const { subAuctionId } = msg.payload || {};
    try {
      const subId = this.toChainUint(subAuctionId, "subAuctionId");
      await this.contracts.subAuction.acceptResult(subId);
      this.log.info(`Accepted sub-auction result ${subAuctionId}`);
      await this.hcs.publishAuditLog({
        type: "SUB_RESULT_ACCEPTED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: { subAuctionId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Accepting sub result failed: ${message}`);
      if (this.strictLive) {
        await this.hcs.publishAuditLog({
          type: "ONCHAIN_TX_FAILED",
          agentId: "orchestrator",
          timestamp: now(),
          payload: {
            phase: "accept_sub_result",
            strictLive: true,
            subAuctionId: this.normalizeId(subAuctionId),
            error: message,
          },
        });
      }
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

  async settleAll(jobId, job, reportAgentAddress) {
    const findingsArr = job?.findings ?? [];
    if (!findingsArr.length) return;

    if (job?.settled) {
      this.log.info(`Job ${jobId} already settled in-memory, skipping`);
      return;
    }

    const onChainSettled = await this.isJobAlreadySettledOnChain(jobId);
    if (onChainSettled) {
      this.log.info(`Job ${jobId} already settled on-chain, skipping`);
      job.settled = true;
      this.setJobByKey(jobId, job);
      return;
    }

    const winnerSet = new Set((job.winners ?? []).map((w) => String(w).toLowerCase()));
    if (!winnerSet.size) {
      this.log.warn(`Settlement skipped for job ${jobId}: no winners selected`);
      return;
    }

    const contributorScores = new Map();
    for (const finding of findingsArr) {
      const address =
        (typeof finding.evmAddress === "string" && ethers.isAddress(finding.evmAddress)
          ? finding.evmAddress
          : this.roster.get(finding.agentId)?.evmAddress);
      if (!address || !winnerSet.has(address.toLowerCase())) continue;

      const current = contributorScores.get(address.toLowerCase()) ?? {
        recipient: address,
        agentId: finding.agentId,
        score: 0,
        critical: 0
      };
      current.score += (finding.findingsCount ?? 0) + 2 * (finding.criticalCount ?? 0);
      current.critical += (finding.criticalCount ?? 0);
      contributorScores.set(address.toLowerCase(), current);
    }

    const scores = Array.from(contributorScores.values()).filter((f) => f.score > 0);
    if (!scores.length) {
      this.log.warn(`Settlement skipped for job ${jobId}: no winner findings with valid addresses`);
      return;
    }

    const totalPool = parseUnits(CONFIG.payments.totalGuard.toString(), CONFIG.guardToken.decimals);
    const bonusPerCritical = parseUnits(CONFIG.payments.bonusPerCritical.toString(), CONFIG.guardToken.decimals);
    const totalScore = scores.reduce((s, f) => s + f.score, 0) || 1;
    const totalScoreBigInt = BigInt(totalScore);

    const payments = scores.map((f) => {
      const share = (totalPool * BigInt(f.score)) / totalScoreBigInt;
      const bonus = bonusPerCritical * BigInt(f.critical);
      return {
        recipient: f.recipient,
        basePayment: share,
        bonus,
        reportFee: BigInt(0),
        paymentType: 0,
        description: `Report-settlement:${f.agentId}`,
      };
    });

    const reportAgent = reportAgentAddress || this.orchestratorAddress;
    if (!reportAgent || !ethers.isAddress(reportAgent)) {
      this.log.warn(`Settlement skipped for job ${jobId}: invalid report agent address`);
      return;
    }

    try {
      await this.contracts.paymentSettlement.settleJob(
        this.toChainJobId(jobId),
        payments,
        reportAgent
      );
      job.settled = true;
      this.setJobByKey(jobId, job);
      await this.hcs.publishAuditLog({
        type: "PAYMENT_SETTLED",
        agentId: "orchestrator",
        timestamp: now(),
        payload: {
          jobId,
          recipients: payments.map((p) => p.recipient),
          reportAgent,
          winnerCount: winnerSet.size
        },
      });
      this.log.info(`Settled job ${jobId} to ${payments.length} recipients`);
    } catch (err) {
      this.log.warn(`Settlement failed for job ${jobId}: ${err}`);
    }
  }

  resolveReportAgentAddress(msg) {
    const payloadAddress = msg?.payload?.reportAgentAddress ?? msg?.payload?.reportAgentEvmAddress;
    if (typeof payloadAddress === "string" && ethers.isAddress(payloadAddress)) return payloadAddress;

    const fromRoster = this.roster.get(msg?.agentId ?? "")?.evmAddress;
    if (typeof fromRoster === "string" && ethers.isAddress(fromRoster)) return fromRoster;

    return this.orchestratorAddress;
  }

  async isJobAlreadySettledOnChain(jobId) {
    try {
      if (!this.contracts.paymentSettlement?.isJobSettled) return false;
      return await this.contracts.paymentSettlement.isJobSettled(this.toChainJobId(jobId));
    } catch {
      return false;
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
          riskScore: payload.riskScore ?? 0,
          estimatedLOC: payload.estimatedLOC ?? payload.estimatedLineCount ?? 0,
          estimatedLineCount: payload.estimatedLineCount ?? payload.estimatedLOC ?? 0,
        },
      });
    }
    this.log.info(`Invited ${agents.length} agents to job ${jobId}`);
  }

  selectWinnersFallback(jobId) {
    const key = this.normalizeJobId(jobId);
    const job = this.getJobByKey(key);
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
      payload: { jobId: key, winners: winnerAddresses },
    }).catch((err) => this.log.warn(`Failed to publish fallback winners: ${err}`));
  }

  subscribeContractEvents() {
    try {
      if (!this.contracts.auction?.on) return;
      this.contracts.auction.on("WinnersSelected", (jobId, winners, totalEscrowed, platformFee) => {
        const key = this.normalizeJobId(jobId);
        const job = this.getJobByKey(key);
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

  /**
   * Subscribe to AuditScheduler.AuditTriggered events.
   * This is where HSS integration closes the loop:
   *   1. Vault owner calls AuditScheduler.scheduleAudit()
   *   2. HSS fires triggerAudit() at the specified interval
   *   3. AuditScheduler emits AuditTriggered
   *   4. Orchestrator opens a new AuditAuction job here
   *   5. Full pipeline (bidding → auditing → reporting) runs autonomously
   */
  subscribeSchedulerEvents() {
    try {
      if (!this.contracts.auditScheduler?.on) {
        this.log.info("AuditScheduler not configured — scheduled audits disabled");
        return;
      }

      this.contracts.auditScheduler.on(
        "AuditTriggered",
        async (contractAddress, scheduleAddress, triggeredAt, timesTriggered) => {
          const addr = String(contractAddress);
          this.log.info(
            `HSS AuditTriggered for ${addr.slice(0, 12)}… ` +
            `(schedule=${String(scheduleAddress).slice(0, 12)}…, #${timesTriggered})`
          );

          // Publish to HCS audit log so dashboard picks it up
          await this.hcs.publishAuditLog({
            type: "HSS_AUDIT_TRIGGERED",
            agentId: "orchestrator",
            timestamp: now(),
            payload: {
              contractAddress: addr,
              scheduleAddress: String(scheduleAddress),
              triggeredAt: Number(triggeredAt),
              timesTriggered: Number(timesTriggered),
            },
          });

          // Publish discovery event to HCS so all components (including iNFT listener) see it
          // This triggers the standard pipeline: iNFT minting -> Orchestrator handleDiscovery -> Auction
          const discoveryMsg = {
            type: "CONTRACT_DISCOVERED",
            agentId: "audit-scheduler",
            timestamp: now(),
            payload: {
              contractAddress: addr,
              contractType: "scheduled_audit",
              budget: CONFIG.payments.totalGuard,
              riskScore: 50,
              estimatedLOC: 0,
              triggeredByHSS: true,
              scheduleAddress: String(scheduleAddress),
              deployerAddress: "HSS_SCHEDULE",
            },
          };

          await this.hcs.publishDiscovery(discoveryMsg);
          this.log.info("Published HSS discovery event to HCS (triggers iNFT minting + auction)");
        }
      );

      this.contracts.auditScheduler.on(
        "AuditScheduleCancelled",
        (contractAddress, cancelledBy, reason) => {
          this.log.info(
            `AuditSchedule cancelled for ${String(contractAddress).slice(0, 12)}… ` +
            `by ${String(cancelledBy).slice(0, 12)}… reason=${reason}`
          );
          this.hcs.publishAuditLog({
            type: "HSS_SCHEDULE_CANCELLED",
            agentId: "orchestrator",
            timestamp: now(),
            payload: { contractAddress, cancelledBy, reason },
          }).catch(() => {});
        }
      );

      this.contracts.auditScheduler.on(
        "ScheduleFailed",
        (contractAddress, responseCode, context) => {
          this.log.warn(
            `HSS ScheduleFailed for ${String(contractAddress).slice(0, 12)}… ` +
            `rc=${responseCode} ctx=${context}`
          );
        }
      );

      this.log.info("Listening for on-chain AuditTriggered events (HSS)");
    } catch (err) {
      this.log.warn(`AuditScheduler event subscription failed: ${err.message}`);
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
      const pingTimer = setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
      pingTimer.unref?.();
    };
    const firstPingTimer = setTimeout(sendPing, CONFIG.timeouts.pingIntervalMs);
    firstPingTimer.unref?.();
  }
}
