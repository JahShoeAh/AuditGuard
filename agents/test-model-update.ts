import { infer, probeProvider } from "./llm-contextual/zg-client.js";
import { CONFIG } from "./shared/config.js";
import {
  ensureHttpReachableOrSkip,
  ensureToggleOrSkip,
  getEnvOrSkip,
} from "./scripts/live-preflight.js";

function requestedModel(): string {
  return process.env.ZG_MODEL ?? (CONFIG as any).zgInference?.model ?? "qwen-2.5-7b-instruct";
}

async function main(): Promise<void> {
  ensureToggleOrSkip("RUN_LIVE_ZG_TESTS", "0g live tests");
  const rpcUrl = getEnvOrSkip("ZG_RPC_URL");
  getEnvOrSkip("ZG_PRIVATE_KEY");
  const providerAddress = getEnvOrSkip("ZG_PROVIDER_ADDRESS");
  await ensureHttpReachableOrSkip(rpcUrl, "0g RPC");

  console.log("Probing provider...");
  const report = await probeProvider(providerAddress);
  console.log("Provider endpoint:", report.endpoint);
  console.log("Provider model:", report.model);

  const model = requestedModel();
  console.log("Testing inference with model:", model);
  const result = await infer({
    model,
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0.1,
    max_tokens: 32,
  });

  console.log("Inference result:", result.content.trim());
  console.log("Verified:", result.verified);
}

main().catch((err) => {
  console.error("Model update test failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
