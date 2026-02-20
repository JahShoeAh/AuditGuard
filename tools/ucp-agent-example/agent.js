import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountId,
  Client,
  PrivateKey,
  TopicId,
  TopicMessageQuery,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";
const HEDERA_NETWORK = { name: "hedera_testnet", chainId: 296 };
const GUARD_DECIMALS = 8;

function loadAbi(contractName) {
  const abiPath = path.resolve(__dirname, `../../packages/sdk/abis/${contractName}.json`);
  const raw = readFileSync(abiPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.abi)) {
    throw new Error(`ABI file ${abiPath} does not include an 'abi' array.`);
  }
  return parsed.abi;
}

export class UcpAgent {
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.pendingJobs = new Map();
    this.bidSubmittedJobs = new Set();
    this.subscriptionHandle = null;
    this.auctionListener = null;
    this.server = null;
  }

  async init() {
    const hederaKey = PrivateKey.fromStringECDSA(this.config.privateKey);
    this.hederaClient = Client.forTestnet();
    this.hederaClient.setOperator(AccountId.fromString(this.config.accountId), hederaKey);

    const provider = new ethers.JsonRpcProvider(HEDERA_TESTNET_RPC, HEDERA_NETWORK, {
      batchMaxCount: 1,
      staticNetwork: true,
    });

    this.wallet = new ethers.Wallet(hederaKey.toStringRaw(), provider);
    this.evmAddress = this.wallet.address;

    const auctionAbi = loadAbi("AuditAuction");
    const registryAbi = loadAbi("AgentRegistry");
    const erc20Abi = [
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function balanceOf(address owner) external view returns (uint256)",
      "function allowance(address owner, address spender) external view returns (uint256)",
    ];

    this.auctionContract = new ethers.Contract(
      this.config.auctionAddress,
      auctionAbi,
      this.wallet
    );
    this.agentRegistry = new ethers.Contract(
      this.config.agentRegistryAddress,
      registryAbi,
      this.wallet
    );
    this.guardToken = new ethers.Contract(
      this.config.guardTokenAddress,
      erc20Abi,
      this.wallet
    );

    this.log(`Initialized wallet ${this.evmAddress}`);
  }

  async registerOnChain() {
    if (!this.config.ucpEndpoint) {
      throw new Error(
        "UCP_AGENT_ENDPOINT is required for on-chain registration. The dashboard registration and orchestrator task delivery rely on this reachable endpoint."
      );
    }

    const tx = await this.agentRegistry.registerAgent(
      this.agentId,
      this.config.ucpEndpoint,
      this.config.specializations,
      ethers.parseUnits(String(this.config.stakeGuard), GUARD_DECIMALS)
    );
    const receipt = await tx.wait();
    this.log(`registerAgent confirmed in tx ${receipt?.hash ?? tx.hash}`);
  }

  async announceOnHcs() {
    await this._publishAuditLog({
      type: "AGENT_REGISTERED",
      agentId: this.agentId,
      timestamp: Date.now(),
      payload: {
        evmAddress: this.evmAddress,
        specializations: this.config.specializations,
        stake: this.config.stakeGuard,
        reputation: this.config.reputation,
        ucpEndpoint: this.config.ucpEndpoint,
      },
    });
    this.log("Published AGENT_REGISTERED to auditLog topic");
  }

  subscribeToHcs() {
    this.subscriptionHandle = new TopicMessageQuery()
      .setTopicId(TopicId.fromString(this.config.agentCommsTopicId))
      .subscribe(this.hederaClient, null, async (message) => {
        try {
          const parsed = JSON.parse(Buffer.from(message.contents).toString("utf8"));
          await this._handleAgentComms(parsed);
        } catch (error) {
          this.log(
            `agentComms parse/handle error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });

    this.auctionListener = async (jobId, winners) => {
      const jobKey = String(jobId);
      const normalizedWinners = Array.isArray(winners)
        ? winners.map((winner) => String(winner).toLowerCase())
        : [];
      const isWinner = normalizedWinners.includes(String(this.evmAddress).toLowerCase());

      if (!isWinner) {
        return;
      }

      const pending = this.pendingJobs.get(jobKey);
      if (!pending) {
        this.log(`WinnersSelected includes this agent for job ${jobKey}, but no pending job found.`);
        return;
      }

      this.log(`WinnersSelected: won job ${jobKey}`);
      await this._runAudit(pending);
    };

    this.auctionContract.on("WinnersSelected", this.auctionListener);
    this.log(`Subscribed to HCS topic ${this.config.agentCommsTopicId} and WinnersSelected events`);
  }

  async _handleAgentComms(msg) {
    if (!msg || typeof msg !== "object") {
      return;
    }

    if (msg.type === "PING") {
      await this._publishAgentComms({
        type: "PONG",
        agentId: this.agentId,
        timestamp: Date.now(),
      });
      return;
    }

    if (msg.type === "AUCTION_INVITE") {
      await this.handleAuctionInvite(msg.payload ?? {});
    }
  }

  async handleAuctionInvite(payload) {
    const jobId = payload?.jobId;
    const contractAddress = payload?.contractAddress ?? "";
    const contractType = payload?.contractType ?? "unknown";
    const locRaw = payload?.estimatedLOC ?? payload?.loc ?? 0;
    const loc = Number.isFinite(Number(locRaw)) ? Number(locRaw) : 0;

    if (jobId == null) {
      this.log("AUCTION_INVITE ignored: missing payload.jobId");
      return;
    }

    const jobKey = String(jobId);
    if (this.bidSubmittedJobs.has(jobKey)) {
      this.log(`Skipping duplicate AUCTION_INVITE for job ${jobKey}`);
      return;
    }

    const bidAmount = Math.max(5, Math.round((10 + loc * 0.002) * 100) / 100);
    const collateral = Math.round(bidAmount * 0.5 * 100) / 100;
    const estimatedTimeSec = 60;

    try {
      const bidWei = ethers.parseUnits(String(bidAmount), GUARD_DECIMALS);
      const collateralWei = ethers.parseUnits(String(collateral), GUARD_DECIMALS);
      const specialization = this.config.specializations[0] || "any";

      this.log(
        `Submitting bid for job ${jobKey}: bid=${bidAmount} GUARD collateral=${collateral} GUARD`
      );

      const approvalTx = await this.guardToken.approve(this.config.auctionAddress, collateralWei);
      await approvalTx.wait();

      const bidTx = await this.auctionContract.submitBid(
        BigInt(jobKey),
        bidWei,
        collateralWei,
        BigInt(estimatedTimeSec),
        specialization
      );
      await bidTx.wait();

      this.bidSubmittedJobs.add(jobKey);
      this.pendingJobs.set(jobKey, {
        jobId: jobKey,
        contractAddress,
        contractType,
        loc,
      });

      await this._publishAuditLog({
        type: "BID_SUBMITTED",
        agentId: this.agentId,
        timestamp: Date.now(),
        payload: {
          jobId: jobKey,
          contractAddress,
          bidAmount,
          collateral,
          estimatedTimeSec,
          reputation: this.config.reputation,
          evmAddress: this.evmAddress,
        },
      });
    } catch (error) {
      this.log(
        `Bid submission failed for job ${jobKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async handleTaskAssigned(payload) {
    const jobKey = String(payload?.jobId ?? "");
    const pending = this.pendingJobs.get(jobKey);

    if (!pending) {
      this.log(`TASK_ASSIGNED ignored: no pending job found for jobId=${jobKey}`);
      return;
    }

    await this._runAudit(pending);
  }

  async _runAudit(pending) {
    const jobId = String(pending.jobId);
    this.pendingJobs.delete(jobId);
    this.log(`Starting audit for job ${jobId} (${pending.contractType} @ ${pending.contractAddress})`);

    /*
     * REPLACE THIS SECTION with your real audit logic.
     * Example replacements:
     *  - Pull source artifacts and execute static analyzers.
     *  - Run fuzz/property-based tests against deployed bytecode.
     *  - Correlate findings, score severity/confidence, and create canonical output.
     */
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const findingsCount = 3 + Math.floor(Math.random() * 5);
    const criticalCount = Math.floor(Math.random() * 2);
    const findingsHash = ethers.keccak256(
      ethers.toUtf8Bytes(
        JSON.stringify({
          jobId,
          agentId: this.agentId,
          findingsCount,
          ts: Date.now(),
        })
      )
    );

    await this._publishAgentComms({
      type: "FINDINGS_SUBMITTED",
      agentId: this.agentId,
      timestamp: Date.now(),
      payload: {
        jobId,
        findingsHash,
        findingsCount,
        criticalCount,
        evmAddress: this.evmAddress,
      },
    });

    this.log(`Audit completed for job ${jobId}. findingsHash=${findingsHash.slice(0, 14)}...`);
  }

  getStatus() {
    return {
      agentId: this.agentId,
      evmAddress: this.evmAddress ?? null,
      ucpEndpoint: this.config.ucpEndpoint || null,
      specializations: this.config.specializations,
      pendingJobs: this.pendingJobs.size,
      bidSubmittedJobs: this.bidSubmittedJobs.size,
      timestamp: Date.now(),
    };
  }

  async _publish(topicId, message) {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(Buffer.from(JSON.stringify(message)))
      .execute(this.hederaClient);

    await tx.getReceipt(this.hederaClient);
  }

  async _publishAuditLog(msg) {
    await this._publish(this.config.auditLogTopicId, msg);
  }

  async _publishAgentComms(msg) {
    await this._publish(this.config.agentCommsTopicId, msg);
  }

  log(message) {
    console.log(`[${new Date().toISOString()}] [${this.agentId}] ${message}`);
  }

  async shutdown() {
    if (this.subscriptionHandle?.unsubscribe) {
      try {
        await this.subscriptionHandle.unsubscribe();
      } catch (_error) {
        // Intentionally ignored during shutdown path.
      }
    }

    if (this.auctionListener) {
      this.auctionContract.off("WinnersSelected", this.auctionListener);
    }

    if (this.hederaClient?.close) {
      this.hederaClient.close();
    }
  }
}
