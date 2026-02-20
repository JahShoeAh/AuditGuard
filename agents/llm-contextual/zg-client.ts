import { ethers } from "ethers";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { CONFIG } from "../shared/config.js";

export type ZGReasonCode =
  | "zg_not_configured"
  | "missing_runtime_dependency"
  | "zg_broker_module_interop_error"
  | "zg_broker_init_failed"
  | "zg_ledger_unfunded"
  | "zg_provider_ack_failed"
  | "zg_provider_metadata_failed"
  | "zg_request_headers_failed"
  | "zg_model_mismatch"
  | "zg_model_auto_corrected"
  | "zg_timeout"
  | "zg_http_error"
  | "zg_response_invalid";

export class ZGClientError extends Error {
  code: ZGReasonCode;
  stage: string;

  constructor(code: ZGReasonCode, message: string, stage = "unknown") {
    super(message);
    this.name = "ZGClientError";
    this.code = code;
    this.stage = stage;
  }
}

export interface ZGInferenceRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  max_tokens: number;
}

export interface ZGInferenceResponse {
  id?: string;
  choices?: { message?: { content?: string } }[];
  usage?: Record<string, unknown>;
}

export interface ZGReadinessReport {
  providerAddress: string;
  endpoint: string;
  model: string;
  requestId?: string;
}

export interface ZGInferenceResult {
  content: string;
  providerAddress: string;
  endpoint: string;
  model: string;
  requestId?: string;
  verified: boolean;
  requestedModel?: string;
  providerModel?: string;
  modelSource?: string;
  modelAutoCorrected?: boolean;
}

let brokerInstance: any = null;
let brokerInitialized = false;
let readinessCache: ZGReadinessReport | null = null;
const localRequire = createRequire(fileURLToPath(import.meta.url));

function getZgConfig() {
  return (CONFIG as any).zgInference ?? {};
}

function normalizeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingDependencyError(err: unknown, packageName: string): boolean {
  const message = normalizeErrorMessage(err).toLowerCase();
  return message.includes(`cannot find package '${packageName.toLowerCase()}'`)
    || message.includes(`cannot find module '${packageName.toLowerCase()}'`);
}

function isInteropNamedExportError(err: unknown): boolean {
  const message = normalizeErrorMessage(err).toLowerCase();
  return message.includes("does not provide an export named");
}

type BrokerFactory = (wallet: ethers.Wallet) => Promise<any>;

function validateBrokerFactory(factory: unknown, stage: string): BrokerFactory {
  if (typeof factory !== "function") {
    throw new ZGClientError(
      "zg_broker_module_interop_error",
      "0g broker module loaded but createZGComputeNetworkBroker export is missing",
      stage
    );
  }
  return factory as BrokerFactory;
}

async function loadBrokerFactory(): Promise<BrokerFactory> {
  const loaderMode = String(process.env.ZG_BROKER_LOADER_MODE ?? "auto").toLowerCase();
  if (loaderMode === "esm_only") {
    const esmModule = await import("@0glabs/0g-serving-broker");
    return validateBrokerFactory((esmModule as any).createZGComputeNetworkBroker, "broker_loader_esm_only");
  }

  try {
    const esmModule = await import("@0glabs/0g-serving-broker");
    return validateBrokerFactory((esmModule as any).createZGComputeNetworkBroker, "broker_loader_esm");
  } catch (err) {
    if (isMissingDependencyError(err, "@0glabs/0g-serving-broker")) {
      throw err;
    }
    if (!isInteropNamedExportError(err)) {
      throw err;
    }
    const cjsModule = localRequire("@0glabs/0g-serving-broker");
    return validateBrokerFactory(cjsModule?.createZGComputeNetworkBroker, "broker_loader_cjs");
  }
}

function resolveProviderAddress(): string {
  const cfg = getZgConfig();
  return (process.env.ZG_PROVIDER_ADDRESS ?? cfg.providerAddress ?? "").trim();
}

