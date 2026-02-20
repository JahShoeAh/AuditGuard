import { defineConfig } from "vitest/config";

const runClassifierRiskTests =
  String(process.env.RUN_CLASSIFIER_RISK_TESTS || "").toLowerCase() === "true" ||
  String(process.env.SCANNER_CLASSIFIER_PIPELINE || "").toLowerCase() === "true";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        exclude: [
            "dist/**",
            "node_modules/**",
            ...(runClassifierRiskTests ? [] : ["tests/classifier-risk.test.ts"]),
        ],
        testTimeout: 120000,
        hookTimeout: 120000,
    },
});
