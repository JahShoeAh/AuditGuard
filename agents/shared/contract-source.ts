import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

let sourceCache: Record<string, string> | null = null;

export function loadContractSource(sourceRef: string): string | null {
  if (!sourceCache) {
    try {
      const __configDir = dirname(fileURLToPath(import.meta.url));
      const sourcePath = join(__configDir, "..", "..", "packages", "sdk", "test-contract-sources.json");
      const raw = readFileSync(sourcePath, "utf8");
      sourceCache = JSON.parse(raw);
    } catch (err) {
      console.warn(`[contract-source] Failed to load sources: ${err}`);
      return null;
    }
  }
  return sourceCache?.[sourceRef] ?? null;
}

