import { ethers } from "ethers";

export async function uploadToIPFS(content: string): Promise<string> {
  const boundary = `----AuditGuardBoundary${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audit-report.md"\r\n` +
    `Content-Type: text/markdown\r\n\r\n` +
    content +
    `\r\n--${boundary}--\r\n`;

  const response = await fetch("http://127.0.0.1:5001/api/v0/add", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!response.ok) throw new Error(`IPFS upload failed: ${response.status}`);
  const raw = await response.text();
  const line = raw.trim().split("\n").filter(Boolean).pop() ?? "{}";
  const result = JSON.parse(line);
  return result.Hash;
}

export async function uploadToIPFSSafe(content: string): Promise<string> {
  try {
    return await uploadToIPFS(content);
  } catch (err) {
    console.warn(`[IPFS] Upload failed, using mock CID: ${err}`);
    return `QmMOCK${ethers.keccak256(Buffer.from(content)).slice(2, 22)}`;
  }
}

export function ipfsGatewayUrl(cid: string): string {
  return `http://localhost:8080/ipfs/${cid}`;
}

