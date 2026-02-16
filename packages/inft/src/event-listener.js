/**
 * AuditGuard Contract Event Listener
 *
 * Polls the Hedera Mirror Node REST API for contract events from:
 *   - AuditAuction (job lifecycle, bids, winners, escrow, slashing)
 *   - SubAuction (sub-contracting lifecycle)
 *   - DataMarketplace (data listings, purchases)
 *   - PaymentSettlement (atomic batch settlements)
 *
 * Maps each event to iNFT state transitions and metadata updates
 * via the INFTService.
 *
 * Usage:
 *   node packages/inft/src/event-listener.js
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const { ethers } = require("ethers");
const { INFTService } = require("./inft-service");
const { StorageAdapter } = require("./storage-0g");

const CONFIG_PATH = path.join(__dirname, "..", "..", "sdk", "config.json");
const ABIS_DIR = path.join(__dirname, "..", "..", "sdk", "abis");
const CURSOR_PATH = path.join(__dirname, "..", "data", "event-cursor.json");

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const POLL_INTERVAL_MS = 10_000; // 10 seconds

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function loadABI(contractName) {
  const abiPath = path.join(ABIS_DIR, `${contractName}.json`);
  if (!fs.existsSync(abiPath)) return null;
  const data = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  return data.abi || data;
}

function loadCursor() {
  if (!fs.existsSync(CURSOR_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCursor(cursor) {
  fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

/**
 * Fetch contract logs from Hedera Mirror Node.
 * @param {string} contractEvmAddress
 * @param {string} [afterTimestamp] - Only return logs after this timestamp
 * @returns {Promise<object[]>}
 */
