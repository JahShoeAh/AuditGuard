const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const ROOT_ENV_PATH = path.join(__dirname, "..", ".env");
const AGENTS_ENV_PATH = path.join(__dirname, "..", "agents", ".env");

const LEGACY_CREDENTIAL_KEYS = new Set([
  "HEDERA_ACCOUNT_ID",
  "HEDERA_PRIVATE_KEY",
  "HEDERA_PRIVATE_KEY_TYPE",
  "OPERATOR_ACCOUNT_ID",
  "OPERATOR_PRIVATE_KEY",
  "OPERATOR_PRIVATE_KEY_TYPE",
  "ORCHESTRATOR_ACCOUNT_ID",
  "ORCHESTRATOR_PRIVATE_KEY",
  "ORCHESTRATOR_PRIVATE_KEY_TYPE",
  "AGENT_REGISTRY_OWNER_ACCOUNT_ID",
  "AGENT_REGISTRY_OWNER_PRIVATE_KEY",
]);

function isCredentialKey(key) {
  if (!key) return false;
  if (LEGACY_CREDENTIAL_KEYS.has(key)) return true;
  return (
    key.endsWith("_ACCOUNT_ID") ||
    key.endsWith("_PRIVATE_KEY") ||
    key.endsWith("_PRIVATE_KEY_TYPE")
  );
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  return dotenv.parse(raw);
}

function applyRootEnv(rootValues, keySources) {
  for (const [key, value] of Object.entries(rootValues)) {
    if (process.env[key] == null) {
      process.env[key] = value;
      if (!keySources[key]) keySources[key] = "root";
    } else if (!keySources[key]) {
      keySources[key] = "process";
    }
  }
}

function applyAgentEnv(agentValues, keySources, opts) {
  const ignoredCredentialKeys = [];
  const appliedKeys = [];
  const allowCredentialOverrides = opts.allowAgentCredentialOverrides === true;
  for (const [key, value] of Object.entries(agentValues)) {
    if (!allowCredentialOverrides && isCredentialKey(key)) {
      ignoredCredentialKeys.push(key);
      continue;
    }
    process.env[key] = value;
    keySources[key] = "agents";
    appliedKeys.push(key);
  }
  return { ignoredCredentialKeys, appliedKeys };
}

function normalizeEnvValue(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function findCredentialConflicts(rootValues, agentValues) {
  const conflicts = [];
  const keys = new Set([...Object.keys(rootValues), ...Object.keys(agentValues)]);
  for (const key of keys) {
    if (!isCredentialKey(key)) continue;
    if (!(key in rootValues) || !(key in agentValues)) continue;
    const rootValue = normalizeEnvValue(rootValues[key]);
    const agentValue = normalizeEnvValue(agentValues[key]);
    if (rootValue !== agentValue) {
      conflicts.push({
        key,
        rootValue,
        agentValue,
      });
    }
  }
  return conflicts;
}

function loadRuntimeEnv(options = {}) {
  const opts = {
    allowAgentCredentialOverrides:
      String(process.env.ALLOW_AGENT_ENV_CREDENTIAL_OVERRIDE || "").toLowerCase() === "true",
    ...options,
  };

  const rootValues = parseEnvFile(ROOT_ENV_PATH);
  const agentValues = parseEnvFile(AGENTS_ENV_PATH);
  const keySources = {};

  applyRootEnv(rootValues, keySources);
  const { ignoredCredentialKeys, appliedKeys } = applyAgentEnv(agentValues, keySources, opts);
  const credentialConflicts = findCredentialConflicts(rootValues, agentValues);

  return {
    rootPath: ROOT_ENV_PATH,
    agentsPath: AGENTS_ENV_PATH,
    rootValues,
    agentValues,
    keySources,
    ignoredCredentialKeys,
    appliedKeys,
    credentialConflicts,
    allowAgentCredentialOverrides: opts.allowAgentCredentialOverrides,
  };
}

function summarizeCredentialConflict(conflict) {
  const mask = (v) => {
    if (!v) return "<empty>";
    if (v.length <= 10) return v;
    return `${v.slice(0, 6)}...${v.slice(-4)}`;
  };
  return `${conflict.key}: root(${mask(conflict.rootValue)}) != agents(${mask(conflict.agentValue)})`;
}

module.exports = {
  ROOT_ENV_PATH,
  AGENTS_ENV_PATH,
  isCredentialKey,
  loadRuntimeEnv,
  summarizeCredentialConflict,
};

