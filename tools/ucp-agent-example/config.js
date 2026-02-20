import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONOREPO_ENV_PATH = path.resolve(__dirname, "../../.env");
const LOCAL_ENV_PATH = path.resolve(__dirname, ".env");
const SDK_CONFIG_PATH = path.resolve(__dirname, "../../packages/sdk/config.json");

dotenv.config({ path: MONOREPO_ENV_PATH });
dotenv.config({ path: LOCAL_ENV_PATH });

function toBool(value, defaultValue = false) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toNumber(value, defaultValue) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return parsed;
}

function normalizeSpecializations(value) {
  if (!value || String(value).trim() === "") {
    return ["any"];
  }

  const entries = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : ["any"];
}

function loadSdkConfig() {
  try {
    const raw = readFileSync(SDK_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to read SDK config at ${SDK_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function loadConfig() {
  const accountId = process.env.UCP_AGENT_ACCOUNT_ID?.trim();
  const privateKeyInput = process.env.UCP_AGENT_PRIVATE_KEY?.trim();

  if (!accountId) {
    throw new Error(
      "Missing UCP_AGENT_ACCOUNT_ID. Set it in tools/ucp-agent-example/.env (or root .env) to your Hedera account ID (e.g. 0.0.123456)."
    );
  }

  if (!privateKeyInput) {
    throw new Error(
      "Missing UCP_AGENT_PRIVATE_KEY. Set it in tools/ucp-agent-example/.env (or root .env) to your ECDSA private key hex."
    );
  }

  const sdkConfig = loadSdkConfig();
  const privateKey = privateKeyInput.replace(/^0x/i, "");

  return {
    agentId: process.env.UCP_AGENT_ID?.trim() || "ucp-example-001",
    accountId,
    privateKey,
    port: toNumber(process.env.UCP_AGENT_PORT, 3737),
    ucpEndpoint: process.env.UCP_AGENT_ENDPOINT?.trim() || "",
    stakeGuard: toNumber(process.env.UCP_AGENT_STAKE_GUARD, 100),
    reputation: toNumber(process.env.UCP_AGENT_REPUTATION, 1000),
    specializations: normalizeSpecializations(process.env.UCP_AGENT_SPECIALIZATIONS),
    skipOnChainRegister: toBool(process.env.UCP_SKIP_ONCHAIN_REGISTER, false),
    agentCommsTopicId:
      process.env.UCP_AGENT_COMMS_TOPIC_ID?.trim() || sdkConfig?.hcsTopics?.agentComms || "",
    auditLogTopicId:
      process.env.UCP_AUDIT_LOG_TOPIC_ID?.trim() || sdkConfig?.hcsTopics?.auditLog || "",
    auctionAddress:
      process.env.UCP_AUCTION_ADDRESS?.trim() ||
      sdkConfig?.contracts?.auctionContract?.evmAddress ||
      "",
    agentRegistryAddress:
      process.env.UCP_AGENT_REGISTRY_ADDRESS?.trim() ||
      sdkConfig?.contracts?.agentRegistry?.evmAddress ||
      "",
    guardTokenAddress:
      process.env.UCP_GUARD_TOKEN_ADDRESS?.trim() || sdkConfig?.guardTokenEvmAddress || "",
  };
}