async function fetchContractLogs(contractEvmAddress, afterTimestamp) {
  const contractId = contractEvmAddress.toLowerCase();
  let url = `${MIRROR_BASE}/api/v1/contracts/${contractId}/results/logs?order=asc&limit=50`;
  if (afterTimestamp) {
    url += `&timestamp=gt:${afterTimestamp}`;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) return [];
      throw new Error(`Mirror node ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    return data.logs || [];
  } catch (err) {
    console.warn(`  [events] Failed to fetch logs for ${contractEvmAddress}: ${err.message}`);
    return [];
  }
}

/**
 * Decode a log entry using ethers Interface.
 * @param {ethers.Interface} iface
 * @param {object} log - Mirror node log entry
 * @returns {object|null} {name, args} or null if can't decode
 */
function decodeLog(iface, log) {
  try {
    const topics = log.topics || [];
    const data = log.data || "0x";
    if (topics.length === 0) return null;
    const parsed = iface.parseLog({ topics, data });
    if (!parsed) return null;
    return { name: parsed.name, args: parsed.args };
  } catch {
    return null;
  }
}

class EventListener {
  constructor() {
    const config = readConfig();
    this.config = config;
    this.cursor = loadCursor();

    // Initialize storage and iNFT service
    this.storage = new StorageAdapter();
    this.inftService = new INFTService({
      operatorId: process.env.HEDERA_ACCOUNT_ID,
      operatorKey: process.env.HEDERA_PRIVATE_KEY,
      keyType: process.env.HEDERA_PRIVATE_KEY_TYPE,
      storage: this.storage,
    });

    // Load ABIs and create ethers Interfaces for event decoding
    this.interfaces = {};
    this.contracts = {};

    const contractMap = {
      AuditAuction: config.contracts?.auctionContract?.evmAddress,
      SubAuction: config.contracts?.subAuction?.evmAddress,
      DataMarketplace: config.contracts?.dataMarketplace?.evmAddress,
      PaymentSettlement: config.contracts?.paymentSettlement?.evmAddress,
    };

    for (const [name, address] of Object.entries(contractMap)) {
      if (!address) {
        console.warn(`  [events] No address for ${name} in config — skipping`);
        continue;
      }
      const abi = loadABI(name);
      if (!abi) {
        console.warn(`  [events] No ABI for ${name} — skipping`);
        continue;
      }
      this.interfaces[name] = new ethers.Interface(abi);
      this.contracts[name] = address;
    }

    // Lookup indices: jobId -> auditJob serial, agentAddress -> agentProfile serial
    // These are populated from the storage adapter on startup
    this._jobIndex = new Map();
    this._agentIndex = new Map();
    this._contractIndex = new Map(); // contractAddress -> contractHealth serial
    this._initIndices();
  }

  _initIndices() {
    // Rebuild indices from existing iNFTs in storage
    for (const item of this.storage.listAll("auditJob")) {
      if (item.jobId) this._jobIndex.set(item.jobId, this.storage.findSerialBy("auditJob", "jobId", item.jobId));
    }
    for (const item of this.storage.listAll("agentProfile")) {
      if (item.agentAddress) this._agentIndex.set(item.agentAddress.toLowerCase(), this.storage.findSerialBy("agentProfile", "agentAddress", item.agentAddress));
    }
    for (const item of this.storage.listAll("contractHealth")) {
      if (item.contract?.contractAddress) {
        this._contractIndex.set(item.contract.contractAddress.toLowerCase(), this.storage.findSerialBy("contractHealth", "contract.contractAddress", item.contract.contractAddress));
      }
    }
    console.log(`  [events] Index: ${this._jobIndex.size} jobs, ${this._agentIndex.size} agents, ${this._contractIndex.size} contracts`);
  }

  async start() {
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║      AuditGuard Contract Event Listener (Mirror Node)       ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    console.log(`  Polling interval: ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`  Contracts monitored:`);
    for (const [name, address] of Object.entries(this.contracts)) {
      console.log(`    ${name}: ${address}`);
    }
    console.log("\n  Waiting for events...\n");

    // Main polling loop
    const poll = async () => {
      try {
        await this._pollAllContracts();
      } catch (err) {
        console.error(`  [events] Poll error: ${err.message}`);
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  }

  async _pollAllContracts() {
    for (const [contractName, address] of Object.entries(this.contracts)) {
      const iface = this.interfaces[contractName];
      if (!iface) continue;

      const cursorKey = `${contractName}_lastTimestamp`;
      const afterTimestamp = this.cursor[cursorKey] || null;

      const logs = await fetchContractLogs(address, afterTimestamp);
      if (logs.length === 0) continue;

      console.log(`  [events] ${contractName}: ${logs.length} new log(s)`);

      for (const log of logs) {
        const decoded = decodeLog(iface, log);
        if (!decoded) continue;

        const timestamp = log.timestamp || log.consensus_timestamp;

        try {
          await this._handleEvent(contractName, decoded.name, decoded.args, timestamp);
        } catch (err) {
          console.error(`  [events] Error handling ${contractName}.${decoded.name}: ${err.message}`);
        }

        // Update cursor after each successfully processed log
        if (timestamp) {
          this.cursor[cursorKey] = timestamp;
        }
      }

      saveCursor(this.cursor);
    }
  }

  /**
   * Route a decoded event to the appropriate handler.
   */
  async _handleEvent(contractName, eventName, args, timestamp) {
    const handler = `_on${contractName}_${eventName}`;
    if (typeof this[handler] === "function") {
      await this[handler](args, timestamp);
    }
  }

  // ─── AuditAuction Event Handlers ──────────────────────────────────────────

  async _onAuditAuction_JobPosted(args, timestamp) {
    const jobId = Number(args.jobId);
    console.log(`  [event] JobPosted: jobId=${jobId}`);

    // Find the audit job iNFT by matching target contract address
    const contractAddr = args.contractAddress;
    let serial = this._jobIndex.get(jobId);

    if (!serial) {
      // Try to find by contract address (discovery listener may have created it)
      serial = this.storage.findSerialBy("auditJob", "target.contractAddress", contractAddr);
    }

    if (!serial) {
      console.log(`    No Audit Job iNFT found for jobId=${jobId} — it may not have been discovered via HCS yet`);
      return;
    }

    // Link jobId to serial
    this._jobIndex.set(jobId, serial);

    // Update jobId on the iNFT
    const metadata = await this.storage.load("auditJob", serial);
    if (metadata && metadata.jobId === 0) {
      metadata.jobId = jobId;
      await this.storage.save("auditJob", serial, metadata);
    }

    // Transition state
    await this.inftService.transitionAuditJobState(serial, "AUCTION_OPEN", "AuditAuction.JobPosted");

    // Update auction metadata
    await this.inftService.updateAuctionData(serial, {
      deadline: new Date(Number(args.auctionDeadline) * 1000).toISOString(),
      budgetGuard: Number(args.budgetAvailable) / 1e8,
      totalBids: 0,
      winningAgents: [],
      platformFeePaid: 0,
    });

    await this.inftService.publishToAuditLog("INFT_STATE_TRANSITION", {
      collection: "auditJob",
      serialNumber: serial,
      jobId,
      from: "DISCOVERED",
      to: "AUCTION_OPEN",
    });
  }

  async _onAuditAuction_BidSubmitted(args, timestamp) {
    const jobId = Number(args.jobId);
    const serial = this._jobIndex.get(jobId);
    if (!serial) return;

    const agentAddress = args.agent;
    console.log(`  [event] BidSubmitted: jobId=${jobId}, agent=${agentAddress}`);

    await this.inftService.addJobParticipant(serial, {
      agentAddress,
      role: "primary_auditor",
      specialization: args.specialization,
      bidAmount: Number(args.bidAmount) / 1e8,
      reputationAtBid: Number(args.reputationAtBid),
    });

    // Update bid count
    const metadata = await this.storage.load("auditJob", serial);
    if (metadata?.auction) {
      metadata.auction.totalBids = (metadata.auction.totalBids || 0) + 1;
      await this.storage.save("auditJob", serial, metadata);
    }

    // Update agent's auction participation
    const agentSerial = this._agentIndex.get(agentAddress.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentMetrics(agentSerial, {
        performance: { auctionsParticipated: 1 },
      });
    }
  }

  async _onAuditAuction_WinnersSelected(args, timestamp) {
    const jobId = Number(args.jobId);
    const serial = this._jobIndex.get(jobId);
    if (!serial) return;

    const winners = Array.isArray(args.winners) ? args.winners : [];
    console.log(`  [event] WinnersSelected: jobId=${jobId}, winners=${winners.length}`);

    // Transition to AUDITING_IN_PROGRESS
    await this.inftService.transitionAuditJobState(serial, "AUDITING_IN_PROGRESS", "AuditAuction.WinnersSelected");

    // Update auction data
    await this.inftService.updateAuctionData(serial, {
      winningAgents: winners.map(String),
      platformFeePaid: Number(args.platformFee) / 1e8,
    });

    // Update winning agents' metrics
    for (const winner of winners) {
      const agentSerial = this._agentIndex.get(winner.toLowerCase());
      if (agentSerial) {
        await this.inftService.updateAgentMetrics(agentSerial, {
          performance: { auctionsWon: 1 },
        });
      }
    }

    await this.inftService.publishToAuditLog("INFT_STATE_TRANSITION", {
      collection: "auditJob",
      serialNumber: serial,
      jobId,
      from: "AUCTION_OPEN",
      to: "AUDITING_IN_PROGRESS",
    });
  }

  async _onAuditAuction_EscrowReleased(args, timestamp) {
    const jobId = Number(args.jobId);
    const serial = this._jobIndex.get(jobId);
    if (!serial) return;

    const agent = args.agent;
    const payment = Number(args.payment) / 1e8;
    const bonus = Number(args.bonus) / 1e8;
    console.log(`  [event] EscrowReleased: jobId=${jobId}, agent=${agent}, payment=${payment}, bonus=${bonus}`);

    // Update payment breakdown on Audit Job iNFT
    const breakdown = [{ recipient: agent, type: "main_audit", amount: payment }];
    if (bonus > 0) {
      breakdown.push({ recipient: agent, type: "bonus_unique_finding", amount: bonus });
    }
    await this.inftService.updatePaymentData(serial, { breakdown });

    // Update agent economics
    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentMetrics(agentSerial, {
        performance: { completedJobs: 1 },
        economics: { totalEarned: payment + bonus },
        jobHistoryEntry: {
          jobId,
          role: "primary_auditor",
          completedAt: new Date().toISOString(),
          payment: payment + bonus,
          validFindings: 0,
          reputationDelta: 0,
        },
      });
    }
  }

  async _onAuditAuction_AgentSlashed(args, timestamp) {
    const jobId = Number(args.jobId);
    const agent = args.agent;
    const slashBps = Number(args.slashBasisPoints);
    console.log(`  [event] AgentSlashed: jobId=${jobId}, agent=${agent}, bps=${slashBps}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      const slashedGuard = Number(args.slashedAmount) / 1e8;
      await this.inftService.updateAgentReputation(agentSerial, -slashBps, "slash_penalty", jobId);
      await this.inftService.updateAgentMetrics(agentSerial, {
        economics: { totalSlashed: slashedGuard },
      });
    }
  }

  async _onAuditAuction_JobCompleted(args, timestamp) {
    const jobId = Number(args.jobId);
    const serial = this._jobIndex.get(jobId);
    if (!serial) return;

    console.log(`  [event] JobCompleted: jobId=${jobId}`);

    await this.inftService.transitionAuditJobState(serial, "COMPLETED", "AuditAuction.JobCompleted");

    // Update Contract Health iNFT
    const jobMeta = await this.storage.load("auditJob", serial);
    if (jobMeta?.target?.contractAddress) {
      const addr = jobMeta.target.contractAddress.toLowerCase();
      const healthSerial = this._contractIndex.get(addr);
      if (healthSerial) {
        const findings = jobMeta.reports?.findings || {};
        const totalFindings = findings.total || 0;
        // Score improvement: more findings found = better coverage = higher score over time
        const scoreDelta = Math.min(totalFindings * 2, 15);
        const currentHealth = await this.storage.load("contractHealth", healthSerial);
        const newScore = Math.min(100, (currentHealth?.health?.securityScore || 50) + scoreDelta);

        await this.inftService.recordAuditOnContractHealth(healthSerial, {
          jobId,
          newSecurityScore: newScore,
          agentsInvolved: jobMeta.auction?.winningAgents || [],
          findingsCount: totalFindings,
          criticalFindings: findings.critical || 0,
          totalCostGuard: jobMeta.payments?.totalPaid || 0,
          auditJobTokenId: jobMeta.tokenId,
        });
      }
    }

    await this.inftService.publishToAuditLog("INFT_STATE_TRANSITION", {
      collection: "auditJob",
      serialNumber: serial,
      jobId,
      from: "AUDITING_IN_PROGRESS",
      to: "COMPLETED",
    });
  }

  async _onAuditAuction_JobCancelled(args, timestamp) {
    const jobId = Number(args.jobId);
    const serial = this._jobIndex.get(jobId);
    if (!serial) return;

    console.log(`  [event] JobCancelled: jobId=${jobId}`);
    await this.inftService.transitionAuditJobState(serial, "CANCELLED", "AuditAuction.JobCancelled");
  }

  // ─── SubAuction Event Handlers ────────────────────────────────────────────

  async _onSubAuction_ResultAccepted(args, timestamp) {
    const subJobId = Number(args.subJobId);
    console.log(`  [event] SubAuction.ResultAccepted: subJobId=${subJobId}`);

    // Find the sub-contractor agent and reward reputation
    // The agent address comes from the sub-auction's selected contractor
    // For now we use the payment amount event to identify the agent
    const paymentGuard = Number(args.paymentAmount) / 1e8;

    // SubAuction doesn't directly give us the agent address in ResultAccepted,
    // but the sub-contractor was recorded when SubContractorSelected fired.
    // We'd need to track sub-job -> agent mapping. For now, log it.
    console.log(`    Sub-job ${subJobId} accepted, payment: ${paymentGuard} GUARD`);
  }

  async _onSubAuction_SubJobExpired(args, timestamp) {
    const subJobId = Number(args.subJobId);
    const agent = args.agent;
    console.log(`  [event] SubAuction.SubJobExpired: subJobId=${subJobId}, agent=${agent}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentReputation(agentSerial, -300, "sub_contract_expired");
    }
  }

  // ─── DataMarketplace Event Handlers ───────────────────────────────────────

  async _onDataMarketplace_DataPurchased(args, timestamp) {
    const seller = args.seller;
    const buyer = args.buyer;
    const pricePaid = Number(args.pricePaid) / 1e8;
    console.log(`  [event] DataPurchased: seller=${seller}, buyer=${buyer}, price=${pricePaid}`);

    // Update seller economics
    const sellerSerial = this._agentIndex.get(seller.toLowerCase());
    if (sellerSerial) {
      await this.inftService.updateAgentMetrics(sellerSerial, {
        performance: { dataListingsSold: 1 },
        economics: { totalEarned: pricePaid },
      });
    }
  }

  // ─── PaymentSettlement Event Handlers ─────────────────────────────────────

  async _onPaymentSettlement_JobSettled(args, timestamp) {
    const jobId = Number(args.jobId);
    const totalDisbursed = Number(args.totalDisbursed) / 1e8;
    const platformFee = Number(args.platformFee) / 1e8;
    console.log(`  [event] JobSettled: jobId=${jobId}, total=${totalDisbursed}, fee=${platformFee}`);

    const serial = this._jobIndex.get(jobId);
    if (serial) {
      await this.inftService.updatePaymentData(serial, {
        totalPaid: totalDisbursed,
        platformFee,
        settledAt: new Date().toISOString(),
      });
    }
  }

  close() {
    this.inftService.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    throw new Error("Missing HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY in .env");
  }

  const listener = new EventListener();

  process.on("SIGINT", () => {
    console.log("\n  Shutting down event listener...");
    listener.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    listener.close();
    process.exit(0);
  });

  await listener.start();
}

module.exports = { EventListener };

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n  Fatal: ${error.message}`);
    process.exit(1);
  });
}
