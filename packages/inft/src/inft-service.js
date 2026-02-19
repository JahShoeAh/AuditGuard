/**
 * AuditGuard iNFT Service
 *
 * Core service for minting and managing the three iNFT types:
 *   - Audit Job iNFTs (minted on contract discovery)
 *   - Agent Profile iNFTs (minted on agent registration)
 *   - Contract Health iNFTs (minted on first audit of a contract)
 *
 * NFT metadata is stored as JSON in HTS token metadata bytes.
 * Full metadata is persisted to 0g Labs DA via StorageAdapter
 * (with local JSON fallback when 0g is unreachable).
 *
 * State transitions are validated and tracked in the iNFT metadata.
 */

const path = require("path");
const fs = require("fs");

const {
  Client,
  AccountId,
  PrivateKey,
  TokenMintTransaction,
  TopicMessageSubmitTransaction,
  Hbar,
} = require("@hashgraph/sdk");

const { StorageAdapter } = require("./storage-0g");

const CONFIG_PATH = path.join(__dirname, "..", "..", "sdk", "config.json");

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function parsePrivateKey(rawKey, keyTypeHint = "") {
  const key = String(rawKey || "").trim().replace(/^['"]|['"]$/g, "");
  if (!key) throw new Error("Private key is empty");
  const normalizedHint = String(keyTypeHint || "").trim().toUpperCase();
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  const isHex32 = /^[0-9a-fA-F]{64}$/.test(stripped);
  if (normalizedHint === "ECDSA") return PrivateKey.fromStringECDSA(stripped);
  if (normalizedHint === "ED25519") return PrivateKey.fromStringED25519(stripped);
  if (isHex32) return PrivateKey.fromStringECDSA(stripped);
  return PrivateKey.fromString(key);
}

class INFTService {
  /**
   * @param {object} options
   * @param {string} [options.operatorId] - Hedera account ID (e.g., "0.0.12345")
   * @param {string} [options.operatorKey]- Private key (hex or DER)
   * @param {string} [options.keyType]    - "ECDSA" | "ED25519" | auto
   * @param {string} [options.payerId]    - Backward-compatible alias for operatorId
   * @param {string} [options.payerKey]   - Backward-compatible alias for operatorKey
   * @param {string} [options.payerKeyType]- Backward-compatible alias for keyType
   * @param {StorageAdapter} [options.storage] - Storage adapter (created if not provided)
   */
  constructor({ operatorId, operatorKey, keyType, payerId, payerKey, payerKeyType, storage }) {
    const resolvedOperatorId = operatorId || payerId;
    const resolvedOperatorKey = operatorKey || payerKey;
    const resolvedKeyType = keyType || payerKeyType;

    if (!resolvedOperatorId || !resolvedOperatorKey) {
      throw new Error(
        "INFTService requires Hedera credentials. Provide operatorId/operatorKey " +
          "or payerId/payerKey."
      );
    }

    this.operatorId = AccountId.fromString(resolvedOperatorId);
    this.operatorKey = parsePrivateKey(resolvedOperatorKey, resolvedKeyType);
    this.client = Client.forTestnet().setOperator(this.operatorId, this.operatorKey);
    this.client.setDefaultMaxTransactionFee(new Hbar(5));
    this.config = readConfig();
    this.storage = storage || new StorageAdapter();
  }

  /** Gracefully close the Hedera client. */
  close() {
    this.client.close();
  }

  /** Reload config from disk. */
  reloadConfig() {
    this.config = readConfig();
  }

  // ─── Audit Job iNFT ──────────────────────────────────────────────────────

  /**
   * Mint an Audit Job iNFT when a contract discovery event is received.
   *
   * @param {object} discoveryEvent - Parsed HCS discovery message
   * @param {string} discoveryEvent.contractAddress
   * @param {string} discoveryEvent.chain
   * @param {string} discoveryEvent.contractType
   * @param {number} discoveryEvent.estimatedLineCount
   * @param {number} discoveryEvent.initialRiskScore
   * @param {string} discoveryEvent.deployerAddress
   * @param {number} discoveryEvent.discoveryTimestamp
   * @param {string} [discoveryEvent.scannerAgentId]
   * @param {string} [discoveryEvent.hcsMessageId]
   * @param {number} [discoveryEvent.jobId] - On-chain AuditAuction job ID if already created
   * @returns {Promise<{serialNumber: number, metadata: object}>}
   */
  async mintAuditJobINFT(discoveryEvent) {
    const collections = this.config.inftCollections;
    if (!collections || !collections.auditJob) {
      throw new Error("Audit Job iNFT collection not found in config. Run create-nft-collections.js first.");
    }

    const now = new Date().toISOString();

    const metadata = {
      schemaVersion: "1.0.0",
      tokenId: "",
      jobId: discoveryEvent.jobId || 0,
      target: {
        contractAddress: discoveryEvent.contractAddress,
        chain: discoveryEvent.chain || "hedera",
        contractType: discoveryEvent.contractType || "unknown",
        lineCount: discoveryEvent.estimatedLineCount || 0,
        codeHash: discoveryEvent.codeHash || null,
      },
      discovery: {
        scannerAgentId: discoveryEvent.scannerAgentId || "scanner-default",
        timestamp: new Date((discoveryEvent.discoveryTimestamp || Date.now() / 1000) * 1000).toISOString(),
        initialRiskScore: discoveryEvent.initialRiskScore || 0,
        hcsMessageId: discoveryEvent.hcsMessageId || null,
        discoveryTrigger: discoveryEvent.discoveryTrigger || "new_deployment",
      },
      state: {
        current: "DISCOVERED",
        history: [
          {
            from: "NONE",
            to: "DISCOVERED",
            timestamp: now,
            trigger: "hcs_discovery_event",
          },
        ],
      },
      participants: [],
      reports: {
        findings: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          informational: 0,
          total: 0,
          duplicatesDetected: 0,
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    const serialNumber = await this._mintNFT("auditJob", metadata);
    metadata.tokenId = `${collections.auditJob.tokenId}:${serialNumber}`;

    await this.storage.save("auditJob", serialNumber, metadata);

    console.log(`  [iNFT] Minted Audit Job iNFT #${serialNumber} for ${discoveryEvent.contractAddress}`);
    return { serialNumber, metadata };
  }

  // ─── Agent Profile iNFT ───────────────────────────────────────────────────

  /**
   * Mint an Agent Profile iNFT when an agent registers in the marketplace.
   *
   * @param {object} registration
   * @param {string} registration.agentAddress - EVM address
   * @param {string} registration.agentId - Human-readable ID
   * @param {string} registration.ucpEndpoint
   * @param {string[]} registration.specializations
   * @param {string} registration.tier - COMMODITY | SPECIALIZED | PREMIUM
   * @param {number} registration.stakedAmount - GUARD staked
   * @param {number} registration.initialReputation - Basis points 0-10000
   * @returns {Promise<{serialNumber: number, metadata: object}>}
   */
  async mintAgentProfileINFT(registration) {
    const collections = this.config.inftCollections;
    if (!collections || !collections.agentProfile) {
      throw new Error("Agent Profile iNFT collection not found in config. Run create-nft-collections.js first.");
    }

    const now = new Date().toISOString();

    const metadata = {
      schemaVersion: "1.0.0",
      tokenId: "",
      agentAddress: registration.agentAddress,
      agentId: registration.agentId,
      identity: {
        ucpEndpoint: registration.ucpEndpoint,
        specializations: registration.specializations || [],
        tier: registration.tier || "COMMODITY",
        status: "ACTIVE",
        registeredAt: now,
      },
      reputation: {
        current: registration.initialReputation || 5000,
        history: [
          {
            timestamp: now,
            delta: registration.initialReputation || 5000,
            newScore: registration.initialReputation || 5000,
            reason: "seed_initial",
          },
        ],
        trend: "stable",
        peakScore: registration.initialReputation || 5000,
        specialtyScores: {},
      },
      performance: {
        completedJobs: 0,
        successfulFindings: 0,
        falsePositives: 0,
        falseNegatives: 0,
        accuracyRate: 0,
        auctionsWon: 0,
        auctionsParticipated: 0,
        winRate: 0,
        subContractsCompleted: 0,
        dataListingsSold: 0,
        jobHistory: [],
      },
      economics: {
        stakedAmount: registration.stakedAmount || 0,
        totalEarned: 0,
        totalSlashed: 0,
        pricing: {
          baseBidMultiplier: 1.0,
          reputationDiscountThreshold: 8000,
          discountPercent: 10,
          premiumMarkup: 0,
          maxConcurrentJobs: 3,
        },
        portfolio: {
          activeJobs: [],
          pendingBids: [],
          preferredContractTypes: [],
        },
      },
      staking: {
        totalStaked: registration.stakedAmount || 0,
        lockedStake: 0,
        availableStake: registration.stakedAmount || 0,
        unbondingAmount: 0,
        unbondingCompleteAt: null,
        status: "ACTIVE",
        history: [],
      },
      slashHistory: [],
      state: {
        current: "REGISTERED",
        history: [
          {
            from: "NONE",
            to: "REGISTERED",
            timestamp: now,
            trigger: "agent_registration",
          },
        ],
      },
      createdAt: now,
      updatedAt: now,
    };

    const serialNumber = await this._mintNFT("agentProfile", metadata);
    metadata.tokenId = `${collections.agentProfile.tokenId}:${serialNumber}`;

    await this.storage.save("agentProfile", serialNumber, metadata);

    console.log(`  [iNFT] Minted Agent Profile iNFT #${serialNumber} for ${registration.agentId}`);
    return { serialNumber, metadata };
  }

  // ─── Contract Health iNFT ─────────────────────────────────────────────────

  /**
   * Mint a Contract Health iNFT for a smart contract receiving its first audit.
   *
   * @param {object} contractInfo
   * @param {string} contractInfo.contractAddress
   * @param {string} contractInfo.chain
   * @param {string} [contractInfo.contractType]
   * @param {string} [contractInfo.deployer]
   * @param {string} [contractInfo.currentCodeHash]
   * @param {number} [contractInfo.initialRiskScore] - From discovery, 0-100
   * @returns {Promise<{serialNumber: number, metadata: object}>}
   */
  async mintContractHealthINFT(contractInfo) {
    const collections = this.config.inftCollections;
    if (!collections || !collections.contractHealth) {
      throw new Error("Contract Health iNFT collection not found in config. Run create-nft-collections.js first.");
    }

    const now = new Date().toISOString();
    const initialScore = 100 - (contractInfo.initialRiskScore || 50);

    const metadata = {
      schemaVersion: "1.0.0",
      tokenId: "",
      contract: {
        contractAddress: contractInfo.contractAddress,
        chain: contractInfo.chain || "hedera",
        contractType: contractInfo.contractType || "unknown",
        deployer: contractInfo.deployer || null,
        deployedAt: null,
        currentCodeHash: contractInfo.currentCodeHash || null,
      },
      health: {
        securityScore: initialScore,
        scoreHistory: [
          {
            score: initialScore,
            timestamp: now,
            jobId: 0,
            delta: 0,
          },
        ],
        riskLevel: this._scoreToRiskLevel(initialScore),
        lastAuditTimestamp: null,
        totalAuditsCompleted: 0,
      },
      vulnerabilities: {
        summary: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          informational: 0,
          total: 0,
          remediated: 0,
          open: 0,
        },
        catalog: [],
      },
      auditHistory: [],
      monitoring: {
        isActive: false,
        agentAddress: null,
        weeklyRate: 0,
        startedAt: null,
      },
      vault: {
        vaultAddress: null,
        creator: null,
        currentBalance: 0,
        reservedForEscrow: 0,
        weeklyMonitoringBudget: 0,
        criticalBountyAllocation: 0,
        reauditIntervalSeconds: 0,
      },
      state: {
        current: "UNAUDITED",
        history: [
          {
            from: "NONE",
            to: "UNAUDITED",
            timestamp: now,
            trigger: "contract_health_inft_created",
          },
        ],
      },
      createdAt: now,
      updatedAt: now,
    };

    const serialNumber = await this._mintNFT("contractHealth", metadata);
    metadata.tokenId = `${collections.contractHealth.tokenId}:${serialNumber}`;

    await this.storage.save("contractHealth", serialNumber, metadata);

    console.log(`  [iNFT] Minted Contract Health iNFT #${serialNumber} for ${contractInfo.contractAddress}`);
    return { serialNumber, metadata };
  }

  // ─── State Transitions ────────────────────────────────────────────────────

  /**
   * Transition an Audit Job iNFT to a new state.
   *
   * @param {number} serialNumber
   * @param {string} newState - Target state from AuditJobState enum
   * @param {string} trigger - What caused the transition
   * @param {string} [txHash] - On-chain tx hash if applicable
   * @returns {Promise<object>} Updated metadata
   */
  async transitionAuditJobState(serialNumber, newState, trigger, txHash) {
    const metadata = await this.storage.load("auditJob", serialNumber);
    if (!metadata) throw new Error(`Audit Job iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();
    const previousState = metadata.state.current;

    this._validateAuditJobTransition(previousState, newState);

    metadata.state.history.push({
      from: previousState,
      to: newState,
      timestamp: now,
      trigger,
      txHash: txHash || undefined,
    });
    metadata.state.current = newState;
    metadata.updatedAt = now;

    await this.storage.save("auditJob", serialNumber, metadata);
    console.log(`  [iNFT] Audit Job #${serialNumber}: ${previousState} -> ${newState} (${trigger})`);
    return metadata;
  }

  /**
   * Record agent participation in an audit job.
   *
   * @param {number} serialNumber - Audit Job iNFT serial
   * @param {object} participant - Participant data matching AuditJobParticipant
   * @returns {Promise<object>} Updated metadata
   */
  async addJobParticipant(serialNumber, participant) {
    const metadata = await this.storage.load("auditJob", serialNumber);
    if (!metadata) throw new Error(`Audit Job iNFT #${serialNumber} not found`);

    metadata.participants.push(participant);
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("auditJob", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update auction metadata on an Audit Job iNFT.
   *
   * @param {number} serialNumber
   * @param {object} auctionData - Partial auction fields to merge
   * @returns {Promise<object>} Updated metadata
   */
  async updateAuctionData(serialNumber, auctionData) {
    const metadata = await this.storage.load("auditJob", serialNumber);
    if (!metadata) throw new Error(`Audit Job iNFT #${serialNumber} not found`);

    metadata.auction = { ...(metadata.auction || {}), ...auctionData };
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("auditJob", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update payment data on an Audit Job iNFT.
   *
   * @param {number} serialNumber
   * @param {object} paymentData - Payment fields to merge
   * @returns {Promise<object>} Updated metadata
   */
  async updatePaymentData(serialNumber, paymentData) {
    const metadata = await this.storage.load("auditJob", serialNumber);
    if (!metadata) throw new Error(`Audit Job iNFT #${serialNumber} not found`);

    metadata.payments = { ...(metadata.payments || {}), ...paymentData };
    if (paymentData.breakdown && metadata.payments.breakdown) {
      // Append to breakdown array rather than overwrite
      if (!Array.isArray(metadata.payments.breakdown)) {
        metadata.payments.breakdown = [];
      }
      if (Array.isArray(paymentData.breakdown)) {
        metadata.payments.breakdown.push(...paymentData.breakdown);
      }
    }
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("auditJob", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update reputation on an Agent Profile iNFT.
   *
   * @param {number} serialNumber - Agent Profile iNFT serial
   * @param {number} delta - Reputation change in basis points
   * @param {string} reason - ReputationChangeReason
   * @param {number} [jobId]
   * @param {string} [txHash]
   * @returns {Promise<object>} Updated metadata
   */
  async updateAgentReputation(serialNumber, delta, reason, jobId, txHash) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();
    let newScore = metadata.reputation.current + delta;
    newScore = Math.max(0, Math.min(10000, newScore));

    metadata.reputation.history.push({
      timestamp: now,
      delta,
      newScore,
      reason,
      jobId: jobId || undefined,
      txHash: txHash || undefined,
    });
    metadata.reputation.current = newScore;

    if (newScore > (metadata.reputation.peakScore || 0)) {
      metadata.reputation.peakScore = newScore;
    }

    // Compute trend from last 10 changes
    const recent = metadata.reputation.history.slice(-10);
    if (recent.length >= 3) {
      const totalDelta = recent.reduce((sum, c) => sum + c.delta, 0);
      metadata.reputation.trend = totalDelta > 100 ? "rising" : totalDelta < -100 ? "declining" : "stable";
    }

    metadata.updatedAt = now;
    await this.storage.save("agentProfile", serialNumber, metadata);
    console.log(`  [iNFT] Agent #${serialNumber} reputation: ${delta > 0 ? "+" : ""}${delta} -> ${newScore} (${reason})`);
    return metadata;
  }

  /**
   * Slash an agent for severe misconduct or critical failures.
   *
   * @param {number} serialNumber
   * @param {number} amount - GUARD amount to slash from stake
   * @param {number} reputationPenalty - Basis points to remove
   * @param {string} reason
   * @returns {Promise<object>} Updated metadata
   */
  async slashAgent(serialNumber, amount, reputationPenalty, reason) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();

    // 1. Reputation penalty
    await this.updateAgentReputation(serialNumber, -reputationPenalty, "slash_penalty");

    // 2. Economic slashing
    metadata.economics.totalSlashed = (metadata.economics.totalSlashed || 0) + amount;
    metadata.economics.stakedAmount = Math.max(0, (metadata.economics.stakedAmount || 0) - amount);

    // 3. Update status if stake too low or reputation too low
    if (metadata.reputation.current < 1000 || metadata.economics.stakedAmount < 10) {
      metadata.identity.status = "SLASHED";
      metadata.state.current = "SLASHED";
    }

    metadata.updatedAt = now;
    await this.storage.save("agentProfile", serialNumber, metadata);
    console.log(`  [iNFT] Agent #${serialNumber} SLASHED: -${amount} GUARD, -${reputationPenalty} bps (${reason})`);
    return metadata;
  }

  /**
   * Increase an agent's staked amount.
   *
   * @param {number} serialNumber
   * @param {number} amount - GUARD amount added to stake
   * @returns {Promise<object>} Updated metadata
   */
  async topUpStake(serialNumber, amount) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    metadata.economics.stakedAmount = (metadata.economics.stakedAmount || 0) + amount;

    // If agent was slashed, check if they can be reactivated
    if (metadata.identity.status === "SLASHED" &&
        metadata.economics.stakedAmount >= 100 &&
        metadata.reputation.current > 2000) {
      metadata.identity.status = "ACTIVE";
      metadata.state.current = "ACTIVE";
    }

    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("agentProfile", serialNumber, metadata);
    console.log(`  [iNFT] Agent #${serialNumber} stake topped up: +${amount} GUARD (Total: ${metadata.economics.stakedAmount})`);
    return metadata;
  }

  // ─── Day 3: Staking Details (StakingManager) ──────────────────────────────

  /**
   * Update detailed staking breakdown on an Agent Profile iNFT.
   * Maps to StakingManager.StakeInfo struct fields.
   *
   * @param {number} serialNumber
   * @param {object} stakingUpdate
   * @param {number} [stakingUpdate.totalStaked]
   * @param {number} [stakingUpdate.lockedStake]
   * @param {number} [stakingUpdate.availableStake]
   * @param {number} [stakingUpdate.unbondingAmount]
   * @param {string} [stakingUpdate.unbondingCompleteAt] - ISO timestamp
   * @param {string} [stakingUpdate.status] - ACTIVE | UNBONDING | WITHDRAWN | FROZEN
   * @returns {Promise<object>} Updated metadata
   */
  async updateAgentStakingDetails(serialNumber, stakingUpdate) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    if (!metadata.staking) {
      metadata.staking = {
        totalStaked: 0,
        lockedStake: 0,
        availableStake: 0,
        unbondingAmount: 0,
        unbondingCompleteAt: null,
        status: "ACTIVE",
        history: [],
      };
    }

    const now = new Date().toISOString();
    const prev = { ...metadata.staking };

    for (const [k, v] of Object.entries(stakingUpdate)) {
      if (k !== "history" && v !== undefined) {
        metadata.staking[k] = v;
      }
    }

    // Keep economics.stakedAmount in sync
    if (stakingUpdate.totalStaked !== undefined) {
      metadata.economics.stakedAmount = stakingUpdate.totalStaked;
    }

    // Record snapshot in staking history
    metadata.staking.history.push({
      timestamp: now,
      action: stakingUpdate._action || "update",
      totalStaked: metadata.staking.totalStaked,
      lockedStake: metadata.staking.lockedStake,
      availableStake: metadata.staking.availableStake,
      status: metadata.staking.status,
    });
    // Keep last 50 entries
    if (metadata.staking.history.length > 50) {
      metadata.staking.history = metadata.staking.history.slice(-50);
    }

    metadata.updatedAt = now;
    await this.storage.save("agentProfile", serialNumber, metadata);
    return metadata;
  }

  /**
   * Record a slash event from StakingManager on an Agent Profile iNFT.
   * Stores the full SlashRecord including evidenceHash for 0g DA lookup.
   *
   * @param {number} serialNumber
   * @param {object} slashRecord
   * @param {number} slashRecord.slashId
   * @param {number} slashRecord.jobId
   * @param {number} slashRecord.subJobId
   * @param {string} slashRecord.reason - FALSE_POSITIVE | FALSE_NEGATIVE | MALICIOUS_REPORT | SLA_VIOLATION | COLLUSION | PLAGIARISM
   * @param {number} slashRecord.slashBasisPoints
   * @param {number} slashRecord.slashedAmount - GUARD in human units
   * @param {string} slashRecord.evidenceHash - bytes32 hash of evidence in 0g DA
   * @param {string} slashRecord.slashedBy - address that initiated the slash
   * @returns {Promise<object>} Updated metadata
   */
  async recordSlashOnAgent(serialNumber, slashRecord) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();

    if (!metadata.slashHistory) {
      metadata.slashHistory = [];
    }

    metadata.slashHistory.push({
      slashId: slashRecord.slashId,
      jobId: slashRecord.jobId,
      subJobId: slashRecord.subJobId || 0,
      reason: slashRecord.reason,
      slashBasisPoints: slashRecord.slashBasisPoints,
      slashedAmount: slashRecord.slashedAmount,
      evidenceHash: slashRecord.evidenceHash,
      slashedBy: slashRecord.slashedBy,
      timestamp: now,
      appealStatus: "PENDING",
      appealDeadline: null,
      appealReason: null,
    });

    // Update economics
    metadata.economics.totalSlashed = (metadata.economics.totalSlashed || 0) + slashRecord.slashedAmount;
    metadata.economics.stakedAmount = Math.max(0, (metadata.economics.stakedAmount || 0) - slashRecord.slashedAmount);

    metadata.updatedAt = now;
    await this.storage.save("agentProfile", serialNumber, metadata);
    console.log(`  [iNFT] Agent #${serialNumber} SLASH recorded: slashId=${slashRecord.slashId}, reason=${slashRecord.reason}, -${slashRecord.slashedAmount} GUARD`);
    return metadata;
  }

  /**
   * Update the appeal status of a slash record on an Agent Profile iNFT.
   *
   * @param {number} serialNumber
   * @param {number} slashId
   * @param {string} appealStatus - PENDING | APPROVED | DENIED
   * @param {string} [appealReason] - Agent's appeal justification
   * @param {number} [restoredAmount] - GUARD restored on approval
   * @returns {Promise<object>} Updated metadata
   */
  async updateSlashAppeal(serialNumber, slashId, appealStatus, appealReason, restoredAmount) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    if (!metadata.slashHistory) return metadata;

    const record = metadata.slashHistory.find(s => s.slashId === slashId);
    if (!record) {
      console.warn(`  [iNFT] Agent #${serialNumber}: slash ${slashId} not found in history`);
      return metadata;
    }

    record.appealStatus = appealStatus;
    if (appealReason) record.appealReason = appealReason;

    // If approved, restore economics
    if (appealStatus === "APPROVED" && restoredAmount) {
      metadata.economics.totalSlashed = Math.max(0, (metadata.economics.totalSlashed || 0) - restoredAmount);
      metadata.economics.stakedAmount = (metadata.economics.stakedAmount || 0) + restoredAmount;
      console.log(`  [iNFT] Agent #${serialNumber} appeal APPROVED for slash ${slashId}: +${restoredAmount} GUARD restored`);
    } else if (appealStatus === "DENIED") {
      console.log(`  [iNFT] Agent #${serialNumber} appeal DENIED for slash ${slashId}`);
    }

    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("agentProfile", serialNumber, metadata);
    return metadata;
  }

  /**
   * Upload slash evidence to 0g DA and return the hash.
   * The hash is stored on-chain in StakingManager.SlashRecord.evidenceHash.
   *
   * @param {object} evidence - Evidence payload
   * @param {string} evidence.description
   * @param {number} evidence.jobId
   * @param {string} evidence.agentAddress
   * @param {object[]} [evidence.findings]
   * @param {string} [evidence.additionalData]
   * @returns {Promise<string|null>} 0g root hash or null if upload failed
   */
  async uploadSlashEvidence(evidence) {
    const payload = JSON.stringify({
      type: "SLASH_EVIDENCE",
      timestamp: new Date().toISOString(),
      ...evidence,
    });

    const rootHash = await this.storage.uploadBlob(
      Buffer.from(payload, "utf8"),
      `slash-evidence-job${evidence.jobId || 0}-${Date.now()}`
    );

    if (rootHash) {
      console.log(`  [iNFT] Slash evidence uploaded to 0g DA: ${rootHash}`);
    }
    return rootHash;
  }

  // ─── Day 3: Vault Tracking (VaultFactory / AuditVault) ────────────────────

  /**
   * Update vault info on a Contract Health iNFT.
   *
   * @param {number} serialNumber - Contract Health iNFT serial
   * @param {object} vaultInfo
   * @param {string} vaultInfo.vaultAddress
   * @param {string} [vaultInfo.creator]
   * @param {number} [vaultInfo.currentBalance]
   * @param {number} [vaultInfo.reservedForEscrow]
   * @param {number} [vaultInfo.weeklyMonitoringBudget]
   * @param {number} [vaultInfo.criticalBountyAllocation]
   * @param {number} [vaultInfo.reauditIntervalSeconds]
   * @returns {Promise<object>} Updated metadata
   */
  async updateContractVaultInfo(serialNumber, vaultInfo) {
    const metadata = await this.storage.load("contractHealth", serialNumber);
    if (!metadata) throw new Error(`Contract Health iNFT #${serialNumber} not found`);

    metadata.vault = { ...(metadata.vault || {}), ...vaultInfo };
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("contractHealth", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update monitoring subscription info on a Contract Health iNFT.
   *
   * @param {number} serialNumber
   * @param {object} monitorInfo
   * @param {boolean} monitorInfo.isActive
   * @param {string} [monitorInfo.agentAddress]
   * @param {number} [monitorInfo.weeklyRate]
   * @param {string} [monitorInfo.startedAt]
   * @returns {Promise<object>} Updated metadata
   */
  async updateContractMonitoring(serialNumber, monitorInfo) {
    const metadata = await this.storage.load("contractHealth", serialNumber);
    if (!metadata) throw new Error(`Contract Health iNFT #${serialNumber} not found`);

    metadata.monitoring = { ...(metadata.monitoring || {}), ...monitorInfo };
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("contractHealth", serialNumber, metadata);
    return metadata;
  }

  // ─── Day 3: Treasury Fee Tracking ─────────────────────────────────────────

  /**
   * Record a treasury fee event for ecosystem analytics.
   * Stored in a dedicated treasury metrics section.
   *
   * @param {object} feeEvent
   * @param {string} feeEvent.source - AUDIT_PLATFORM_FEE | DATA_MARKETPLACE_FEE | REPORT_AGENT_FEE | SLASHING_PROCEEDS | SUB_AUCTION_FEE
   * @param {number} feeEvent.amount - GUARD amount
   * @param {number} [feeEvent.jobId]
   * @param {string} [feeEvent.fromContract]
   */
  async recordTreasuryFee(feeEvent) {
    // Store in a special ecosystem metrics key
    const metrics = await this.storage.load("_ecosystem", "treasury") || {
      totalRevenue: 0,
      revenueBySource: {},
      feeHistory: [],
      distributions: [],
    };

    metrics.totalRevenue += feeEvent.amount;
    metrics.revenueBySource[feeEvent.source] = (metrics.revenueBySource[feeEvent.source] || 0) + feeEvent.amount;
    metrics.feeHistory.push({
      ...feeEvent,
      timestamp: new Date().toISOString(),
    });

    // Keep last 200 entries
    if (metrics.feeHistory.length > 200) {
      metrics.feeHistory = metrics.feeHistory.slice(-200);
    }

    await this.storage.save("_ecosystem", "treasury", metrics);
    return metrics;
  }

  /**
   * Record a treasury distribution event.
   *
   * @param {object} distEvent
   * @param {number} distEvent.distributionId
   * @param {number} distEvent.totalDistributed
   * @param {number} distEvent.ucpAmount
   * @param {number} distEvent.reserveAmount
   * @param {number} distEvent.burnAmount
   */
  async recordTreasuryDistribution(distEvent) {
    const metrics = await this.storage.load("_ecosystem", "treasury") || {
      totalRevenue: 0,
      revenueBySource: {},
      feeHistory: [],
      distributions: [],
    };

    metrics.distributions.push({
      ...distEvent,
      timestamp: new Date().toISOString(),
    });

    await this.storage.save("_ecosystem", "treasury", metrics);
    return metrics;
  }

  /**
   * Check for code changes and trigger an autonomous re-audit if needed.
   *
   * @param {number} healthSerial
   * @param {string} newCodeHash
   * @returns {Promise<boolean>} True if re-audit triggered
   */
  async checkAndTriggerReaudit(healthSerial, newCodeHash) {
    const metadata = await this.storage.load("contractHealth", healthSerial);
    if (!metadata) throw new Error(`Contract Health iNFT #${healthSerial} not found`);

    if (metadata.contract.currentCodeHash !== newCodeHash) {
      console.log(`  [iNFT] Code change detected for ${metadata.contract.contractAddress}!`);
      
      const previousHash = metadata.contract.currentCodeHash;
      metadata.contract.currentCodeHash = newCodeHash;
      
      // Update intelligence
      metadata.intelligence = {
        ...(metadata.intelligence || {}),
        autoReauditTriggered: true,
        predictedRiskChange: 20, // 20% increase in risk due to change
      };
      
      metadata.health.riskLevel = "high"; // Escalated due to change
      
      metadata.updatedAt = new Date().toISOString();
      await this.storage.save("contractHealth", healthSerial, metadata);
      
      // In a real system, this would emit an HCS event that Scanner/Orchestrator pick up
      await this.publishToAuditLog("AUTONOMOUS_REAUDIT_TRIGGERED", {
        contractAddress: metadata.contract.contractAddress,
        previousHash,
        newHash: newCodeHash,
        reason: "code_change_detected",
      });
      
      return true;
    }
    return false;
  }

  /**
   * Get personalized job hints for an agent based on their profile.
   *
   * @param {number} agentSerial
   * @returns {Promise<object[]>} List of recommended job hints
   */
  async getAgentPortfolioHints(agentSerial) {
    const agent = await this.storage.load("agentProfile", agentSerial);
    if (!agent) throw new Error(`Agent Profile iNFT #${agentSerial} not found`);

    const openJobs = this.storage.listAll("auditJob").filter(j => j.state.current === "AUCTION_OPEN");
    
    return openJobs.map(job => {
      const matchScore = this._calculateMatchScore(agent, job);
      return {
        jobId: job.jobId,
        tokenId: job.tokenId,
        contractType: job.target.contractType,
        matchScore,
        recommendation: matchScore > 70 ? "HIGH_PRIORITY" : matchScore > 40 ? "SUITABLE" : "LOW_MATCH",
      };
    }).sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Generate a leaderboard of agents by reputation.
   *
   * @param {number} limit
   * @returns {object[]}
   */
  getLeaderboard(limit = 10) {
    const agents = this.storage.listAll("agentProfile");
    return agents
      .filter(a => a.identity.status !== "SLASHED")
      .sort((a, b) => b.reputation.current - a.reputation.current)
      .slice(0, limit)
      .map(a => ({
        agentId: a.agentId,
        reputation: a.reputation.current,
        accuracy: a.performance.accuracyRate,
        jobsCompleted: a.performance.completedJobs,
        tier: a.identity.tier,
      }));
  }

  /**
   * Internal match score calculation for portfolio hints.
   */
  _calculateMatchScore(agent, job) {
    let score = 50; // Base score
    
    // Specialization match
    const jobType = job.target.contractType?.toLowerCase();
    if (agent.identity.specializations.some(s => s.toLowerCase() === jobType)) {
      score += 30;
    }
    
    // Reputation factor
    score += (agent.reputation.current / 1000) * 2;
    
    return Math.min(100, score);
  }

  /**
   * Update Agent Profile performance and economics after a job event.
   *
   * @param {number} serialNumber
   * @param {object} updates - Partial fields to merge into performance/economics
   * @returns {Promise<object>} Updated metadata
   */
  async updateAgentMetrics(serialNumber, updates) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    if (updates.performance) {
      for (const [k, v] of Object.entries(updates.performance)) {
        if (typeof v === "number" && typeof metadata.performance[k] === "number") {
          metadata.performance[k] += v;
        } else {
          metadata.performance[k] = v;
        }
      }
      // Recompute derived fields
      const p = metadata.performance;
      const totalFindings = p.successfulFindings + p.falsePositives + p.falseNegatives;
      p.accuracyRate = totalFindings > 0 ? (p.successfulFindings / totalFindings) * 100 : 0;
      p.winRate = p.auctionsParticipated > 0 ? (p.auctionsWon / p.auctionsParticipated) * 100 : 0;
    }

    if (updates.economics) {
      for (const [k, v] of Object.entries(updates.economics)) {
        if (typeof v === "number" && typeof metadata.economics[k] === "number") {
          metadata.economics[k] += v;
        }
      }
    }

    if (updates.jobHistoryEntry) {
      metadata.performance.jobHistory.push(updates.jobHistoryEntry);
    }

    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("agentProfile", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update Contract Health iNFT after an audit completes.
   *
   * @param {number} serialNumber - Contract Health iNFT serial
   * @param {object} auditResult
   * @param {number} auditResult.jobId
   * @param {number} auditResult.newSecurityScore - 0-100
   * @param {string[]} auditResult.agentsInvolved
   * @param {number} auditResult.findingsCount
   * @param {number} auditResult.criticalFindings
   * @param {number} auditResult.totalCostGuard
   * @param {string} [auditResult.reportHash]
   * @param {string} [auditResult.auditJobTokenId]
   * @returns {Promise<object>} Updated metadata
   */
  async recordAuditOnContractHealth(serialNumber, auditResult) {
    const metadata = await this.storage.load("contractHealth", serialNumber);
    if (!metadata) throw new Error(`Contract Health iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();
    const previousScore = metadata.health.securityScore;

    metadata.health.scoreHistory.push({
      score: auditResult.newSecurityScore,
      timestamp: now,
      jobId: auditResult.jobId,
      delta: auditResult.newSecurityScore - previousScore,
    });
    metadata.health.securityScore = auditResult.newSecurityScore;
    metadata.health.riskLevel = this._scoreToRiskLevel(auditResult.newSecurityScore);
    metadata.health.lastAuditTimestamp = now;
    metadata.health.totalAuditsCompleted += 1;

    metadata.auditHistory.push({
      jobId: auditResult.jobId,
      auditJobTokenId: auditResult.auditJobTokenId || null,
      completedAt: now,
      agentsInvolved: auditResult.agentsInvolved || [],
      findingsCount: auditResult.findingsCount || 0,
      criticalFindings: auditResult.criticalFindings || 0,
      securityScoreBefore: previousScore,
      securityScoreAfter: auditResult.newSecurityScore,
      totalCostGuard: auditResult.totalCostGuard || 0,
      reportHash: auditResult.reportHash || null,
    });

    metadata.updatedAt = now;
    await this.storage.save("contractHealth", serialNumber, metadata);
    console.log(
      `  [iNFT] Contract Health #${serialNumber}: score ${previousScore} -> ${auditResult.newSecurityScore} (job ${auditResult.jobId})`
    );
    return metadata;
  }

  /**
   * Add a new vulnerability to the Contract Health iNFT catalog.
   *
   * @param {number} serialNumber
   * @param {object} vulnerability - Matching Vulnerability type
   * @returns {Promise<object>} Updated metadata
   */
  async addVulnerabilityToContract(serialNumber, vulnerability) {
    const metadata = await this.storage.load("contractHealth", serialNumber);
    if (!metadata) throw new Error(`Contract Health iNFT #${serialNumber} not found`);

    const now = new Date().toISOString();
    vulnerability.discoveredAt = vulnerability.discoveredAt || now;
    vulnerability.status = vulnerability.status || "open";

    metadata.vulnerabilities.catalog.push(vulnerability);

    // Update summary counts
    const severity = vulnerability.severity.toLowerCase();
    if (metadata.vulnerabilities.summary[severity] !== undefined) {
      metadata.vulnerabilities.summary[severity]++;
    }
    metadata.vulnerabilities.summary.total++;
    metadata.vulnerabilities.summary.open++;

    metadata.updatedAt = now;
    await this.storage.save("contractHealth", serialNumber, metadata);
    return metadata;
  }

  /**
   * Update intelligence and risk predictions for a contract.
   *
   * @param {number} serialNumber
   * @param {object} intelligence - Partial intelligence fields
   * @returns {Promise<object>} Updated metadata
   */
  async updateContractIntelligence(serialNumber, intelligence) {
    const metadata = await this.storage.load("contractHealth", serialNumber);
    if (!metadata) throw new Error(`Contract Health iNFT #${serialNumber} not found`);

    metadata.intelligence = { ...(metadata.intelligence || {}), ...intelligence };
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("contractHealth", serialNumber, metadata);
    return metadata;
  }

  /**
   * Process a final audit report to update all involved agents' reputations
   * and the target contract's health.
   *
   * @param {number} jobSerial - Audit Job iNFT serial
   * @param {object} report - Aggregated report findings
   * @returns {Promise<void>}
   */
  async processAuditFindings(jobSerial, report) {
    const jobMeta = await this.storage.load("auditJob", jobSerial);
    if (!jobMeta) throw new Error(`Audit Job iNFT #${jobSerial} not found`);

    const healthSerial = this.findSerial("contractHealth", "contract.contractAddress", jobMeta.target.contractAddress);
    if (!healthSerial) {
      console.warn(`  [iNFT] No Contract Health iNFT found for ${jobMeta.target.contractAddress}, skipping health update`);
    }

    // 1. Update Contract Health with findings
    if (healthSerial) {
      for (const vuln of report.findings) {
        await this.addVulnerabilityToContract(healthSerial, {
          id: `AG-VULN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          severity: vuln.severity,
          category: vuln.category || "logic_error",
          title: vuln.title,
          status: "open",
          discoveredByAgent: vuln.agentId,
          discoveredInJobId: jobMeta.jobId,
        });
      }

      await this.recordAuditOnContractHealth(healthSerial, {
        jobId: jobMeta.jobId,
        newSecurityScore: report.securityScore,
        agentsInvolved: jobMeta.participants.map((p) => p.agentId).filter(Boolean),
        findingsCount: report.findings.length,
        criticalFindings: report.findings.filter((f) => f.severity === "critical").length,
        totalCostGuard: jobMeta.payments?.totalPaid || 0,
        reportHash: report.reportHash,
      });
    }

    // 2. Update Agent Reputations based on their reports
    if (report.agentReports) {
      for (const agentReport of report.agentReports) {
        const agentSerial = this.findSerial("agentProfile", "agentAddress", agentReport.agentAddress);
        if (!agentSerial) continue;

        const delta = this._calculateReputationDelta(agentReport);
        const reason = delta >= 0 ? "valid_findings_bonus" : "false_positive_penalty";

        await this.updateAgentReputation(agentSerial, delta, reason, jobMeta.jobId);
        await this.updateAgentMetrics(agentSerial, {
          performance: {
            successfulFindings: agentReport.validFindings,
            falsePositives: agentReport.falsePositives,
            falseNegatives: agentReport.falseNegatives,
          },
        });
      }
    }
  }

  /**
   * Update an agent's dynamic pricing strategy.
   *
   * @param {number} serialNumber
   * @param {object} pricingUpdates - Partial pricing strategy
   * @returns {Promise<object>} Updated metadata
   */
  async updateAgentPricing(serialNumber, pricingUpdates) {
    const metadata = await this.storage.load("agentProfile", serialNumber);
    if (!metadata) throw new Error(`Agent Profile iNFT #${serialNumber} not found`);

    metadata.economics.pricing = { ...(metadata.economics.pricing || {}), ...pricingUpdates };
    metadata.updatedAt = new Date().toISOString();
    await this.storage.save("agentProfile", serialNumber, metadata);
    return metadata;
  }

  /**
   * Calculate reputation delta based on report accuracy.
   *
   * @param {object} agentReport
   * @returns {number} Delta in basis points
   */
  _calculateReputationDelta(agentReport) {
    // Base rewards for valid findings
    let delta = agentReport.validFindings * 50; // 50 bps per valid finding

    // Penalties for false positives/negatives
    delta -= agentReport.falsePositives * 100; // 100 bps penalty
    delta -= agentReport.falseNegatives * 200; // 200 bps penalty

    // Accuracy multiplier
    if (agentReport.accuracyScore > 90) delta += 100;
    if (agentReport.accuracyScore < 50) delta -= 200;

    return delta;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Get iNFT metadata.
   * @param {string} collectionKey - "auditJob" | "agentProfile" | "contractHealth"
   * @param {number} serialNumber
   * @returns {Promise<object|null>}
   */
  async getINFT(collectionKey, serialNumber) {
    return this.storage.load(collectionKey, serialNumber);
  }

  /**
   * List all iNFTs of a given type.
   * @param {string} collectionKey
   * @returns {object[]}
   */
  listINFTs(collectionKey) {
    return this.storage.listAll(collectionKey);
  }

  /**
   * Find an iNFT by a field value.
   * @param {string} collectionKey
   * @param {string} field - e.g., "jobId", "agentAddress"
   * @param {*} value
   * @returns {object|null}
   */
  findINFT(collectionKey, field, value) {
    return this.storage.findBy(collectionKey, field, value);
  }

  /**
   * Find an iNFT serial number by a field value.
   * @param {string} collectionKey
   * @param {string} field
   * @param {*} value
   * @returns {number|null}
   */
  findSerial(collectionKey, field, value) {
    return this.storage.findSerialBy(collectionKey, field, value);
  }

  /**
   * Upload a large data blob (audit report) to 0g DA and return the root hash.
   * @param {Buffer|string} data
   * @param {string} label
   * @returns {Promise<string|null>}
   */
  async uploadReport(data, label) {
    return this.storage.uploadBlob(data, label);
  }

  // ─── Publishing to HCS ────────────────────────────────────────────────────

  /**
   * Publish an iNFT state change event to the auditLog HCS topic.
   *
   * @param {string} eventType - e.g., "INFT_MINTED", "INFT_STATE_TRANSITION"
   * @param {object} payload - Event data
   * @returns {Promise<string>} HCS message sequence number
   */
  async publishToAuditLog(eventType, payload) {
    const topicId = this.config.hcsTopics?.auditLog;
    if (!topicId) {
      console.warn("  [iNFT] No auditLog HCS topic configured, skipping publish");
      return null;
    }

    const message = JSON.stringify({
      type: eventType,
      timestamp: Date.now(),
      source: "inft-service",
      data: payload,
    });

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(message)
      .setMaxTransactionFee(new Hbar(2))
      .execute(this.client);

    const receipt = await tx.getReceipt(this.client);
    const sequenceNumber = receipt.topicSequenceNumber?.toString();
    console.log(`  [iNFT] Published ${eventType} to HCS auditLog (seq: ${sequenceNumber})`);
    return sequenceNumber;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Mint a single NFT in the given collection with JSON metadata.
   * @param {string} collectionKey - "auditJob" | "agentProfile" | "contractHealth"
   * @param {object} metadata - Full iNFT metadata object
   * @returns {Promise<number>} Serial number of the minted NFT
   */
  async _mintNFT(collectionKey, metadata) {
    const collection = this.config.inftCollections?.[collectionKey];
    if (!collection) {
      throw new Error(`Collection "${collectionKey}" not found in config.inftCollections`);
    }

    // HTS NFT metadata is stored as bytes. We encode a compact JSON summary.
    // Full metadata lives in 0g Labs DA (via StorageAdapter).
    const metadataBytes = Buffer.from(
      JSON.stringify({
        schema: metadata.schemaVersion,
        type: collectionKey,
        created: metadata.createdAt,
      })
    );

    const tx = await new TokenMintTransaction()
      .setTokenId(collection.tokenId)
      .addMetadata(metadataBytes)
      .setMaxTransactionFee(new Hbar(5))
      .freezeWith(this.client);

    const signed = await tx.sign(this.operatorKey);
    const response = await signed.execute(this.client);
    const receipt = await response.getReceipt(this.client);

    const serialNumbers = receipt.serials || [];
    if (serialNumbers.length === 0) {
      throw new Error(`Mint returned no serial numbers for ${collectionKey}`);
    }

    return serialNumbers[0].toNumber();
  }

  /**
   * Validate that an audit job state transition is allowed.
   */
  _validateAuditJobTransition(from, to) {
    const allowed = {
      DISCOVERED: ["AUCTION_OPEN", "CANCELLED"],
      AUCTION_OPEN: ["BIDDING_CLOSED", "AUDITING_IN_PROGRESS", "CANCELLED"],
      BIDDING_CLOSED: ["AUDITING_IN_PROGRESS", "CANCELLED"],
      AUDITING_IN_PROGRESS: ["REPORT_PENDING", "COMPLETED"],
      REPORT_PENDING: ["COMPLETED"],
      COMPLETED: ["VULNERABILITIES_ACTIVE", "MONITORING_ACTIVE"],
      VULNERABILITIES_ACTIVE: ["REMEDIATION_VERIFIED", "MONITORING_ACTIVE"],
      REMEDIATION_VERIFIED: ["MONITORING_ACTIVE"],
      MONITORING_ACTIVE: ["AUCTION_OPEN"],
    };

    const transitions = allowed[from];
    if (!transitions || !transitions.includes(to)) {
      throw new Error(`Invalid state transition: ${from} -> ${to}`);
    }
  }

  /**
   * Convert a 0-100 security score to a risk level.
   */
  _scoreToRiskLevel(score) {
    if (score >= 90) return "minimal";
    if (score >= 70) return "low";
    if (score >= 50) return "medium";
    if (score >= 30) return "high";
    return "critical";
  }
}

module.exports = { INFTService };