function resolveRpcUrl(): string {
  const cfg = getZgConfig();
  return (cfg.rpcUrl ?? process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai").trim();
}

function resolveRequestTimeoutMs(): number {
  const cfg = getZgConfig();
  return Number(cfg.requestTimeoutMs ?? cfg.timeoutMs ?? process.env.ZG_TIMEOUT_MS ?? 30000);
}

function resolveHealthcheckTimeoutMs(): number {
  const cfg = getZgConfig();
  return Number(cfg.healthcheckTimeoutMs ?? process.env.ZG_HEALTHCHECK_TIMEOUT_MS ?? 15000);
}

function resolveInitRetries(): number {
  const cfg = getZgConfig();
  return Math.max(1, Number(cfg.maxInitRetries ?? process.env.ZG_MAX_INIT_RETRIES ?? 2));
}

type ProviderMode = "pinned" | "auto" | "hybrid";

const CANONICAL_MODEL_ALIASES: Record<string, string> = {
  "qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
  "qwen/qwen-2.5-7b-instruct": "qwen/qwen-2.5-7b-instruct",
};

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

export function canonicalizeModelId(model: string): string {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return "";
  const normalized = normalizeModelKey(trimmed);
  return CANONICAL_MODEL_ALIASES[normalized] ?? trimmed;
}

export function modelsEquivalent(a: string, b: string): boolean {
  const aa = canonicalizeModelId(a);
  const bb = canonicalizeModelId(b);
  if (!aa || !bb) return false;
  return normalizeModelKey(aa) === normalizeModelKey(bb);
}

function resolveProviderMode(): ProviderMode {
  const cfg = getZgConfig();
  const raw = String(process.env.ZG_PROVIDER_MODE ?? cfg.providerMode ?? "pinned").trim().toLowerCase();
  if (raw === "auto" || raw === "hybrid") return raw;
  return "pinned";
}

export function resolveInferenceModel(input: {
  requestedModel?: string;
  providerModel: string;
  providerMode?: ProviderMode;
}): { model: string; source: "requested" | "provider_auto" | "provider_hybrid" | "provider_default"; corrected: boolean } {
  const providerModel = canonicalizeModelId(input.providerModel);
  const requestedModelRaw = String(input.requestedModel ?? "");
  const requestedModel = canonicalizeModelId(requestedModelRaw);
  const mode = input.providerMode ?? resolveProviderMode();

  if (!providerModel) {
    throw new ZGClientError("zg_provider_metadata_failed", "Provider metadata did not include a model", "infer_model_resolve");
  }

  if (mode === "auto") {
    return {
      model: providerModel,
      source: "provider_auto",
      corrected: requestedModel.length > 0 && !modelsEquivalent(requestedModel, providerModel),
    };
  }

  if (!requestedModel) {
    return { model: providerModel, source: "provider_default", corrected: false };
  }

  if (modelsEquivalent(requestedModel, providerModel)) {
    return {
      model: providerModel,
      source: "requested",
      corrected: normalizeModelKey(requestedModelRaw) !== normalizeModelKey(providerModel),
    };
  }

  if (mode === "hybrid") {
    return { model: providerModel, source: "provider_hybrid", corrected: true };
  }

  throw new ZGClientError(
    "zg_model_mismatch",
    `Configured model '${requestedModelRaw || requestedModel}' is not supported by provider; provider exposes '${providerModel}'`,
    "infer_model_resolve"
  );
}

function isTimeoutError(err: unknown): boolean {
  const message = normalizeErrorMessage(err).toLowerCase();
  return message.includes("timed out") || message.includes("timeout") || message.includes("abort");
}

function withAbortTimeout(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reasonCode: ZGReasonCode,
  stage: string,
  timeoutLabel: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ZGClientError(reasonCode, `${timeoutLabel} timed out after ${timeoutMs}ms`, stage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asZgError(err: unknown, fallbackCode: ZGReasonCode, stage: string): ZGClientError {
  if (err instanceof ZGClientError) return err;
  if (isMissingDependencyError(err, "@0glabs/0g-serving-broker")) {
    return new ZGClientError(
      "missing_runtime_dependency",
      "Missing runtime dependency '@0glabs/0g-serving-broker'. Run `npm --workspace agents install`.",
      stage
    );
  }
  if (isTimeoutError(err)) {
    return new ZGClientError("zg_timeout", normalizeErrorMessage(err), stage);
  }
  return new ZGClientError(fallbackCode, normalizeErrorMessage(err), stage);
}

function extractContentForBilling(messages: { role: "system" | "user"; content: string }[]): string {
  return messages.map((m) => m.content ?? "").join("\n");
}

function buildCompletionUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function parseJsonResponse(raw: string, stage: string): ZGInferenceResponse {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ZGClientError("zg_response_invalid", "Provider returned non-JSON response", stage);
  }
}

async function readResponseBody(response: Response): Promise<string> {
  const maybe = response as unknown as { text?: () => Promise<string>; json?: () => Promise<unknown> };
  if (typeof maybe.text === "function") {
    return maybe.text();
  }
  if (typeof maybe.json === "function") {
    const payload = await maybe.json();
    return JSON.stringify(payload ?? {});
  }
  return "";
}

function extractRequestId(response: Response, payload?: ZGInferenceResponse): string | undefined {
  const headers = (response as unknown as { headers?: { get?: (name: string) => string | null } }).headers;
  const getHeader = typeof headers?.get === "function" ? headers.get.bind(headers) : () => null;
  return (
    getHeader("ZG-Res-Key") ||
    getHeader("zg-res-key") ||
    getHeader("x-request-id") ||
    payload?.id ||
    undefined
  );
}

function usagePayload(payload?: ZGInferenceResponse): string | undefined {
  if (!payload || !payload.usage) return undefined;
  try {
    return JSON.stringify(payload.usage);
  } catch {
    return undefined;
  }
}

function extractSupportedModelFromHttpError(body: string): string | null {
  if (!body) return null;
  const singleQuoted = body.match(/only\s+'([^']+)'\s+is available/i);
  if (singleQuoted?.[1]) return canonicalizeModelId(singleQuoted[1]);
  const doubleQuoted = body.match(/only\s+"([^"]+)"\s+is available/i);
  if (doubleQuoted?.[1]) return canonicalizeModelId(doubleQuoted[1]);
  return null;
}

