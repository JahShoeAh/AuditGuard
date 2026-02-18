import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { CONFIG } from "../shared/config.js";

// ─── Error Types ────────────────────────────────────────────────────────────

export type ZGErrorCode = "TIMEOUT" | "HTTP_ERROR" | "EMPTY_RESPONSE" | "NOT_INITIALIZED";

export class ZGClientError extends Error {
  code: ZGErrorCode;
  constructor(code: ZGErrorCode, message: string) {
    super(message);
    this.name = "ZGClientError";
    this.code = code;
  }
}

// ─── Request / Response Types (OpenAI-compatible, unchanged) ────────────────

export interface ZGInferenceRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  max_tokens: number;
}

export interface ZGInferenceResponse {
  choices: { message: { content: string } }[];
}

// ─── Broker Singleton ───────────────────────────────────────────────────────

let brokerInstance: Awaited<ReturnType<typeof createZGComputeNetworkBroker>> | null = null;
let brokerInitialized = false;

async function getBroker() {
  if (brokerInstance) return brokerInstance;

  const cfg = (CONFIG as any).zgInference;
  const privateKey = process.env.ZG_PRIVATE_KEY;
  const rpcUrl = cfg?.rpcUrl || process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";

  if (!privateKey) {
    throw new ZGClientError("NOT_INITIALIZED", "ZG_PRIVATE_KEY not configured");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    provider
  );

  brokerInstance = await createZGComputeNetworkBroker(wallet);
  return brokerInstance;
}

/**
 * One-time setup: deposit funds and acknowledge the provider.
 * Called at agent startup. Failures are non-fatal (funds may already exist).
 */
export async function initZgClient(): Promise<void> {
  if (brokerInitialized) return;

  const cfg = (CONFIG as any).zgInference;
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS || cfg?.providerAddress || "";

  try {
    const broker = await getBroker();

    const depositAmount = cfg?.depositAmount ?? Number(process.env.ZG_DEPOSIT_AMOUNT ?? "5");
    try {
      await broker.ledger.depositFund(depositAmount);
    } catch (err: any) {
      // Likely already deposited — not fatal
      const msg = err?.message ?? String(err);
      if (!msg.includes("already") && !msg.includes("insufficient")) {
        console.warn(`[0g-client] depositFund warning: ${msg}`);
      }
    }

    if (providerAddress) {
      try {
        await broker.inference.acknowledgeProviderSigner(providerAddress);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (!msg.includes("already")) {
          console.warn(`[0g-client] acknowledgeProvider warning: ${msg}`);
        }
      }
    }

    brokerInitialized = true;
  } catch (err: any) {
    console.warn(`[0g-client] Broker initialization failed: ${err?.message ?? err}`);
  }
}

// ─── Inference Call ─────────────────────────────────────────────────────────

export async function callInference(
  req: ZGInferenceRequest,
  opts?: { timeoutMs?: number }
): Promise<string> {
  const cfg = (CONFIG as any).zgInference;
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS ?? "";
  const timeoutMs = opts?.timeoutMs ?? cfg?.timeoutMs ?? 30000;

  if (!providerAddress) {
    throw new ZGClientError("NOT_INITIALIZED", "ZG_PROVIDER_ADDRESS not configured");
  }

  const broker = await getBroker();

  let endpoint: string;
  let model: string;
  try {
    const metadata = await broker.inference.getServiceMetadata(providerAddress);
    endpoint = (metadata as any).endpoint ?? (metadata as any).url ?? "";
    model = (metadata as any).model ?? req.model;
  } catch {
    throw new ZGClientError("HTTP_ERROR", "Failed to get service metadata from 0g broker");
  }

  if (!endpoint) {
    throw new ZGClientError("HTTP_ERROR", "0g broker returned no endpoint for provider");
  }

  let headers: Record<string, string>;
  try {
    headers = await broker.inference.getRequestHeaders(providerAddress) as any;
  } catch {
    throw new ZGClientError("HTTP_ERROR", "Failed to get request headers from 0g broker");
  }

  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ZGClientError(
        "HTTP_ERROR",
        `0g provider returned ${response.status}: ${await response.text().catch(() => "")}`
      );
    }

    const data: ZGInferenceResponse = await response.json();

    if (!data.choices?.length || !data.choices[0]?.message?.content) {
      throw new ZGClientError("EMPTY_RESPONSE", "0g provider returned no choices");
    }

    return data.choices[0].message.content;
  } catch (err: any) {
    if (err instanceof ZGClientError) throw err;
    if (err?.name === "AbortError") {
      throw new ZGClientError("TIMEOUT", `0g inference timed out after ${timeoutMs}ms`);
    }
    throw new ZGClientError("HTTP_ERROR", `0g inference request failed: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Reset broker state (used in tests). */
export function _resetBroker(): void {
  brokerInstance = null;
  brokerInitialized = false;
}
