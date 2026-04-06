import { ethers } from "ethers";
import type { RiskPromptContext, LLMRiskResponse } from "./risk-prompt.js";
import { buildRiskMessages, parseRiskResponse } from "./risk-prompt.js";

export interface RiskInferenceResult {
  risk: LLMRiskResponse;
  source: "0g" | "claude";
  model: string;
  latencyMs: number;
}

let broker: any = null;
let brokerReady = false;
let zgHealthy = !!(process.env.ZG_PRIVATE_KEY?.trim() && process.env.ZG_PROVIDER_ADDRESS?.trim());
let healthCheckTimer: NodeJS.Timeout | null = null;

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
  return (process.env.ZG_MODEL ?? "qwen-2.5-7b-instruct").trim();
}

function getZgTimeoutMs(): number {
  return Number(process.env.ZG_RISK_TIMEOUT_MS ?? 30_000);
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

async function callZgInference(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  if (!broker || !brokerReady) throw new Error("0g broker not ready");

  const providerAddress = getZgProviderAddress();
  const { endpoint, model: metaModel } =
    await broker.inference.getServiceMetadata(providerAddress);

  const model = getZgModel() || metaModel;
  const content = messages.map((m) => m.content).join("\n");
  const headers = await broker.inference.getRequestHeaders(
    providerAddress,
    content
  );

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getZgTimeoutMs());

  try {
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

    return responseContent;
  } finally {
    clearTimeout(timeout);
  }
}

async function callClaudeInference(
  messages: { role: "system" | "user"; content: string }[]
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
    model: process.env.CLAUDE_RISK_MODEL ?? "claude-sonnet-4-20250514",
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
            model,
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
        const raw = await callZgInference(messages);
        const risk = parseRiskResponse(raw);

        if (risk) {
          return {
            risk,
            source: "0g",
            model: getZgModel(),
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
    const raw = await callClaudeInference(messages);
    const risk = parseRiskResponse(raw);

    if (!risk) {
      throw new Error("Claude returned unparseable risk response");
    }

    return {
      risk,
      source: "claude",
      model: process.env.CLAUDE_RISK_MODEL ?? "claude-sonnet-4-20250514",
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
  stopZgHealthCheckLoop();
}