function ensureConfigured(): { privateKey: string; providerAddress: string; rpcUrl: string } {
  const privateKey = (process.env.ZG_PRIVATE_KEY ?? "").trim();
  const providerAddress = resolveProviderAddress();
  const rpcUrl = resolveRpcUrl();

  if (!privateKey) {
    throw new ZGClientError("zg_not_configured", "ZG_PRIVATE_KEY not configured", "config");
  }
  if (!providerAddress) {
    throw new ZGClientError("zg_not_configured", "ZG_PROVIDER_ADDRESS not configured", "config");
  }
  if (!rpcUrl) {
    throw new ZGClientError("zg_not_configured", "ZG_RPC_URL not configured", "config");
  }

  return { privateKey, providerAddress, rpcUrl };
}

export async function initBroker(): Promise<any> {
  if (brokerInstance) return brokerInstance;

  const cfg = getZgConfig();
  const retries = resolveInitRetries();

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { privateKey, rpcUrl } = ensureConfigured();
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(
        privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
        provider
      );
      const createZGComputeNetworkBroker = await loadBrokerFactory();
      brokerInstance = await withTimeout(
        createZGComputeNetworkBroker(wallet),
        resolveHealthcheckTimeoutMs(),
        "zg_broker_init_failed",
        "init_broker",
        "0g broker initialization"
      );
      brokerInitialized = true;
      return brokerInstance;
    } catch (err) {
      if (isMissingDependencyError(err, "@0glabs/0g-serving-broker")) {
        throw new ZGClientError(
          "missing_runtime_dependency",
          "Missing runtime dependency '@0glabs/0g-serving-broker'. Run `npm --workspace agents install`.",
          "init_broker"
        );
      }
      if (isInteropNamedExportError(err)) {
        throw new ZGClientError(
          "zg_broker_module_interop_error",
          `0g broker ESM/CJS interop error: ${normalizeErrorMessage(err)}. ` +
          "Retry with ZG_BROKER_LOADER_MODE=auto or install a broker package version with valid ESM exports.",
          "init_broker"
        );
      }
      if (err instanceof ZGClientError && err.code === "zg_broker_module_interop_error") {
        throw err;
      }
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw asZgError(lastError, "zg_broker_init_failed", "init_broker");
}

