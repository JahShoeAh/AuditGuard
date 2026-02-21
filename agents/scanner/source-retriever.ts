import { ethers } from "ethers";

export interface SourceRetrievalResult {
  hasSource: boolean;
  sourceCode: string | null;
  sourceOrigin: "sourcify_full" | "sourcify_partial" | "bytecode_only";
  bytecode: string;
}

export interface RuntimeBytecodeFetchOptions {
  mirrorNodeBaseUrl?: string;
  rpcUrl?: string;
}

const SOURCIFY_BASE = "https://sourcify.dev/server/files";
const HEDERA_CHAIN_ID = 296;
const DEFAULT_RPC_URL = "https://testnet.hashio.io/api";
const DEFAULT_MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

function normalizeHexBytecode(value: unknown): string {
  if (typeof value !== "string") return "0x";
  const trimmed = value.trim();
  if (!trimmed.startsWith("0x")) return "0x";
  if (trimmed === "0x") return "0x";
  return trimmed.toLowerCase();
}

async function fetchMirrorRuntimeBytecode(
  contractAddress: string,
  mirrorNodeBaseUrl: string
): Promise<string | null> {
  const base = mirrorNodeBaseUrl.replace(/\/$/, "");
  const detailUrl = `${base}/api/v1/contracts/${contractAddress}`;
  const res = await fetch(detailUrl);
  if (!res.ok) return null;

  const body = await res.json() as {
    runtime_bytecode?: string | null;
    bytecode?: string | null;
  };
  const runtimeBytecode = normalizeHexBytecode(body.runtime_bytecode);
  if (runtimeBytecode !== "0x") return runtimeBytecode;

  const initBytecode = normalizeHexBytecode(body.bytecode);
  if (initBytecode !== "0x") return initBytecode;
  return null;
}

async function fetchRpcRuntimeBytecode(
  contractAddress: string,
  rpcUrl: string
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const code = await provider.getCode(contractAddress);
  return normalizeHexBytecode(code);
}

export async function fetchRuntimeBytecode(
  contractAddress: string,
  options: RuntimeBytecodeFetchOptions = {}
): Promise<string> {
  const mirrorNodeBaseUrl =
    options.mirrorNodeBaseUrl ||
    process.env.SCANNER_MIRROR_NODE ||
    DEFAULT_MIRROR_NODE;
  const rpcUrl =
    options.rpcUrl ||
    process.env.SCANNER_EVM_RPC_URL ||
    process.env.HEDERA_JSON_RPC_URL ||
    DEFAULT_RPC_URL;

  try {
    const mirrorBytecode = await fetchMirrorRuntimeBytecode(contractAddress, mirrorNodeBaseUrl);
    if (mirrorBytecode && mirrorBytecode !== "0x") return mirrorBytecode;
  } catch {
    // Mirror endpoint is best-effort here; RPC fallback handles transient failures.
  }

  try {
    return await fetchRpcRuntimeBytecode(contractAddress, rpcUrl);
  } catch {
    return "0x";
  }
}

export async function retrieveContractSource(
  contractAddress: string,
  rpcUrl: string,
  knownBytecode?: string
): Promise<SourceRetrievalResult> {
  const providedBytecode = normalizeHexBytecode(knownBytecode);
  let bytecode = providedBytecode;
  if (bytecode === "0x") {
    try {
      bytecode = await fetchRpcRuntimeBytecode(contractAddress, rpcUrl);
    } catch {
      bytecode = "0x";
    }
  }

  const fullMatchSource = await fetchSourcify(contractAddress, "full");
  if (fullMatchSource) {
    return {
      hasSource: true,
      sourceCode: fullMatchSource,
      sourceOrigin: "sourcify_full" as const,
      bytecode,
    };
  }

  const partialMatchSource = await fetchSourcify(contractAddress, "partial");
  if (partialMatchSource) {
    return {
      hasSource: true,
      sourceCode: partialMatchSource,
      sourceOrigin: "sourcify_partial" as const,
      bytecode,
    };
  }

  return {
    hasSource: false,
    sourceCode: null,
    sourceOrigin: "bytecode_only" as const,
    bytecode,
  };
}

async function fetchSourcify(
  address: string,
  matchType: "full" | "partial"
): Promise<string | null> {
  const matchPath = matchType === "full" ? "full_match" : "partial_match";
  const metadataUrl =
    `${SOURCIFY_BASE}/${matchPath}/${HEDERA_CHAIN_ID}/${address}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(metadataUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const files: any[] = await res.json();
    if (!Array.isArray(files)) return null;

    const solFiles = files.filter(
      (f: any) =>
        typeof f.path === "string" &&
        f.path.endsWith(".sol") &&
        !f.path.includes("/interfaces/") &&
        !f.path.includes("/libraries/")
    );

    if (solFiles.length === 0) return null;

    solFiles.sort(
      (a: any, b: any) =>
        (b.content?.length ?? 0) - (a.content?.length ?? 0)
    );

    return solFiles[0].content ?? null;
  } catch {
    return null;
  }
}
