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
  return await uploadToIPFS(content);
}

export function ipfsGatewayUrl(cid: string): string {
  return `http://127.0.0.1:8080/ipfs/${cid}`;
}