export async function ensureLedgerFunding(
  minLedgerCredits?: number,
  depositAmount?: number
): Promise<{ availableBalance: bigint; totalBalance: bigint }> {
  const cfg = getZgConfig();
  const broker = await initBroker();
  const minCredits = Number(minLedgerCredits ?? cfg.minLedgerCredits ?? 1);
  const topupAmount = Number(depositAmount ?? cfg.depositAmount ?? process.env.ZG_DEPOSIT_AMOUNT ?? 5);

  try {
    const ledger = await withTimeout(
      broker.ledger.getLedger(),
      resolveHealthcheckTimeoutMs(),
      "zg_ledger_unfunded",
      "ledger_get",
      "ledger read"
    );

    const available = BigInt(ledger?.availableBalance ?? 0n);
    if (available > 0n) {
      return { availableBalance: available, totalBalance: BigInt(ledger?.totalBalance ?? 0n) };
    }
  } catch (err) {
    // Continue to deposit path; this can be first-run account setup state.
    const message = normalizeErrorMessage(err).toLowerCase();
    if (!message.includes("ledger") && !message.includes("account")) {
      throw asZgError(err, "zg_ledger_unfunded", "ledger_get");
    }
  }

  try {
    await withTimeout(
      broker.ledger.depositFund(Math.max(topupAmount, minCredits)),
      resolveHealthcheckTimeoutMs(),
      "zg_ledger_unfunded",
      "ledger_deposit",
      "ledger funding"
    );

    const after = await withTimeout(
      broker.ledger.getLedger(),
      resolveHealthcheckTimeoutMs(),
      "zg_ledger_unfunded",
      "ledger_get_after_deposit",
      "ledger read after deposit"
    );

    const available = BigInt(after?.availableBalance ?? 0n);
    if (available <= 0n) {
      throw new ZGClientError("zg_ledger_unfunded", "Ledger still has zero available balance after deposit", "ledger_postcheck");
    }

    return { availableBalance: available, totalBalance: BigInt(after?.totalBalance ?? 0n) };
  } catch (err) {
    throw asZgError(err, "zg_ledger_unfunded", "ledger_funding");
  }
}

export async function ensureProviderAcknowledged(providerAddressInput?: string): Promise<void> {
  const broker = await initBroker();
  const providerAddress = (providerAddressInput ?? resolveProviderAddress()).trim();
  if (!providerAddress) {
    throw new ZGClientError("zg_not_configured", "ZG_PROVIDER_ADDRESS not configured", "ack_provider");
  }

  try {
    await withTimeout(
      broker.inference.acknowledgeProviderSigner(providerAddress),
      resolveHealthcheckTimeoutMs(),
      "zg_provider_ack_failed",
      "ack_provider",
      "provider acknowledgement"
    );
  } catch (err) {
    throw asZgError(err, "zg_provider_ack_failed", "ack_provider");
  }
}

