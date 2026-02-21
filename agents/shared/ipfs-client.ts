import { createHash } from "node:crypto";

const IPFS_ENABLED = String(process.env.IPFS_ENABLED ?? "false").toLowerCase() === "true";
const IPFS_API = process.env.IPFS_API_URL ?? "http://127.0.0.1:5001";

export async function uploadToIPFS(content: string): Promise<string> {
  const boundary = `----AuditGuardBoundary${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audit-report.md"\r\n` +
    `Content-Type: text/markdown\r\n\r\n` +
    content +
    `\r\n--${boundary}--\r\n`;

  const response = await fetch(`${IPFS_API}/api/v0/add`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`[IPFS] Upload failed (${response.status}): ${text}`);
  }

  const raw = await response.text();
  const line = raw.trim().split("\n").filter(Boolean).pop() ?? "{}";
  const result = JSON.parse(line) as { Hash: string };
  return result.Hash;
}

export async function uploadToIPFSSafe(content: string): Promise<string> {
  if (!IPFS_ENABLED) {
    return `local-${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
  }
  try {
    return await uploadToIPFS(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = `local-${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
    console.warn(`[IPFS] Upload unavailable (${reason}); using fallback cid ${fallback}`);
    return fallback;
  }
}

export function ipfsGatewayUrl(cid: string): string {
  return `http://127.0.0.1:8080/ipfs/${cid}`;
}
