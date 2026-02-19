const DEFAULT_TIMEOUT_MS = Number(process.env.LIVE_TESTS_TIMEOUT_MS ?? "8000");

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function liveTestsRequired(): boolean {
  return envFlag("LIVE_TESTS_REQUIRED", false);
}

export function ensureToggleOrSkip(toggleName: string, label: string): void {
  const raw = process.env[toggleName];
  if (raw == null) return;
  if (!envFlag(toggleName, true)) {
    skipOrFail(`${label} disabled via ${toggleName}=false`);
  }
}

export function skipOrFail(reason: string): never {
  if (liveTestsRequired()) {
    throw new Error(`LIVE_TESTS_REQUIRED=true and preflight failed: ${reason}`);
  }
  console.log(`SKIPPED: ${reason}`);
  process.exit(0);
}

export function getEnvOrSkip(name: string, label = name): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  skipOrFail(`missing required env ${label}`);
}

export async function ensureHttpReachableOrSkip(
  url: string,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<void> {
  let controller: AbortController | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    controller = new AbortController();
    timeoutHandle = setTimeout(() => controller?.abort(), timeoutMs);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    // Any HTTP response means endpoint is reachable.
    if (!res) {
      skipOrFail(`${label} returned no response`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    skipOrFail(`${label} unreachable (${message})`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