async function getServiceMetadata(providerAddress: string): Promise<{ endpoint: string; model: string }> {
  const broker = await initBroker();
  try {
    const meta = await withTimeout(
      broker.inference.getServiceMetadata(providerAddress),
      resolveHealthcheckTimeoutMs(),
      "zg_provider_metadata_failed",
      "metadata",
      "provider metadata"
    );
    const endpoint = String(meta?.endpoint ?? "").trim();
    const model = String(meta?.model ?? "").trim();
    if (!endpoint || !model) {
      throw new ZGClientError("zg_provider_metadata_failed", "Provider metadata missing endpoint/model", "metadata");
    }
    return { endpoint, model };
  } catch (err) {
    throw asZgError(err, "zg_provider_metadata_failed", "metadata");
  }
}

async function getRequestHeaders(providerAddress: string, content?: string): Promise<Record<string, string>> {
  const broker = await initBroker();
  try {
    return await withTimeout(
      broker.inference.getRequestHeaders(providerAddress, content),
      resolveHealthcheckTimeoutMs(),
      "zg_request_headers_failed",
      "headers",
      "request header generation"
    );
  } catch (err) {
    throw asZgError(err, "zg_request_headers_failed", "headers");
  }
}

async function verifyResponse(
  providerAddress: string,
  requestId: string | undefined,
  usage: string | undefined
): Promise<boolean> {
  const broker = await initBroker();
  if (typeof broker?.inference?.processResponse !== "function") {
    return true;
  }

  try {
    const verification = await withTimeout(
      broker.inference.processResponse(providerAddress, requestId, usage),
      resolveHealthcheckTimeoutMs(),
      "zg_response_invalid",
      "verify_response",
      "response verification"
    );

    if (verification === false) {
      throw new ZGClientError("zg_response_invalid", "Provider response signature verification failed", "verify_response");
    }

    return verification !== false;
  } catch (err) {
    throw asZgError(err, "zg_response_invalid", "verify_response");
  }
}

export async function probeProvider(providerAddressInput?: string): Promise<ZGReadinessReport> {
  const cfg = getZgConfig();
  const providerAddress = (providerAddressInput ?? resolveProviderAddress()).trim();
  if (!providerAddress) {
    throw new ZGClientError("zg_not_configured", "ZG_PROVIDER_ADDRESS not configured", "probe");
  }

  const { endpoint, model } = await getServiceMetadata(providerAddress);
  const messages = [{ role: "user" as const, content: "health-check" }];
  const headers = await getRequestHeaders(providerAddress, "health-check");
  const url = buildCompletionUrl(endpoint);
  const timeoutMs = Number(cfg.healthcheckTimeoutMs ?? resolveHealthcheckTimeoutMs());
  const { signal, clear } = withAbortTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 32,
      }),
      signal,
    });

    const rawBody = await readResponseBody(response);
    if (!response.ok) {
      throw new ZGClientError("zg_http_error", `0g provider returned ${response.status}: ${rawBody.slice(0, 240)}`, "probe_http");
    }

    const payload = parseJsonResponse(rawBody, "probe_parse");
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new ZGClientError("zg_response_invalid", "0g provider probe returned empty completion content", "probe_parse");
    }

    const requestId = extractRequestId(response, payload);
    await verifyResponse(providerAddress, requestId, usagePayload(payload));

    const readiness = { providerAddress, endpoint, model, requestId };
    readinessCache = readiness;
    return readiness;
  } catch (err) {
    if (err instanceof ZGClientError) throw err;
    if (isTimeoutError(err)) {
      throw new ZGClientError("zg_timeout", `0g provider probe timed out after ${timeoutMs}ms`, "probe_http");
    }
    throw new ZGClientError("zg_http_error", normalizeErrorMessage(err), "probe_http");
  } finally {
    clear();
  }
}

export async function ensureZgReady(): Promise<ZGReadinessReport> {
  const cfg = getZgConfig();
  const providerAddress = resolveProviderAddress();

  await initBroker();
  await ensureLedgerFunding(cfg.minLedgerCredits, cfg.depositAmount);
  await ensureProviderAcknowledged(providerAddress);

  const shouldProbe = (cfg.probeAtStartup ?? true) !== false;
  if (shouldProbe) {
    return probeProvider(providerAddress);
  }

  const { endpoint, model } = await getServiceMetadata(providerAddress);
  const readiness = { providerAddress, endpoint, model };
  readinessCache = readiness;
  return readiness;
}

