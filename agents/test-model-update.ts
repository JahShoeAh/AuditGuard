import { infer, probeProvider } from "./llm-contextual/zg-client.js";
import { CONFIG } from "./shared/config.js";

function requestedModel(): string {
  return process.env.ZG_MODEL ?? (CONFIG as any).zgInference?.model ?? "qwen-2.5-7b-instruct";
}

async function main(): Promise<void> {
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS;
  if (!providerAddress) {
    throw new Error("Set ZG_PROVIDER_ADDRESS before running model update test");
  }

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
