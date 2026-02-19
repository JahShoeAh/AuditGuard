import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        testTimeout: 120000,
        hookTimeout: 120000,
    },
});