export async function infer(
  req: ZGInferenceRequest,
  opts?: { timeoutMs?: number; providerAddress?: string }
): Promise<ZGInferenceResult> {
  const providerAddress = (opts?.providerAddress ?? resolveProviderAddress()).trim();
  if (!providerAddress) {
    throw new ZGClientError("zg_not_configured", "ZG_PROVIDER_ADDRESS not configured", "infer");
  }

  await initBroker();
  const { endpoint, model: modelFromMetaRaw } = await getServiceMetadata(providerAddress);
  const providerModel = canonicalizeModelId(modelFromMetaRaw);
  const resolved = resolveInferenceModel({
    requestedModel: req.model,
    providerModel,
    providerMode: resolveProviderMode(),
  });
  let model = resolved.model;
  let correctedViaHttpMismatch = false;
  const contentForBilling = extractContentForBilling(req.messages);
  const url = buildCompletionUrl(endpoint);
  const timeoutMs = Number(opts?.timeoutMs ?? resolveRequestTimeoutMs());
  const { signal, clear } = withAbortTimeout(timeoutMs);

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const headers = await getRequestHeaders(providerAddress, contentForBilling);
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
        signal,
      });

      const rawBody = await readResponseBody(response);
      if (!response.ok) {
        const hintedModel = response.status === 400 ? extractSupportedModelFromHttpError(rawBody) : null;
        if (attempt === 1 && hintedModel && !modelsEquivalent(model, hintedModel)) {
          model = hintedModel;
          correctedViaHttpMismatch = true;
          continue;
        }
        throw new ZGClientError("zg_http_error", `0g provider returned ${response.status}: ${rawBody.slice(0, 240)}`, "infer_http");
      }

      const payload = parseJsonResponse(rawBody, "infer_parse");
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new ZGClientError("zg_response_invalid", "0g provider returned no completion content", "infer_parse");
      }

      const requestId = extractRequestId(response, payload);
      const verified = await verifyResponse(providerAddress, requestId, usagePayload(payload));

      return {
        content,
        providerAddress,
        endpoint,
        model,
        requestId,
        verified,
        requestedModel: canonicalizeModelId(req.model ?? ""),
        providerModel,
        modelSource: resolved.source,
        modelAutoCorrected: resolved.corrected || correctedViaHttpMismatch,
      };
    }

    throw new ZGClientError("zg_model_auto_corrected", "0g model auto-correction retry exceeded", "infer_model_retry");
  } catch (err) {
    if (err instanceof ZGClientError) throw err;
    if (isTimeoutError(err)) {
      throw new ZGClientError("zg_timeout", `0g inference timed out after ${timeoutMs}ms`, "infer_http");
    }
    throw new ZGClientError("zg_http_error", normalizeErrorMessage(err), "infer_http");
  } finally {
    clear();
  }
}

/** Backward-compatible startup wrapper retained for existing call sites/tests. */
export async function initZgClient(): Promise<void> {
  await ensureZgReady();
}

/** Backward-compatible inference wrapper retained for existing call sites/tests. */
export async function callInference(
  req: ZGInferenceRequest,
  opts?: { timeoutMs?: number; providerAddress?: string }
): Promise<string> {
  const result = await infer(req, opts);
  return result.content;
}

/** Current readiness snapshot (if established during startup/probe). */
export function getReadinessSnapshot(): ZGReadinessReport | null {
  return readinessCache;
}

/** Reset broker state (used in tests). */
export function _resetBroker(): void {
  brokerInstance = null;
  brokerInitialized = false;
  readinessCache = null;
}

export function _isBrokerInitializedForTest(): boolean {
  return brokerInitialized;
}
