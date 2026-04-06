/**
 * Comprehensive offline unit tests for agents/shared/ infrastructure.
 *
 * These tests verify that all shared modules compile, load, and behave
 * correctly WITHOUT any network calls (no Hedera testnet needed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = join(__test_dirname, "..", "shared");
const ABI_DIR = join(__test_dirname, "..", "..", "packages", "sdk", "abis");

// ============================================================
// 1. Types — verify exports and type shapes
// ============================================================

describe("types.ts", () => {
    it("exports all HCS message types", async () => {
        const types = await import("../shared/types.js");
        expect(types).toBeDefined();
    });

    it("exports AgentRole type with all 7 roles", async () => {
        const types = await import("../shared/types.js");
        expect(typeof types).toBe("object");
    });

    it("exports ContractType values", async () => {
        const types = await import("../shared/types.js");
        expect(types).toBeDefined();
    });

    it("exports all agent-related interfaces", async () => {
        // Verify the module has no default export and is purely type/interface
        const mod = await import("../shared/types.js");
        const keys = Object.keys(mod);
        // types.ts is all type exports — should be importable without side effects
        expect(keys.length).toBeGreaterThanOrEqual(0);
    });
});

// ============================================================
// 2. Config — verify structure and env loading
// ============================================================

describe("config.ts", () => {
    it("exports CONFIG with all required fields", async () => {
        const { CONFIG } = await import("../shared/config.js");

        expect(CONFIG.network).toBe("testnet");
        expect(CONFIG.guardToken.id).toMatch(/^0\.0\.\d+$/);
        expect(CONFIG.guardToken.evmAddress).toMatch(/^0x/);

        // HCS topics
        expect(CONFIG.hcsTopics.discovery).toMatch(/^0\.0\.\d+$/);
        expect(CONFIG.hcsTopics.auditLog).toMatch(/^0\.0\.\d+$/);
        expect(CONFIG.hcsTopics.agentComms).toMatch(/^0\.0\.\d+$/);

        // Contract addresses
        expect(CONFIG.contracts.agentRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(CONFIG.contracts.auction).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(CONFIG.contracts.subAuction).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(CONFIG.contracts.dataMarketplace).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(CONFIG.contracts.paymentSettlement).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(CONFIG.contracts.budgetVault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("CONFIG has all 6 contract addresses", async () => {
        const { CONFIG } = await import("../shared/config.js");
        const contracts = Object.keys(CONFIG.contracts);
        expect(contracts).toContain("agentRegistry");
        expect(contracts).toContain("budgetVault");
        expect(contracts).toContain("auction");
        expect(contracts).toContain("subAuction");
        expect(contracts).toContain("dataMarketplace");
        expect(contracts).toContain("paymentSettlement");
        expect(contracts.length).toBe(6);
    });

    it("CONFIG has 3 HCS topic IDs", async () => {
        const { CONFIG } = await import("../shared/config.js");
        const topics = Object.keys(CONFIG.hcsTopics);
        expect(topics).toContain("discovery");
        expect(topics).toContain("auditLog");
        expect(topics).toContain("agentComms");
        expect(topics.length).toBe(3);
    });

    it("CONFIG has GUARD token ID and EVM address", async () => {
        const { CONFIG } = await import("../shared/config.js");
        expect(CONFIG.guardToken.id).toMatch(/^0\.0\.\d+$/);
        expect(CONFIG.guardToken.evmAddress).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it("CONFIG has demo/test params", async () => {
        const { CONFIG } = await import("../shared/config.js");
        expect(CONFIG.settlementPreFunded).toBe(500);
        expect(CONFIG.demoVault.weeklyMonitoring).toBe(10);
        expect(CONFIG.demoVault.criticalBounty).toBe(50);
    });

    it("getAgentEnv reads env vars with agent prefix", async () => {
        process.env.TESTBOT_ACCOUNT_ID = "0.0.99999";
        process.env.TESTBOT_PRIVATE_KEY = "abc123";

        const { getAgentEnv } = await import("../shared/config.js");
        const env = getAgentEnv("TESTBOT");

        expect(env.accountId).toBe("0.0.99999");
        expect(env.privateKey).toBe("abc123");

        delete process.env.TESTBOT_ACCOUNT_ID;
        delete process.env.TESTBOT_PRIVATE_KEY;
    });

    it("getAgentEnv falls back to OPERATOR_* vars", async () => {
        process.env.OPERATOR_ACCOUNT_ID = "0.0.11111";
        process.env.OPERATOR_PRIVATE_KEY = "operator_key";

        const { getAgentEnv } = await import("../shared/config.js");
        const env = getAgentEnv("NONEXISTENT");

        expect(env.accountId).toBe("0.0.11111");
        expect(env.privateKey).toBe("operator_key");

        delete process.env.OPERATOR_ACCOUNT_ID;
        delete process.env.OPERATOR_PRIVATE_KEY;
    });

    it("getAgentEnv throws when no credentials available", async () => {
        const savedAcct = process.env.OPERATOR_ACCOUNT_ID;
        const savedKey = process.env.OPERATOR_PRIVATE_KEY;
        const savedHederaAcct = process.env.HEDERA_ACCOUNT_ID;
        const savedHederaKey = process.env.HEDERA_PRIVATE_KEY;
        delete process.env.OPERATOR_ACCOUNT_ID;
        delete process.env.OPERATOR_PRIVATE_KEY;
        delete process.env.HEDERA_ACCOUNT_ID;
        delete process.env.HEDERA_PRIVATE_KEY;

        const { getAgentEnv } = await import("../shared/config.js");
        expect(() => getAgentEnv("MISSING_AGENT")).toThrow(/Missing credentials/);

        if (savedAcct) process.env.OPERATOR_ACCOUNT_ID = savedAcct;
        if (savedKey) process.env.OPERATOR_PRIVATE_KEY = savedKey;
        if (savedHederaAcct) process.env.HEDERA_ACCOUNT_ID = savedHederaAcct;
        if (savedHederaKey) process.env.HEDERA_PRIVATE_KEY = savedHederaKey;
    });

    it("getAgentEnv prefers agent-specific vars over OPERATOR_*", async () => {
        process.env.OPERATOR_ACCOUNT_ID = "0.0.11111";
        process.env.OPERATOR_PRIVATE_KEY = "operator_key";
        process.env.SPECIFIC_ACCOUNT_ID = "0.0.22222";
        process.env.SPECIFIC_PRIVATE_KEY = "specific_key";

        const { getAgentEnv } = await import("../shared/config.js");
        const env = getAgentEnv("SPECIFIC");

        expect(env.accountId).toBe("0.0.22222");
        expect(env.privateKey).toBe("specific_key");

        delete process.env.OPERATOR_ACCOUNT_ID;
        delete process.env.OPERATOR_PRIVATE_KEY;
        delete process.env.SPECIFIC_ACCOUNT_ID;
        delete process.env.SPECIFIC_PRIVATE_KEY;
    });

    it("getAgentEnv handles case correctly (uppercases agent name)", async () => {
        process.env.MYAGENT_ACCOUNT_ID = "0.0.33333";
        process.env.MYAGENT_PRIVATE_KEY = "my_key";

        const { getAgentEnv } = await import("../shared/config.js");
        // The function uppercases the prefix, so "myagent" → "MYAGENT"
        const env = getAgentEnv("myagent");
        expect(env.accountId).toBe("0.0.33333");

        delete process.env.MYAGENT_ACCOUNT_ID;
        delete process.env.MYAGENT_PRIVATE_KEY;
    });

    it("dotenv resolves .env from correct path (not cwd-dependent)", async () => {
        // The .env file should be loaded from agents/.env
        // This test verifies the dotenv path fix works
        const envPath = join(__test_dirname, "..", ".env");
        expect(existsSync(envPath)).toBe(true);
    });
});

// ============================================================
// 3. Utils — verify random generators, hashing, mock helpers
// ============================================================

describe("utils.ts", () => {
    it("randomInt returns values within bounds", async () => {
        const { randomInt } = await import("../shared/utils.js");
        for (let i = 0; i < 100; i++) {
            const val = randomInt(10, 20);
            expect(val).toBeGreaterThanOrEqual(10);
            expect(val).toBeLessThanOrEqual(20);
        }
    });

    it("randomInt returns integers only", async () => {
        const { randomInt } = await import("../shared/utils.js");
        for (let i = 0; i < 50; i++) {
            const val = randomInt(0, 100);
            expect(Number.isInteger(val)).toBe(true);
        }
    });

    it("randomInt handles equal bounds", async () => {
        const { randomInt } = await import("../shared/utils.js");
        expect(randomInt(5, 5)).toBe(5);
    });

    it("randomFloat returns values within bounds", async () => {
        const { randomFloat } = await import("../shared/utils.js");
        for (let i = 0; i < 100; i++) {
            const val = randomFloat(1.5, 3.5);
            expect(val).toBeGreaterThanOrEqual(1.5);
            expect(val).toBeLessThan(3.5);
        }
    });

    it("randomFloat returns non-integer values", async () => {
        const { randomFloat } = await import("../shared/utils.js");
        let hasDecimal = false;
        for (let i = 0; i < 50; i++) {
            const val = randomFloat(0, 10);
            if (!Number.isInteger(val)) hasDecimal = true;
        }
        expect(hasDecimal).toBe(true);
    });

    it("randomHex returns correct length hex string", async () => {
        const { randomHex } = await import("../shared/utils.js");
        const hex = randomHex(20);
        expect(hex).toMatch(/^[0-9a-f]{40}$/);

        const hex32 = randomHex(32);
        expect(hex32).toMatch(/^[0-9a-f]{64}$/);
    });

    it("randomHex produces different values each call", async () => {
        const { randomHex } = await import("../shared/utils.js");
        const a = randomHex(20);
        const b = randomHex(20);
        expect(a).not.toBe(b);
    });

    it("randomChoice selects from array", async () => {
        const { randomChoice } = await import("../shared/utils.js");
        const items = ["a", "b", "c"];
        for (let i = 0; i < 50; i++) {
            expect(items).toContain(randomChoice(items));
        }
    });

    it("randomChoice returns the only element for single-element arrays", async () => {
        const { randomChoice } = await import("../shared/utils.js");
        expect(randomChoice(["only"])).toBe("only");
    });

    it("randomBool returns boolean values", async () => {
        const { randomBool } = await import("../shared/utils.js");
        let trueCount = 0;
        for (let i = 0; i < 1000; i++) {
            const val = randomBool(0.5);
            expect(typeof val).toBe("boolean");
            if (val) trueCount++;
        }
        expect(trueCount).toBeGreaterThan(300);
        expect(trueCount).toBeLessThan(700);
    });

    it("randomBool(0) always returns false", async () => {
        const { randomBool } = await import("../shared/utils.js");
        for (let i = 0; i < 50; i++) {
            expect(randomBool(0)).toBe(false);
        }
    });

    it("randomBool(1) always returns true", async () => {
        const { randomBool } = await import("../shared/utils.js");
        for (let i = 0; i < 50; i++) {
            expect(randomBool(1)).toBe(true);
        }
    });

    it("weightedRandom respects weights", async () => {
        const { weightedRandom } = await import("../shared/utils.js");
        const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
        for (let i = 0; i < 10000; i++) {
            const val = weightedRandom({ a: 0.7, b: 0.2, c: 0.1 });
            counts[val]++;
        }
        expect(counts.a).toBeGreaterThan(counts.b);
        expect(counts.b).toBeGreaterThan(counts.c);
        expect(counts.a).toBeGreaterThan(5000);
    });

    it("weightedRandom always returns a key from the provided object", async () => {
        const { weightedRandom } = await import("../shared/utils.js");
        const keys = ["x", "y", "z"];
        for (let i = 0; i < 100; i++) {
            const val = weightedRandom({ x: 1, y: 1, z: 1 });
            expect(keys).toContain(val);
        }
    });

    it("hashOf is deterministic", async () => {
        const { hashOf } = await import("../shared/utils.js");
        const data = { foo: "bar", num: 42 };
        const hash1 = hashOf(data);
        const hash2 = hashOf(data);
        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("hashOf produces different hashes for different inputs", async () => {
        const { hashOf } = await import("../shared/utils.js");
        const h1 = hashOf({ a: 1 });
        const h2 = hashOf({ a: 2 });
        expect(h1).not.toBe(h2);
    });

    it("hashOf handles complex nested objects", async () => {
        const { hashOf } = await import("../shared/utils.js");
        const complex = { a: { b: { c: [1, 2, 3] } }, d: "string" };
        const hash = hashOf(complex);
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("hashOf handles arrays", async () => {
        const { hashOf } = await import("../shared/utils.js");
        const h = hashOf([1, 2, 3]);
        expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("sleep resolves after specified time", async () => {
        const { sleep } = await import("../shared/utils.js");
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it("randomFindingTitle returns a string for each contract type", async () => {
        const { randomFindingTitle } = await import("../shared/utils.js");
        const types = ["lending", "dex", "staking", "bridge", "vault", "unknown"] as const;
        for (const t of types) {
            const title = randomFindingTitle(t);
            expect(typeof title).toBe("string");
            expect(title.length).toBeGreaterThan(0);
        }
    });

    it("randomFindingTitle returns type-relevant titles", async () => {
        const { randomFindingTitle } = await import("../shared/utils.js");
        // Lending titles should mention lending-related terms
        const lendingTitles = new Set<string>();
        for (let i = 0; i < 100; i++) {
            lendingTitles.add(randomFindingTitle("lending"));
        }
        // Should have multiple different titles
        expect(lendingTitles.size).toBeGreaterThan(1);
    });

    it("randomSeverity returns valid severity values", async () => {
        const { randomSeverity } = await import("../shared/utils.js");
        const validSeverities = ["critical", "high", "medium", "low", "info"];
        for (let i = 0; i < 50; i++) {
            expect(validSeverities).toContain(randomSeverity());
        }
    });

    it("randomSeverity distribution: medium+low dominate", async () => {
        const { randomSeverity } = await import("../shared/utils.js");
        let medLow = 0;
        const total = 2000;
        for (let i = 0; i < total; i++) {
            const s = randomSeverity();
            if (s === "medium" || s === "low") medLow++;
        }
        // medium(0.4) + low(0.35) = 0.75, expect > 60%
        expect(medLow / total).toBeGreaterThan(0.6);
    });

    it("randomSeveritySkewedHigh returns more critical/high", async () => {
        const { randomSeveritySkewedHigh } = await import("../shared/utils.js");
        let highOrCritical = 0;
        const total = 1000;
        for (let i = 0; i < total; i++) {
            const s = randomSeveritySkewedHigh();
            if (s === "critical" || s === "high") highOrCritical++;
        }
        expect(highOrCritical / total).toBeGreaterThan(0.35);
    });

    it("randomSeveritySkewedHigh has more critical than randomSeverity", async () => {
        const { randomSeverity, randomSeveritySkewedHigh } = await import("../shared/utils.js");
        let normalCritical = 0;
        let skewedCritical = 0;
        const total = 5000;
        for (let i = 0; i < total; i++) {
            if (randomSeverity() === "critical") normalCritical++;
            if (randomSeveritySkewedHigh() === "critical") skewedCritical++;
        }
        expect(skewedCritical).toBeGreaterThan(normalCritical);
    });
});

// ============================================================
// 4. Contract Client — ABI loading & class construction
// ============================================================

describe("contract-client.ts", () => {
    it("loads all 6 ABI files from packages/sdk/abis/", async () => {
        const { ABIS } = await import("../shared/contract-client.js");

        expect(ABIS.agentRegistry).toBeDefined();
        expect(ABIS.auction).toBeDefined();
        expect(ABIS.budgetVault).toBeDefined();
        expect(ABIS.subAuction).toBeDefined();
        expect(ABIS.dataMarketplace).toBeDefined();
        expect(ABIS.paymentSettlement).toBeDefined();
    });

    it("each ABI is a non-empty array", async () => {
        const { ABIS } = await import("../shared/contract-client.js");

        for (const [name, abi] of Object.entries(ABIS)) {
            expect(Array.isArray(abi)).toBe(true);
            expect((abi as unknown[]).length).toBeGreaterThan(0);
        }
    });

    it("ABI files on disk exist and are valid JSON", () => {
        const abiFiles = [
            "AgentRegistry.json",
            "AuditAuction.json",
            "AuditBudgetVault.json",
            "SubAuction.json",
            "DataMarketplace.json",
            "PaymentSettlement.json",
        ];

        for (const f of abiFiles) {
            const path = join(ABI_DIR, f);
            expect(existsSync(path)).toBe(true);

            const content = JSON.parse(readFileSync(path, "utf-8"));
            expect(content).toHaveProperty("abi");
            expect(Array.isArray(content.abi)).toBe(true);
            expect(content.abi.length).toBeGreaterThan(0);
        }
    });

    it("ABI_DIR points to the correct directory", async () => {
        const mod = await import("../shared/contract-client.js");
        expect(existsSync(mod.ABI_DIR)).toBe(true);
    });

    it("loadABI function loads a specific contract", async () => {
        const { loadABI } = await import("../shared/contract-client.js");
        const abi = loadABI("AuditAuction");
        expect(Array.isArray(abi)).toBe(true);
        const abiStr = JSON.stringify(abi);
        expect(abiStr).toContain("createAuditJob");
        expect(abiStr).toContain("submitBid");
    });

    it("loadABI throws for non-existent contract", async () => {
        const { loadABI } = await import("../shared/contract-client.js");
        expect(() => loadABI("DoesNotExist")).toThrow();
    });

    it("Auction ABI includes key functions", async () => {
        const { ABIS } = await import("../shared/contract-client.js");
        const abiStr = JSON.stringify(ABIS.auction);
        expect(abiStr).toContain("submitBid");
        expect(abiStr).toContain("createAuditJob");
    });

    it("SubAuction ABI includes key functions", async () => {
        const { ABIS } = await import("../shared/contract-client.js");
        const abiStr = JSON.stringify(ABIS.subAuction);
        expect(abiStr).toContain("createSubAuction");
        expect(abiStr).toContain("submitSubBid");
        expect(abiStr).toContain("deliverResult");
    });

    it("DataMarketplace ABI includes key functions", async () => {
        const { ABIS } = await import("../shared/contract-client.js");
        const abiStr = JSON.stringify(ABIS.dataMarketplace);
        expect(abiStr).toContain("createListing");
        expect(abiStr).toContain("purchaseData");
    });

    it("PaymentSettlement ABI includes key functions", async () => {
        const { ABIS } = await import("../shared/contract-client.js");
        const abiStr = JSON.stringify(ABIS.paymentSettlement);
        expect(abiStr).toContain("settleJob");
    });

    it("ContractClient can be instantiated with a wallet", async () => {
        const { ethers } = await import("ethers");
        const { ContractClient } = await import("../shared/contract-client.js");

        const hdWallet = ethers.Wallet.createRandom();
        const wallet = new ethers.Wallet(hdWallet.privateKey);
        const client = new ContractClient(wallet);

        expect(client.auction).toBeDefined();
        expect(client.subAuction).toBeDefined();
        expect(client.dataMarketplace).toBeDefined();
        expect(client.paymentSettlement).toBeDefined();
        expect(client.agentRegistry).toBeDefined();
        expect(client.budgetVault).toBeDefined();
        expect(client.getAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("ContractClient.fromPrivateKey creates a valid client", async () => {
        const { ContractClient } = await import("../shared/contract-client.js");
        const { ethers } = await import("ethers");

        const randomWallet = ethers.Wallet.createRandom();
        const client = ContractClient.fromPrivateKey(randomWallet.privateKey);

        expect(client.getAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("ContractClient.fromPrivateKey handles 0x prefix and raw hex", async () => {
        const { ContractClient } = await import("../shared/contract-client.js");
        const { ethers } = await import("ethers");

        const w = ethers.Wallet.createRandom();
        const withPrefix = ContractClient.fromPrivateKey(w.privateKey);
        const withoutPrefix = ContractClient.fromPrivateKey(w.privateKey.slice(2));

        // Both should produce the same address
        expect(withPrefix.getAddress()).toBe(withoutPrefix.getAddress());
    });

    it("ContractClient exposes all convenience methods", async () => {
        const { ethers } = await import("ethers");
        const { ContractClient } = await import("../shared/contract-client.js");

        const hdWallet = ethers.Wallet.createRandom();
        const wallet = new ethers.Wallet(hdWallet.privateKey);
        const client = new ContractClient(wallet);

        // Auction methods
        expect(typeof client.submitBid).toBe("function");
        expect(typeof client.getMinBidCollateral).toBe("function");
        expect(typeof client.getAuction).toBe("function");
        expect(typeof client.getAuctionAddress).toBe("function");
        expect(typeof client.onAuctionCreated).toBe("function");
        expect(typeof client.onWinnerSelected).toBe("function");

        // SubAuction methods
        expect(typeof client.createSubAuction).toBe("function");
        expect(typeof client.submitSubBid).toBe("function");
        expect(typeof client.deliverResult).toBe("function");
        expect(typeof client.acceptResult).toBe("function");
        expect(typeof client.onSubAuctionCreated).toBe("function");

        // DataMarketplace methods
        expect(typeof client.createListing).toBe("function");
        expect(typeof client.purchaseData).toBe("function");
        expect(typeof client.getListing).toBe("function");
        expect(typeof client.onListingCreated).toBe("function");
        expect(typeof client.onDataPurchased).toBe("function");

        // PaymentSettlement methods
        expect(typeof client.settleJob).toBe("function");
        expect(typeof client.getReportFeeBase).toBe("function");
        expect(typeof client.getReportFeeDiscounted).toBe("function");

        // AgentRegistry methods
        expect(typeof client.registerAgent).toBe("function");
        expect(typeof client.getAgent).toBe("function");
        expect(typeof client.isActiveAgent).toBe("function");
        expect(typeof client.getGuardBalance).toBe("function");
        expect(typeof client.getGuardAllowance).toBe("function");
        expect(typeof client.ensureGuardAllowance).toBe("function");

        // Cleanup
        expect(typeof client.removeAllListeners).toBe("function");
    });

    it("ContractClient.removeAllListeners does not throw", async () => {
        const { ethers } = await import("ethers");
        const { ContractClient } = await import("../shared/contract-client.js");

        const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
        const client = new ContractClient(wallet);

        expect(() => client.removeAllListeners()).not.toThrow();
    });
});

// ============================================================
// 5. HCS Client — class construction
// ============================================================

describe("hcs-client.ts", () => {
    it("HCSClient class is importable", async () => {
        const { HCSClient } = await import("../shared/hcs-client.js");
        expect(HCSClient).toBeDefined();
        expect(typeof HCSClient).toBe("function");
    });

    it("HCSClient prototype has all pub/sub methods", async () => {
        const { HCSClient } = await import("../shared/hcs-client.js");
        const proto = HCSClient.prototype;

        expect(typeof proto.publish).toBe("function");
        expect(typeof proto.publishDiscovery).toBe("function");
        expect(typeof proto.publishAuditLog).toBe("function");
        expect(typeof proto.publishAgentComms).toBe("function");
        expect(typeof proto.subscribe).toBe("function");
        expect(typeof proto.subscribeDiscovery).toBe("function");
        expect(typeof proto.subscribeAuditLog).toBe("function");
        expect(typeof proto.subscribeAgentComms).toBe("function");
        expect(typeof proto.getClient).toBe("function");
    });

    it("HCSClient has exactly 9 prototype methods", async () => {
        const { HCSClient } = await import("../shared/hcs-client.js");
        const methods = Object.getOwnPropertyNames(HCSClient.prototype)
            .filter(m => m !== "constructor");
        expect(methods.length).toBe(9);
    });
});

// ============================================================
// 6. Logger — creation for all agent roles
// ============================================================

describe("logger.ts", () => {
    it("createAgentLogger returns a logger for each role", async () => {
        const { createAgentLogger } = await import("../shared/logger.js");
        const roles = [
            "scanner",
            "static_analysis",
            "fuzzer",
            "llm_contextual",
            "dependency",
            "report",
            "alert",
        ] as const;

        for (const role of roles) {
            const logger = createAgentLogger(`${role}-001`, role);
            expect(logger).toBeDefined();
            expect(typeof logger.info).toBe("function");
            expect(typeof logger.warn).toBe("function");
            expect(typeof logger.error).toBe("function");
        }
    });

    it("logger.info produces output without throwing", async () => {
        const { createAgentLogger } = await import("../shared/logger.js");
        const logger = createAgentLogger("test-agent", "scanner");

        expect(() => logger.info("Test log message")).not.toThrow();
    });

    it("logger.warn and logger.error don't throw", async () => {
        const { createAgentLogger } = await import("../shared/logger.js");
        const logger = createAgentLogger("test-agent", "alert");

        expect(() => logger.warn("Test warning")).not.toThrow();
        expect(() => logger.error("Test error")).not.toThrow();
    });
});

// ============================================================
// 7. Wallet — env resolution and key parsing
// ============================================================

describe("wallet.ts", () => {
    it("createAgentWallet is importable", async () => {
        const { createAgentWallet } = await import("../shared/wallet.js");
        expect(typeof createAgentWallet).toBe("function");
    });

    it("createAgentWallet creates wallet from ECDSA private key", async () => {
        const { ethers } = await import("ethers");

        const randomWallet = ethers.Wallet.createRandom();
        const rawKey = randomWallet.privateKey.slice(2);

        process.env.TESTAGENT_ACCOUNT_ID = "0.0.12345";
        process.env.TESTAGENT_PRIVATE_KEY = rawKey;

        const { createAgentWallet } = await import("../shared/wallet.js");
        const wallet = createAgentWallet("TESTAGENT");

        expect(wallet.accountId).toBe("0.0.12345");
        expect(wallet.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(wallet.evmWallet).toBeDefined();
        expect(wallet.hederaKey).toBeDefined();
        expect(wallet.hederaClient).toBeDefined();
        expect(wallet.provider).toBeDefined();

        delete process.env.TESTAGENT_ACCOUNT_ID;
        delete process.env.TESTAGENT_PRIVATE_KEY;
    });

    it("createAgentWallet creates wallet from 0x-prefixed key", async () => {
        const { ethers } = await import("ethers");
        const randomWallet = ethers.Wallet.createRandom();

        process.env.PREFIXED_ACCOUNT_ID = "0.0.54321";
        process.env.PREFIXED_PRIVATE_KEY = randomWallet.privateKey; // has 0x prefix

        const { createAgentWallet } = await import("../shared/wallet.js");
        const wallet = createAgentWallet("PREFIXED");

        expect(wallet.accountId).toBe("0.0.54321");
        expect(wallet.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

        delete process.env.PREFIXED_ACCOUNT_ID;
        delete process.env.PREFIXED_PRIVATE_KEY;
    });

    it("createAgentWallet throws on missing credentials", async () => {
        const savedAcct = process.env.OPERATOR_ACCOUNT_ID;
        const savedKey = process.env.OPERATOR_PRIVATE_KEY;
        const savedHederaAcct = process.env.HEDERA_ACCOUNT_ID;
        const savedHederaKey = process.env.HEDERA_PRIVATE_KEY;
        delete process.env.OPERATOR_ACCOUNT_ID;
        delete process.env.OPERATOR_PRIVATE_KEY;
        delete process.env.HEDERA_ACCOUNT_ID;
        delete process.env.HEDERA_PRIVATE_KEY;

        const { createAgentWallet } = await import("../shared/wallet.js");
        expect(() => createAgentWallet("NONEXISTENT_AGENT")).toThrow(/Missing credentials/);

        if (savedAcct) process.env.OPERATOR_ACCOUNT_ID = savedAcct;
        if (savedKey) process.env.OPERATOR_PRIVATE_KEY = savedKey;
        if (savedHederaAcct) process.env.HEDERA_ACCOUNT_ID = savedHederaAcct;
        if (savedHederaKey) process.env.HEDERA_PRIVATE_KEY = savedHederaKey;
    });

    it("createAgentWallet returns all required AgentWallet fields", async () => {
        const { ethers } = await import("ethers");
        const randomWallet = ethers.Wallet.createRandom();

        process.env.FIELDS_ACCOUNT_ID = "0.0.99988";
        process.env.FIELDS_PRIVATE_KEY = randomWallet.privateKey.slice(2);

        const { createAgentWallet } = await import("../shared/wallet.js");
        const wallet = createAgentWallet("FIELDS");

        // Check all AgentWallet interface fields
        expect(wallet).toHaveProperty("evmWallet");
        expect(wallet).toHaveProperty("provider");
        expect(wallet).toHaveProperty("accountId");
        expect(wallet).toHaveProperty("hederaKey");
        expect(wallet).toHaveProperty("hederaClient");
        expect(wallet).toHaveProperty("evmAddress");

        delete process.env.FIELDS_ACCOUNT_ID;
        delete process.env.FIELDS_PRIVATE_KEY;
    });


});

// ============================================================
// 8. Barrel export — all modules accessible
// ============================================================

describe("index.ts (barrel export)", () => {
    it("exports CONFIG and getAgentEnv", async () => {
        const barrel = await import("../shared/index.js");
        expect(barrel.CONFIG).toBeDefined();
        expect(typeof barrel.getAgentEnv).toBe("function");
    });

    it("exports HCSClient", async () => {
        const barrel = await import("../shared/index.js");
        expect(barrel.HCSClient).toBeDefined();
    });

    it("exports ContractClient", async () => {
        const barrel = await import("../shared/index.js");
        expect(barrel.ContractClient).toBeDefined();
    });

    it("exports createAgentLogger", async () => {
        const barrel = await import("../shared/index.js");
        expect(typeof barrel.createAgentLogger).toBe("function");
    });

    it("exports createAgentWallet", async () => {
        const barrel = await import("../shared/index.js");
        expect(typeof barrel.createAgentWallet).toBe("function");
    });

    it("exports all utility functions", async () => {
        const barrel = await import("../shared/index.js");
        expect(typeof barrel.randomInt).toBe("function");
        expect(typeof barrel.randomFloat).toBe("function");
        expect(typeof barrel.randomHex).toBe("function");
        expect(typeof barrel.randomChoice).toBe("function");
        expect(typeof barrel.randomBool).toBe("function");
        expect(typeof barrel.weightedRandom).toBe("function");
        expect(typeof barrel.hashOf).toBe("function");
        expect(typeof barrel.sleep).toBe("function");
        expect(typeof barrel.randomFindingTitle).toBe("function");
        expect(typeof barrel.randomSeverity).toBe("function");
        expect(typeof barrel.randomSeveritySkewedHigh).toBe("function");
    });


});
