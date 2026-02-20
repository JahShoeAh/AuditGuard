/**
 * HCS (Hedera Consensus Service) Client — pub/sub messaging for all agents.
 *
 * Supports two construction modes:
 *   1. From an existing Hedera Client (from wallet.ts) — preferred
 *   2. From agent name (resolves credentials from env) — legacy/convenience
 */

import {
  Client,
  TopicMessageSubmitTransaction,
  TopicMessageQuery,
  TopicId,
  AccountId,
  PrivateKey,
} from "@hashgraph/sdk";
import { CONFIG, getAgentEnv } from "./config.js";
import type { HCSMessage } from "./types.js";

export class HCSClient {
  private client: Client;
  private readonly subscribeLookbackMs: number;

  /**
   * Create an HCS client from a pre-configured Hedera Client (from wallet.ts).
   */
  constructor(client: Client);
  /**
   * Create an HCS client from an agent name (resolves credentials from env).
   */
  constructor(agentName: string);
  constructor(clientOrName: Client | string) {
    if (typeof clientOrName === "string") {
      // Legacy: construct from agent name
      const { accountId, privateKey } = getAgentEnv(clientOrName);
      this.client = Client.forTestnet();
      // Try ECDSA first (most common for EVM-compatible keys), fall back to ED25519
      const stripped = privateKey.trim().replace(/^['"]|['"]$/g, "");
      const rawKey = stripped.startsWith("0x") ? stripped.slice(2) : stripped;
      let key: PrivateKey;
      if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
        key = PrivateKey.fromStringECDSA(rawKey);
      } else {
        key = PrivateKey.fromString(stripped);
      }
      this.client.setOperator(AccountId.fromString(accountId), key);
    } else {
      // Preferred: use existing client from wallet
      this.client = clientOrName;
    }
    const lookbackSecRaw = Number(process.env.HCS_SUBSCRIBE_LOOKBACK_SECONDS ?? "15");
    const lookbackSec = Number.isFinite(lookbackSecRaw) ? Math.max(0, lookbackSecRaw) : 15;
    this.subscribeLookbackMs = Math.floor(lookbackSec * 1000);
  }

  // ─── Publish ─────────────────────────────────────────────────────────────

  async publish(topicId: string, message: HCSMessage): Promise<void> {
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message));

    const response = await tx.execute(this.client);
    await response.getReceipt(this.client);
  }

  async publishDiscovery(message: HCSMessage): Promise<void> {
    return this.publish(CONFIG.hcsTopics.discovery, message);
  }

  async publishAuditLog(message: HCSMessage): Promise<void> {
    return this.publish(CONFIG.hcsTopics.auditLog, message);
  }

  async publishAgentComms(message: HCSMessage): Promise<void> {
    return this.publish(CONFIG.hcsTopics.agentComms, message);
  }

  // ─── Subscribe ───────────────────────────────────────────────────────────

  subscribe(topicId: string, callback: (msg: HCSMessage) => void): void {
    const query = new TopicMessageQuery()
      .setTopicId(TopicId.fromString(topicId));

    if (this.subscribeLookbackMs > 0) {
      query.setStartTime(new Date(Date.now() - this.subscribeLookbackMs));
    }

    query.subscribe(this.client, null, (topicMessage) => {
        try {
          const raw = Buffer.from(topicMessage.contents).toString("utf-8");
          const parsed: HCSMessage = JSON.parse(raw);
          callback(parsed);
        } catch (err) {
          // Ignore malformed messages
          console.error("Failed to parse HCS message:", err);
        }
      });
  }

  subscribeDiscovery(callback: (msg: HCSMessage) => void): void {
    this.subscribe(CONFIG.hcsTopics.discovery, callback);
  }

  subscribeAuditLog(callback: (msg: HCSMessage) => void): void {
    this.subscribe(CONFIG.hcsTopics.auditLog, callback);
  }

  subscribeAgentComms(callback: (msg: HCSMessage) => void): void {
    this.subscribe(CONFIG.hcsTopics.agentComms, callback);
  }

  getClient(): Client {
    return this.client;
  }
}
