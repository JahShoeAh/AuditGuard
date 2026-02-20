import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ALL_PATH = join(__dirname, "..", "run-all.ts");

describe("run-all launcher", () => {
  it("does not force Scanner TEST_MODE=true implicitly", () => {
    const src = readFileSync(RUN_ALL_PATH, "utf-8");
    expect(src).not.toContain('def.name === "Scanner" ? { TEST_MODE: "true" }');
  });
});
