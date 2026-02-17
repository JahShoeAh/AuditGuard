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
      StakingManager: config.contracts?.stakingManager?.evmAddress,
      Treasury: config.contracts?.treasury?.evmAddress,
      VaultFactory: config.contracts?.vaultFactory?.evmAddress,
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
    this._subJobToParentJob = new Map(); // subJobId -> parentJobId
    this._vaultAddresses = new Map(); // vaultAddress -> contractAddress (for AuditVault event polling)
    this._initIndices();

    // AuditVault ABI loaded separately — vault instances are dynamic, not in config
    this._auditVaultInterface = null;
    const vaultAbi = loadABI("AuditVault");
    if (vaultAbi) {
      this._auditVaultInterface = new ethers.Interface(vaultAbi);
    }
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
    // Rebuild vault address index from contract health iNFTs
    for (const item of this.storage.listAll("contractHealth")) {
      if (item.vault?.vaultAddress && item.contract?.contractAddress) {
        this._vaultAddresses.set(
          item.vault.vaultAddress.toLowerCase(),
          item.contract.contractAddress.toLowerCase()
        );
      }
    }
    console.log(`  [events] Index: ${this._jobIndex.size} jobs, ${this._agentIndex.size} agents, ${this._contractIndex.size} contracts, ${this._vaultAddresses.size} vaults`);
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
    // Poll named contracts (AuditAuction, SubAuction, DataMarketplace, PaymentSettlement,
    // StakingManager, Treasury, VaultFactory)
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

    // Poll individual AuditVault instances
    if (this._auditVaultInterface && this._vaultAddresses.size > 0) {
      for (const [vaultAddr, contractAddr] of this._vaultAddresses) {
        const cursorKey = `AuditVault_${vaultAddr}_lastTimestamp`;
        const afterTimestamp = this.cursor[cursorKey] || null;

        const logs = await fetchContractLogs(vaultAddr, afterTimestamp);
        if (logs.length === 0) continue;

        console.log(`  [events] AuditVault(${vaultAddr.slice(0, 10)}...): ${logs.length} new log(s)`);

        for (const log of logs) {
          const decoded = decodeLog(this._auditVaultInterface, log);
          if (!decoded) continue;

          const timestamp = log.timestamp || log.consensus_timestamp;

          try {
            await this._handleAuditVaultEvent(decoded.name, decoded.args, vaultAddr, contractAddr, timestamp);
          } catch (err) {
            console.error(`  [events] Error handling AuditVault.${decoded.name}: ${err.message}`);
          }

          if (timestamp) {
            this.cursor[cursorKey] = timestamp;
          }
        }

        saveCursor(this.cursor);
      }
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
    if (metadata) {
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

  async _onSubAuction_SubAuctionCreated(args, timestamp) {
    const subJobId = Number(args.subJobId);
    const parentJobId = Number(args.parentJobId);
    console.log(`  [event] SubAuctionCreated: subJobId=${subJobId}, parentJobId=${parentJobId}`);

    this._subJobToParentJob.set(subJobId, parentJobId);

    const serial = this._jobIndex.get(parentJobId);
    if (!serial) return;

    // Record sub-auction requester as participant on parent Audit Job iNFT
    await this.inftService.addJobParticipant(serial, {
      agentAddress: args.requester,
      role: "report_aggregator",
      specialization: args.requiredSpecialization,
    });
  }

  async _onSubAuction_SubBidSubmitted(args, timestamp) {
    const subJobId = Number(args.subJobId);
    console.log(`  [event] SubBidSubmitted: subJobId=${subJobId}, agent=${args.agent}`);

    // Update agent's participation metrics
    const agentSerial = this._agentIndex.get(args.agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentMetrics(agentSerial, {
        performance: { auctionsParticipated: 1 },
      });
    }
  }

  async _onSubAuction_SubContractorSelected(args, timestamp) {
    const subJobId = Number(args.subJobId);
    const agent = args.agent;
    console.log(`  [event] SubContractorSelected: subJobId=${subJobId}, agent=${agent}`);

    const parentJobId = this._subJobToParentJob.get(subJobId);
    if (parentJobId) {
      const serial = this._jobIndex.get(parentJobId);
      if (serial) {
        // Record selected sub-contractor as participant on parent Audit Job iNFT
        await this.inftService.addJobParticipant(serial, {
          agentAddress: agent,
          role: "sub_contractor",
          specialization: "sub_job_" + subJobId,
        });
      }
    }
  }

  async _onSubAuction_ResultDelivered(args, timestamp) {
    const subJobId = Number(args.subJobId);
    console.log(`  [event] ResultDelivered: subJobId=${subJobId}, hash=${args.resultHash}`);
  }

  async _onSubAuction_ResultAccepted(args, timestamp) {
    const subJobId = Number(args.subJobId);
    console.log(`  [event] SubAuction.ResultAccepted: subJobId=${subJobId}`);

    const paymentGuard = Number(args.paymentAmount) / 1e8;
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

  async _onDataMarketplace_DataListed(args, timestamp) {
    const listingId = Number(args.listingId);
    const parentJobId = Number(args.parentJobId);
    console.log(`  [event] DataListed: listingId=${listingId}, parentJobId=${parentJobId}`);

    if (parentJobId > 0) {
      const serial = this._jobIndex.get(parentJobId);
      if (serial) {
        // Log data seller as participant
        await this.inftService.addJobParticipant(serial, {
          agentAddress: args.seller,
          role: "data_seller",
          specialization: "data_listing_" + listingId,
        });
      }
    }
  }

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

    // Update buyer metrics
    const buyerSerial = this._agentIndex.get(buyer.toLowerCase());
    if (buyerSerial) {
      await this.inftService.updateAgentMetrics(buyerSerial, {
        performance: { auctionsParticipated: 1 }, // Counting data purchase as an "activity"
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

      // Transition to COMPLETED if not already
      const metadata = await this.storage.load("auditJob", serial);
      if (metadata && metadata.state.current !== "COMPLETED") {
        await this.inftService.transitionAuditJobState(serial, "COMPLETED", "PaymentSettlement.JobSettled");
      }
    }
  }

  async _onPaymentSettlement_SubJobSettled(args, timestamp) {
    const subJobId = Number(args.subJobId);
    const amount = Number(args.amount) / 1e8;
    console.log(`  [event] SubJobSettled: subJobId=${subJobId}, amount=${amount}`);
  }

  // ─── StakingManager Event Handlers ──────────────────────────────────────

  async _onStakingManager_Staked(args, timestamp) {
    const agent = args.agent;
    const amount = Number(args.amount) / 1e8;
    const newTotal = Number(args.newTotal) / 1e8;
    console.log(`  [event] Staked: agent=${agent}, amount=${amount}, newTotal=${newTotal}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        totalStaked: newTotal,
        availableStake: newTotal, // On fresh stake, all is available
        status: "ACTIVE",
        _action: "stake",
      });
    }
  }

  async _onStakingManager_UnstakeRequested(args, timestamp) {
    const agent = args.agent;
    const amount = Number(args.amount) / 1e8;
    const completesAt = new Date(Number(args.completesAt) * 1000).toISOString();
    console.log(`  [event] UnstakeRequested: agent=${agent}, amount=${amount}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      const agentData = await this.storage.load("agentProfile", agentSerial);
      const currentStaking = agentData?.staking || {};
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        availableStake: Math.max(0, (currentStaking.availableStake || 0) - amount),
        unbondingAmount: amount,
        unbondingCompleteAt: completesAt,
        _action: "unstake_request",
      });
    }
  }

  async _onStakingManager_UnstakeCompleted(args, timestamp) {
    const agent = args.agent;
    const amount = Number(args.amount) / 1e8;
    console.log(`  [event] UnstakeCompleted: agent=${agent}, amount=${amount}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      const agentData = await this.storage.load("agentProfile", agentSerial);
      const currentStaking = agentData?.staking || {};
      const newTotal = Math.max(0, (currentStaking.totalStaked || 0) - amount);
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        totalStaked: newTotal,
        unbondingAmount: 0,
        unbondingCompleteAt: null,
        status: newTotal === 0 ? "WITHDRAWN" : "ACTIVE",
        _action: "unstake_complete",
      });
    }
  }

  async _onStakingManager_StakeLocked(args, timestamp) {
    const agent = args.agent;
    const amount = Number(args.amount) / 1e8;
    const jobId = Number(args.jobId);
    console.log(`  [event] StakeLocked: agent=${agent}, amount=${amount}, jobId=${jobId}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      const agentData = await this.storage.load("agentProfile", agentSerial);
      const currentStaking = agentData?.staking || {};
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        lockedStake: (currentStaking.lockedStake || 0) + amount,
        availableStake: Math.max(0, (currentStaking.availableStake || 0) - amount),
        _action: "lock",
      });
    }
  }

  async _onStakingManager_StakeUnlocked(args, timestamp) {
    const agent = args.agent;
    const amount = Number(args.amount) / 1e8;
    const jobId = Number(args.jobId);
    console.log(`  [event] StakeUnlocked: agent=${agent}, amount=${amount}, jobId=${jobId}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      const agentData = await this.storage.load("agentProfile", agentSerial);
      const currentStaking = agentData?.staking || {};
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        lockedStake: Math.max(0, (currentStaking.lockedStake || 0) - amount),
        availableStake: (currentStaking.availableStake || 0) + amount,
        _action: "unlock",
      });
    }
  }

  async _onStakingManager_SlashInitiated(args, timestamp) {
    const slashId = Number(args.slashId);
    const agent = args.agent;
    const reason = Number(args.reason);
    const slashedAmount = Number(args.slashedAmount) / 1e8;
    const slashBps = Number(args.slashBasisPoints);
    const evidenceHash = args.evidenceHash;
    const jobId = Number(args.jobId);

    const reasonNames = ["FALSE_POSITIVE", "FALSE_NEGATIVE", "MALICIOUS_REPORT", "SLA_VIOLATION", "COLLUSION", "PLAGIARISM"];
    const reasonName = reasonNames[reason] || `UNKNOWN_${reason}`;

    console.log(`  [event] SlashInitiated: slashId=${slashId}, agent=${agent}, reason=${reasonName}, amount=${slashedAmount}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      // Record the full slash with evidence hash
      await this.inftService.recordSlashOnAgent(agentSerial, {
        slashId,
        jobId,
        subJobId: 0,
        reason: reasonName,
        slashBasisPoints: slashBps,
        slashedAmount,
        evidenceHash,
        slashedBy: "StakingManager",
      });

      // Apply reputation penalty matching StakingManager's reputationPenalties mapping
      const repPenalties = { 0: 100, 1: 200, 2: 5000, 3: 300, 4: 5000, 5: 2500 };
      const repDelta = -(repPenalties[reason] || 500);
      await this.inftService.updateAgentReputation(agentSerial, repDelta, `slash_${reasonName.toLowerCase()}`, jobId);

      // Update staking status if frozen
      const agentData = await this.storage.load("agentProfile", agentSerial);
      if (agentData?.staking) {
        const newTotal = Math.max(0, (agentData.staking.totalStaked || 0) - slashedAmount);
        await this.inftService.updateAgentStakingDetails(agentSerial, {
          totalStaked: newTotal,
          status: (slashBps === 10000 || newTotal < 100) ? "FROZEN" : agentData.staking.status,
          _action: "slash",
        });
      }
    }
  }

  async _onStakingManager_AppealFiled(args, timestamp) {
    const slashId = Number(args.slashId);
    const agent = args.agent;
    const reason = args.reason;
    console.log(`  [event] AppealFiled: slashId=${slashId}, agent=${agent}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateSlashAppeal(agentSerial, slashId, "PENDING", reason);
    }
  }

  async _onStakingManager_AppealApproved(args, timestamp) {
    const slashId = Number(args.slashId);
    const agent = args.agent;
    const restoredAmount = Number(args.restoredAmount) / 1e8;
    console.log(`  [event] AppealApproved: slashId=${slashId}, agent=${agent}, restored=${restoredAmount}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateSlashAppeal(agentSerial, slashId, "APPROVED", null, restoredAmount);

      // Reverse reputation penalty
      const agentData = await this.storage.load("agentProfile", agentSerial);
      const slashEntry = agentData?.slashHistory?.find(s => s.slashId === slashId);
      if (slashEntry) {
        const repPenalties = {
          FALSE_POSITIVE: 100, FALSE_NEGATIVE: 200, MALICIOUS_REPORT: 5000,
          SLA_VIOLATION: 300, COLLUSION: 5000, PLAGIARISM: 2500,
        };
        const restore = repPenalties[slashEntry.reason] || 500;
        await this.inftService.updateAgentReputation(agentSerial, restore, "appeal_approved", slashEntry.jobId);
      }

      // Restore staking status
      if (agentData?.staking) {
        const newTotal = (agentData.staking.totalStaked || 0) + restoredAmount;
        await this.inftService.updateAgentStakingDetails(agentSerial, {
          totalStaked: newTotal,
          availableStake: (agentData.staking.availableStake || 0) + restoredAmount,
          status: newTotal >= 100 ? "ACTIVE" : agentData.staking.status,
          _action: "appeal_approved",
        });
      }
    }
  }

  async _onStakingManager_AppealDenied(args, timestamp) {
    const slashId = Number(args.slashId);
    const agent = args.agent;
    console.log(`  [event] AppealDenied: slashId=${slashId}, agent=${agent}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateSlashAppeal(agentSerial, slashId, "DENIED");
    }
  }

  async _onStakingManager_AgentDeactivating(args, timestamp) {
    const agent = args.agent;
    console.log(`  [event] AgentDeactivating: agent=${agent}`);

    const agentSerial = this._agentIndex.get(agent.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentStakingDetails(agentSerial, {
        status: "UNBONDING",
        _action: "deactivate",
      });
    }
  }

  // ─── Treasury Event Handlers ────────────────────────────────────────────

  async _onTreasury_FeeReceived(args, timestamp) {
    const sourceEnum = Number(args.source);
    const amount = Number(args.amount) / 1e8;
    const jobId = Number(args.jobId);
    const fromContract = args.fromContract;

    const sourceNames = ["AUDIT_PLATFORM_FEE", "DATA_MARKETPLACE_FEE", "REPORT_AGENT_FEE", "SLASHING_PROCEEDS", "SUB_AUCTION_FEE"];
    const sourceName = sourceNames[sourceEnum] || `UNKNOWN_${sourceEnum}`;

    console.log(`  [event] FeeReceived: source=${sourceName}, amount=${amount}, jobId=${jobId}`);

    await this.inftService.recordTreasuryFee({
      source: sourceName,
      amount,
      jobId,
      fromContract,
    });
  }

  async _onTreasury_FeeDistributed(args, timestamp) {
    const distributionId = Number(args.distributionId);
    const totalDistributed = Number(args.totalDistributed) / 1e8;
    const ucpAmount = Number(args.ucpAmount) / 1e8;
    const reserveAmount = Number(args.reserveAmount) / 1e8;
    const burnAmount = Number(args.burnAmount) / 1e8;

    console.log(`  [event] FeeDistributed: id=${distributionId}, total=${totalDistributed} (ucp=${ucpAmount}, reserve=${reserveAmount}, burn=${burnAmount})`);

    await this.inftService.recordTreasuryDistribution({
      distributionId,
      totalDistributed,
      ucpAmount,
      reserveAmount,
      burnAmount,
    });
  }

  // ─── VaultFactory Event Handlers ────────────────────────────────────────

  async _onVaultFactory_VaultCreated(args, timestamp) {
    const contractAddress = args.contractAddress;
    const vaultAddress = args.vault;
    const creator = args.creator;
    const contractChain = args.contractChain;

    console.log(`  [event] VaultCreated: contract=${contractAddress}, vault=${vaultAddress}`);

    // Find or create Contract Health iNFT for this contract
    let healthSerial = this._contractIndex.get(contractAddress.toLowerCase());
    if (!healthSerial) {
      // Mint a new Contract Health iNFT since a vault was created for this contract
      const result = await this.inftService.mintContractHealthINFT({
        contractAddress,
        chain: contractChain,
        contractType: "unknown",
      });
      healthSerial = result.serialNumber;
      this._contractIndex.set(contractAddress.toLowerCase(), healthSerial);
    }

    // Update vault info on the Contract Health iNFT
    if (healthSerial) {
      await this.inftService.updateContractVaultInfo(healthSerial, {
        vaultAddress,
        creator,
        currentBalance: 0,
      });
    }

    // Register vault for AuditVault event polling
    this._vaultAddresses.set(vaultAddress.toLowerCase(), contractAddress.toLowerCase());

    await this.inftService.publishToAuditLog("VAULT_CREATED", {
      contractAddress,
      vaultAddress,
      creator,
      chain: contractChain,
    });
  }

  async _onVaultFactory_AutoAuditTriggered(args, timestamp) {
    const contractAddress = args.contractAddress;
    const vaultAddress = args.vault;
    const reason = args.reason;

    console.log(`  [event] AutoAuditTriggered: contract=${contractAddress}, reason=${reason}`);

    const healthSerial = this._contractIndex.get(contractAddress.toLowerCase());
    if (healthSerial) {
      await this.inftService.updateContractIntelligence(healthSerial, {
        autoReauditTriggered: true,
        reauditReason: reason,
        reauditTriggeredAt: new Date().toISOString(),
      });
    }

    await this.inftService.publishToAuditLog("AUTO_AUDIT_TRIGGERED", {
      contractAddress,
      vaultAddress,
      reason,
    });
  }

  // ─── AuditVault Event Handlers (per-vault instance polling) ──────────────

  async _handleAuditVaultEvent(eventName, args, vaultAddr, contractAddr, timestamp) {
    const handler = `_onAuditVault_${eventName}`;
    if (typeof this[handler] === "function") {
      await this[handler](args, vaultAddr, contractAddr, timestamp);
    }
  }

  async _onAuditVault_Deposited(args, vaultAddr, contractAddr, timestamp) {
    const depositor = args.depositor;
    const amount = Number(args.amount) / 1e8;
    const newBalance = Number(args.newBalance) / 1e8;
    console.log(`  [event] AuditVault.Deposited: vault=${vaultAddr.slice(0, 10)}..., depositor=${depositor}, amount=${amount}, balance=${newBalance}`);

    const healthSerial = this._contractIndex.get(contractAddr);
    if (healthSerial) {
      await this.inftService.updateContractVaultInfo(healthSerial, {
        currentBalance: newBalance,
      });
    }
  }

  async _onAuditVault_AuditRecorded(args, vaultAddr, contractAddr, timestamp) {
    const securityScore = Number(args.securityScore);
    const totalAudits = Number(args.totalAudits);
    console.log(`  [event] AuditVault.AuditRecorded: vault=${vaultAddr.slice(0, 10)}..., score=${securityScore}, total=${totalAudits}`);

    const healthSerial = this._contractIndex.get(contractAddr);
    if (healthSerial) {
      // This is the on-chain source of truth for security score
      const currentHealth = await this.storage.load("contractHealth", healthSerial);
      if (currentHealth && currentHealth.health.securityScore !== securityScore) {
        await this.inftService.recordAuditOnContractHealth(healthSerial, {
          jobId: 0, // Will be backfilled when job event arrives
          newSecurityScore: securityScore,
          agentsInvolved: [],
          findingsCount: 0,
          criticalFindings: 0,
        });
      }
    }
  }

  async _onAuditVault_AutoAuditTriggered(args, vaultAddr, contractAddr, timestamp) {
    const reason = args.reason;
    console.log(`  [event] AuditVault.AutoAuditTriggered: vault=${vaultAddr.slice(0, 10)}..., reason=${reason}`);

    const healthSerial = this._contractIndex.get(contractAddr);
    if (healthSerial) {
      await this.inftService.updateContractIntelligence(healthSerial, {
        autoReauditTriggered: true,
        reauditReason: reason,
        reauditTriggeredAt: new Date().toISOString(),
      });
    }
  }

  async _onAuditVault_MonitoringApplied(args, vaultAddr, contractAddr, timestamp) {
    const agent = args.agent;
    const weeklyRate = Number(args.weeklyRate) / 1e8;
    console.log(`  [event] AuditVault.MonitoringApplied: vault=${vaultAddr.slice(0, 10)}..., agent=${agent}, rate=${weeklyRate}/week`);

    const healthSerial = this._contractIndex.get(contractAddr);
    if (healthSerial) {
      await this.inftService.updateContractMonitoring(healthSerial, {
        isActive: true,
        agentAddress: agent,
        weeklyRate,
        startedAt: new Date().toISOString(),
      });
    }
  }

  async _onAuditVault_MonitoringCancelled(args, vaultAddr, contractAddr, timestamp) {
    const agent = args.agent;
    console.log(`  [event] AuditVault.MonitoringCancelled: vault=${vaultAddr.slice(0, 10)}..., agent=${agent}`);

    const healthSerial = this._contractIndex.get(contractAddr);
    if (healthSerial) {
      await this.inftService.updateContractMonitoring(healthSerial, {
        isActive: false,
        agentAddress: null,
        weeklyRate: 0,
      });
    }
  }

  async _onAuditVault_BountyPaid(args, vaultAddr, contractAddr, timestamp) {
    const recipient = args.recipient;
    const amount = Number(args.amount) / 1e8;
    console.log(`  [event] AuditVault.BountyPaid: vault=${vaultAddr.slice(0, 10)}..., recipient=${recipient}, amount=${amount}`);

    // Update agent economics
    const agentSerial = this._agentIndex.get(recipient.toLowerCase());
    if (agentSerial) {
      await this.inftService.updateAgentMetrics(agentSerial, {
        economics: { totalEarned: amount },
        jobHistoryEntry: {
          jobId: 0,
          role: "bounty_hunter",
          completedAt: new Date().toISOString(),
          payment: amount,
        },
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
