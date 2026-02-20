import { ZGClientError, infer, initZgClient } from "./llm-contextual/zg-client.js";
import { CONFIG } from "./shared/config.js";
import {
  ensureHttpReachableOrSkip,
  ensureToggleOrSkip,
  getEnvOrSkip,
} from "./scripts/live-preflight.js";

function modelName(): string {
  return process.env.ZG_MODEL ?? (CONFIG as any).zgInference?.model ?? "qwen/qwen-2.5-7b-instruct";
}

async function main(): Promise<void> {
  ensureToggleOrSkip("RUN_LIVE_ZG_TESTS", "0g live tests");
  const rpcUrl = getEnvOrSkip("ZG_RPC_URL");
  getEnvOrSkip("ZG_PRIVATE_KEY");
  getEnvOrSkip("ZG_PROVIDER_ADDRESS");
  await ensureHttpReachableOrSkip(rpcUrl, "0g RPC");

  console.log("Initializing 0g client...");
  await initZgClient();
  console.log("Client initialized");

  console.log("Testing inference...");
  const result = await infer({
    model: modelName(),
    messages: [
      { role: "system", content: "You are a smart contract security auditor." },
      { role: "user", content: "What are the top 3 vulnerabilities in ERC-20 tokens?" },
    ],
    temperature: 0.3,
    max_tokens: 500,
  });

  console.log("Inference successful");
  console.log("Provider:", result.providerAddress);
  console.log("Verified:", result.verified);
  console.log("Response preview:", result.content.slice(0, 200));
}

main().catch((err: unknown) => {
  if (err instanceof ZGClientError) {
    console.error(`Inference failed [${err.code}] ${err.message}`);
  } else if (err instanceof Error) {
    console.error("Inference failed:", err.message);
  } else {
    console.error("Inference failed:", String(err));
  }
  process.exit(1);
});
