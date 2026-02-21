import { ethers } from "ethers";
import type { RiskPromptContext, LLMRiskResponse } from "./risk-prompt.js";
import { buildRiskMessages, parseRiskResponse } from "./risk-prompt.js";

export interface RiskInferenceResult {
  risk: LLMRiskResponse;
  source: "0g" | "claude";
  model: string;
  latencyMs: number;
}

interface ZgInferenceCallResult {
  content: string;
  model: string;
}

let broker: any = null;
let brokerReady = false;
let zgHealthy = true;
let healthCheckTimer: NodeJS.Timeout | null = null;
let loggedModelOverride = false;
let loggedClaudeHaikuOverride = false;

const CANONICAL_MODEL_ALIASES: Record<string, string> = {
  "qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
  "qwen/qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
};

function canonicalizeModelId(model: string): string {
  const raw = String(model ?? "").trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  return CANONICAL_MODEL_ALIASES[normalized] ?? raw;
}

function modelsEquivalent(a: string, b: string): boolean {
  const aa = canonicalizeModelId(a).toLowerCase();
  const bb = canonicalizeModelId(b).toLowerCase();
  return aa.length > 0 && aa === bb;
}

function extractSupportedModelFromHttpError(body: string): string | null {
  const singleQuoted = /only\s+'([^']+)'/i.exec(body);
  if (singleQuoted?.[1]) return canonicalizeModelId(singleQuoted[1]);
  const doubleQuoted = /only\s+"([^"]+)"/i.exec(body);
  if (doubleQuoted?.[1]) return canonicalizeModelId(doubleQuoted[1]);
  return null;
}

function getZgPrivateKey(): string {
  return (process.env.ZG_PRIVATE_KEY ?? "").trim();
}

export function getZgProviderAddress(): string {
  return (process.env.ZG_PROVIDER_ADDRESS ?? "").trim();
}

export function getZgRpcUrl(): string {
  return (process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai").trim();
}

export function getZgModel(): string {
  return canonicalizeModelId(process.env.ZG_MODEL ?? "qwen/qwen-2.5-7b-instruct");
}

function getZgTimeoutMs(): number {
  return Number(process.env.ZG_RISK_TIMEOUT_MS ?? 30_000);
}

function resolveClaudeHaikuModel(log?: { warn: (msg: string) => void }): string {
  const fallback = "claude-haiku-4-5-20251001";
  const configured = String(
    process.env.CLAUDE_HAIKU_MODEL ??
    process.env.CLAUDE_RISK_MODEL ??
    fallback
  ).trim();
  const normalized = configured.toLowerCase();
  const retiredHaikuModels = new Set([
    "claude-3-5-haiku-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-haiku-20240307",
  ]);
  if (retiredHaikuModels.has(normalized)) {
    if (!loggedClaudeHaikuOverride && log) {
      log.warn(
        `Claude model override: configured '${configured}' is retired. ` +
        `Forcing '${fallback}'.`
      );
      loggedClaudeHaikuOverride = true;
    }
    return fallback;
  }
  if (normalized.includes("haiku")) return configured;

  if (!loggedClaudeHaikuOverride && log) {
    log.warn(
      `Claude model override: configured '${configured}' is not Haiku. ` +
      `Forcing '${fallback}' for lower-cost inference.`
    );
    loggedClaudeHaikuOverride = true;
  }
  return fallback;
}

async function initZgBroker(): Promise<void> {
  if (broker) return;

  const privateKey = getZgPrivateKey();
  const rpcUrl = getZgRpcUrl();
  if (!privateKey || !getZgProviderAddress()) {
    zgHealthy = false;
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
      provider
    );
    const { createZGComputeNetworkBroker } = await import(
      "@0glabs/0g-serving-broker"
    );
    broker = await createZGComputeNetworkBroker(wallet);

    try {
      const ledger = await broker.ledger.getLedger();
      if (BigInt(ledger?.availableBalance ?? 0n) <= 0n) {
        await broker.ledger.depositFund(5);
      }
    } catch {
      await broker.ledger.depositFund(5);
    }

    await broker.inference.acknowledgeProviderSigner(getZgProviderAddress());
    brokerReady = true;
    zgHealthy = true;
  } catch {
    zgHealthy = false;
  }
}

function resolveRiskInferenceModel(metaModelRaw: string, log?: { warn: (msg: string) => void }): string {
  const providerModel = canonicalizeModelId(metaModelRaw);
  const configuredModel = canonicalizeModelId(getZgModel());
  if (!providerModel) return configuredModel;
  if (!configuredModel) return providerModel;
  if (modelsEquivalent(configuredModel, providerModel)) {
    return providerModel;
  }
  if (!loggedModelOverride && log) {
    log.warn(
      `0g model override: configured '${configuredModel}' mismatches provider '${providerModel}'. ` +
      "Using provider model to avoid invalid-model throttling."
    );
    loggedModelOverride = true;
  }
  return providerModel;
}

