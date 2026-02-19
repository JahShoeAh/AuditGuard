import {
  Client,
  TopicMessageSubmitTransaction,
  TopicMessageQuery,
  TopicId,
  AccountId,
  PrivateKey,
} from "@hashgraph/sdk";
import { CONFIG, getOperatorKeys } from "./config.js";

function parsePrivateKey(raw) {
  const key = String(raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  const stripped = key.startsWith("0x") ? key.slice(2) : key;
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    return PrivateKey.fromStringECDSA(stripped);
  }
  return PrivateKey.fromString(key);
}

// Simple HCS wrapper with JSON payloads
export class HCSClient {
  constructor(client) {
    this.client = client ?? HCSClient.buildClient();
  }

  static buildClient() {
    const { accountId, privateKey } = getOperatorKeys();
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(accountId), parsePrivateKey(privateKey));
    return client;
  }

  async publish(topicId, message) {
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message));
    const resp = await tx.execute(this.client);
    await resp.getReceipt(this.client);
  }

  async publishDiscovery(message) {
    return this.publish(CONFIG.hcsTopics.discovery, message);
  }

  async publishAuditLog(message) {
    return this.publish(CONFIG.hcsTopics.auditLog, message);
  }

  async publishAgentComms(message) {
    return this.publish(CONFIG.hcsTopics.agentComms, message);
  }

  subscribe(topicId, handler) {
    new TopicMessageQuery()
      .setTopicId(TopicId.fromString(topicId))
      .subscribe(this.client, null, (msg) => {
        try {
          const parsed = JSON.parse(Buffer.from(msg.contents).toString("utf-8"));
          handler(parsed);
        } catch (err) {
          console.error("Failed to parse HCS message", err);
        }
      });
  }

  subscribeDiscovery(handler) {
    this.subscribe(CONFIG.hcsTopics.discovery, handler);
  }

  subscribeAuditLog(handler) {
    this.subscribe(CONFIG.hcsTopics.auditLog, handler);
  }

  subscribeAgentComms(handler) {
    this.subscribe(CONFIG.hcsTopics.agentComms, handler);
  }
}
