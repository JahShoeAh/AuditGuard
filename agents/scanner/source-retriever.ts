import { ethers } from "ethers";

export interface SourceRetrievalResult {
  hasSource: boolean;
  sourceCode: string | null;
  sourceOrigin: "sourcify_full" | "sourcify_partial" | "bytecode_only";
  bytecode: string;
}

const SOURCIFY_BASE = "https://sourcify.dev/server/files";
const HEDERA_CHAIN_ID = 296;

export async function retrieveContractSource(
  contractAddress: string,
  rpcUrl: string
): Promise<SourceRetrievalResult> {
  let bytecode = "0x";
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    bytecode = await provider.getCode(contractAddress);
  } catch {
    bytecode = "0x";
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