async function callZgInference(
  messages: { role: "system" | "user"; content: string }[],
  log?: { warn: (msg: string) => void }
): Promise<ZgInferenceCallResult> {
  if (!broker || !brokerReady) throw new Error("0g broker not ready");

  const providerAddress = getZgProviderAddress();
  const { endpoint, model: metaModel } =
    await broker.inference.getServiceMetadata(providerAddress);

  let model = resolveRiskInferenceModel(metaModel, log);
  const content = messages.map((m) => m.content).join("\n");
  const headers = await broker.inference.getRequestHeaders(
    providerAddress,
    content
  );

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getZgTimeoutMs());

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const hintedModel =
          res.status === 400 ? extractSupportedModelFromHttpError(body) : null;
        if (attempt === 1 && hintedModel && !modelsEquivalent(model, hintedModel)) {
          model = hintedModel;
          continue;
        }
        throw new Error(`0g returned ${res.status}: ${body.slice(0, 200)}`);
      }

      const data: any = await res.json();
      const responseContent = data?.choices?.[0]?.message?.content;
      if (!responseContent) throw new Error("0g returned empty content");

      const chatId =
        res.headers.get("ZG-Res-Key") || res.headers.get("zg-res-key");
      if (data.usage) {
        await broker.inference
          .processResponse(providerAddress, chatId, JSON.stringify(data.usage))
          .catch(() => {});
      }

      return {
        content: responseContent,
        model,
      };
    }
    throw new Error("0g model retry exhausted");
  } finally {
    clearTimeout(timeout);
  }
}

async function callClaudeInference(
  messages: { role: "system" | "user"; content: string }[],
  log?: { warn: (msg: string) => void }
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsgs = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ role: "user" as const, content: m.content }));

  const response = await client.messages.create({
    model: resolveClaudeHaikuModel(log),
    max_tokens: 1024,
    system: systemMsg,
    messages: userMsgs,
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text;
}

export function startZgHealthCheckLoop(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): void {
  if (healthCheckTimer) return;

  const HEALTH_CHECK_INTERVAL_MS = Number(
    process.env.ZG_HEALTH_CHECK_INTERVAL_MS ?? 30_000
  );

  healthCheckTimer = setInterval(async () => {
    if (zgHealthy) return;

    log.info("0g health check: attempting reconnection...");

    try {
      broker = null;
      brokerReady = false;
      await initZgBroker();

      if (!brokerReady) {
        log.warn("0g health check: broker init failed, staying on Claude fallback");
        return;
      }

      const providerAddress = getZgProviderAddress();
      const { endpoint, model } =
        await broker.inference.getServiceMetadata(providerAddress);
      const headers = await broker.inference.getRequestHeaders(
        providerAddress,
        "health-check"
      );

      const url = endpoint.replace(/\/$/, "") + "/chat/completions";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({
            model: resolveRiskInferenceModel(model, log),
            messages: [{ role: "user", content: "health-check" }],
            temperature: 0,
            max_tokens: 16,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          zgHealthy = true;
          log.info("0g health check: connection restored, switching back to 0g inference");
        } else {
          log.warn(`0g health check: provider returned ${res.status}, staying on Claude`);
        }
      } catch {
        clearTimeout(timeout);
        log.warn("0g health check: probe failed, staying on Claude fallback");
      }
    } catch (err) {
      log.warn(`0g health check: reconnection failed: ${err}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

export function stopZgHealthCheckLoop(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export async function assessRisk(
  ctx: RiskPromptContext,
  log: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<RiskInferenceResult> {
  const messages = buildRiskMessages(ctx);
  const start = Date.now();

  if (zgHealthy) {
    try {
      await initZgBroker();

      if (brokerReady) {
        const inference = await callZgInference(messages, log);
        const risk = parseRiskResponse(inference.content);

        if (risk) {
          return {
            risk,
            source: "0g",
            model: inference.model,
            latencyMs: Date.now() - start,
          };
        }
        log.warn("0g inference returned unparseable risk response, falling back to Claude");
      }
    } catch (err) {
      zgHealthy = false;
      log.warn(`0g inference failed, switching to Claude fallback: ${err}`);
    }
  }

  try {
    const raw = await callClaudeInference(messages, log);
    const risk = parseRiskResponse(raw);

    if (!risk) {
      throw new Error("Claude returned unparseable risk response");
    }

    return {
      risk,
      source: "claude",
      model: resolveClaudeHaikuModel(log),
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    throw new Error(`Both 0g and Claude inference failed. Claude error: ${err}`);
  }
}

export function getCurrentInferenceSource(): "0g" | "claude" {
  return zgHealthy ? "0g" : "claude";
}

export function _resetRiskInference(): void {
  broker = null;
  brokerReady = false;
  zgHealthy = true;
  loggedModelOverride = false;
  loggedClaudeHaikuOverride = false;
  stopZgHealthCheckLoop();
}
