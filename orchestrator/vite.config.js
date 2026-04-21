import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    ssr: path.resolve(__dirname, "src/index.js"),
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "@hashgraph/sdk",
        "@aws-sdk/client-s3",
        "dotenv",
        "ethers",
        "winston",
        "url",
        "module",
        "fs",
        "path",
        "crypto",
        "stream",
        "util",
        "events",
        "buffer",
      ],
    },
  },
});
