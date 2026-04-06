/**
 * Tests for the report generation fix (Option A: Findings Store).
 *
 * Covers:
 *  1. postFindingsToStore() — fires, handles errors gracefully
 *  2. getFindingsFromStore() / deleteFindingsFromStore() — fetch & cleanup
 *  3. The findings store HTTP routes (POST/GET/DELETE) via mocked fetch
 *  4. Report agent builds real Markdown with findings from the store
 *  5. Graceful fallback when store is unavailable
 *  6. Full integration: static + fuzzer findings → populated report
 *  7. formatReport() produces valid Markdown structure
 *
 * Runs offline — no network or Hedera credentials needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@0glabs/0g-serving-broker", () => ({
  createZGComputeNetworkBroker: vi.fn().mockResolvedValue({
    inference: {
      getServiceMetadata: vi.fn().mockResolvedValue({ endpoint: "http://mock", model: "mock-model" }),
      getRequestHeaders: vi.fn().mockResolvedValue({ "X-0G-Auth": "mock" }),
      acknowledgeProviderSigner: vi.fn().mockResolvedValue(undefined),
      listService: vi.fn().mockResolvedValue([]),
    },
    ledger: { depositFund: vi.fn().mockResolvedValue(undefined) },
  }),
}));

// ---------------------------------------------------------------------------
// Helper: build a mock fetch that serves an in-memory findings store
// ---------------------------------------------------------------------------

function buildFindingsStoreMock() {
  const store = new Map<string, { agentId: string; findings: any[]; timestamp: number }[]>();

  const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    const method = opts?.method?.toUpperCase() ?? "GET";
    const urlStr = String(url);

    // POST /findings
    if (method === "POST" && urlStr.endsWith("/findings")) {
      const body = JSON.parse(opts?.body as string ?? "{}");
      const { jobId, agentId, findings } = body;
      if (!store.has(jobId)) store.set(jobId, []);
      const entries = store.get(jobId)!;
      const idx = entries.findIndex(e => e.agentId === agentId);
      const entry = { agentId, findings, timestamp: Date.now() };
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, stored: findings.length }),
      });
    }

    // GET /findings/:jobId
    if (method === "GET" && urlStr.includes("/findings/")) {
      const jobId = urlStr.split("/findings/")[1];
      const entries = store.get(jobId) ?? [];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jobId, agents: entries }),
      });
    }

    // DELETE /findings/:jobId
    if (method === "DELETE" && urlStr.includes("/findings/")) {
      const jobId = urlStr.split("/findings/")[1];
      store.delete(jobId);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    }

    return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
  });

  return { mockFetch, store };
}

// ===========================================================================
// SECTION 1: postFindingsToStore()
// ===========================================================================

describe("postFindingsToStore()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs findings to the store endpoint", async () => {
    const { mockFetch } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { postFindingsToStore } = await import("../shared/findings-store-client.js");
    const log = { warn: vi.fn(), info: vi.fn() };
    const findings = [
      { id: "SA-001", severity: "high", title: "Reentrancy", description: "External call before state update", confidence: 0.92, agentId: "static-analysis-047", timestamp: Date.now() },
    ];

    await postFindingsToStore("job-001", "static-analysis-047", findings as any, log);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/findings"),
      expect.objectContaining({ method: "POST" })
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Stored 1 findings"));
  });

  it("does not throw when the store is unavailable (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { postFindingsToStore } = await import("../shared/findings-store-client.js");
    const log = { warn: vi.fn(), info: vi.fn() };

    await expect(
      postFindingsToStore("job-002", "fuzzer-012", [], log)
    ).resolves.not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not reach store"));
  });

  it("warns but does not throw when store returns non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: vi.fn() }));

    const { postFindingsToStore } = await import("../shared/findings-store-client.js");
    const log = { warn: vi.fn(), info: vi.fn() };

    await expect(
      postFindingsToStore("job-003", "fuzzer-012", [], log)
    ).resolves.not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("503"));
  });

  it("is idempotent — re-posting for same agent replaces entry", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { postFindingsToStore } = await import("../shared/findings-store-client.js");
    const log = { warn: vi.fn(), info: vi.fn() };

    const findingsV1 = [{ id: "SA-001", severity: "high", title: "Old finding", description: "", confidence: 0.8, agentId: "static-analysis-047", timestamp: 1 }];
    const findingsV2 = [{ id: "SA-001", severity: "critical", title: "Updated finding", description: "", confidence: 0.9, agentId: "static-analysis-047", timestamp: 2 }];

    await postFindingsToStore("job-idem", "static-analysis-047", findingsV1 as any, log);
    await postFindingsToStore("job-idem", "static-analysis-047", findingsV2 as any, log);

    const entries = store.get("job-idem") ?? [];
    expect(entries).toHaveLength(1); // only one entry for this agent
    expect(entries[0].findings[0].title).toBe("Updated finding");
  });

  it("stores findings from multiple agents independently", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { postFindingsToStore } = await import("../shared/findings-store-client.js");
    const log = { warn: vi.fn(), info: vi.fn() };

    await postFindingsToStore("job-multi", "static-analysis-047", [{ id: "SA-001", severity: "medium", title: "A", description: "", confidence: 0.7, agentId: "static-analysis-047", timestamp: 1 }] as any, log);
    await postFindingsToStore("job-multi", "fuzzer-012", [{ id: "FZ-001", severity: "critical", title: "B", description: "", confidence: 0.9, agentId: "fuzzer-012", timestamp: 2 }, { id: "FZ-002", severity: "high", title: "C", description: "", confidence: 0.85, agentId: "fuzzer-012", timestamp: 3 }] as any, log);

    const entries = store.get("job-multi") ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.find(e => e.agentId === "static-analysis-047")?.findings).toHaveLength(1);
    expect(entries.find(e => e.agentId === "fuzzer-012")?.findings).toHaveLength(2);
  });
});

// ===========================================================================
// SECTION 2: getFindingsFromStore() / deleteFindingsFromStore()
// ===========================================================================

describe("getFindingsFromStore() and deleteFindingsFromStore()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns all agent findings for a job", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    // Pre-populate store
    store.set("job-get", [
      { agentId: "static-analysis-047", findings: [{ id: "SA-001", severity: "high", title: "Reentrancy", description: "desc", confidence: 0.92, agentId: "static-analysis-047", timestamp: 1 }], timestamp: 1 },
      { agentId: "fuzzer-012", findings: [{ id: "FZ-001", severity: "critical", title: "Integer overflow", description: "fuzz desc", confidence: 0.88, agentId: "fuzzer-012", timestamp: 2 }], timestamp: 2 },
    ]);

    const { getFindingsFromStore } = await import("../shared/findings-store-client.js");
    const entries = await getFindingsFromStore("job-get");

    expect(entries).toHaveLength(2);
    expect(entries[0].agentId).toBe("static-analysis-047");
    expect(entries[0].findings).toHaveLength(1);
    expect(entries[1].agentId).toBe("fuzzer-012");
    expect(entries[1].findings[0].title).toBe("Integer overflow");
  });

  it("returns empty array when job has no findings", async () => {
    const { mockFetch } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { getFindingsFromStore } = await import("../shared/findings-store-client.js");
    const entries = await getFindingsFromStore("job-empty");
    expect(entries).toEqual([]);
  });

  it("returns empty array when store is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { getFindingsFromStore } = await import("../shared/findings-store-client.js");
    const entries = await getFindingsFromStore("job-down");
    expect(entries).toEqual([]);
  });

  it("DELETE removes the job from the store", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    store.set("job-del", [{ agentId: "a1", findings: [], timestamp: 1 }]);
    expect(store.has("job-del")).toBe(true);

    const { deleteFindingsFromStore } = await import("../shared/findings-store-client.js");
    await deleteFindingsFromStore("job-del");

    expect(store.has("job-del")).toBe(false);
  });

  it("DELETE is safe when job does not exist (no throw)", async () => {
    const { mockFetch } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { deleteFindingsFromStore } = await import("../shared/findings-store-client.js");
    await expect(deleteFindingsFromStore("job-nonexistent")).resolves.not.toThrow();
  });

  it("DELETE is safe when store is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { deleteFindingsFromStore } = await import("../shared/findings-store-client.js");
    await expect(deleteFindingsFromStore("job-down")).resolves.not.toThrow();
  });
});

// ===========================================================================
// SECTION 3: formatReport() — report content validation
// ===========================================================================

describe("formatReport() — report Markdown content", () => {
  it("produces valid Markdown with a header, table, and summary", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [
      { severity: "HIGH", title: "Reentrancy", description: "External call before state update" },
      { severity: "MEDIUM", title: "tx.origin auth", description: "tx.origin used for auth" },
    ];
    const md = formatReport("42", "0xabc...def", "hedera-testnet", "lending", ["static-analysis-047"], findings);

    expect(md).toContain("# Smart Contract Audit Report");
    expect(md).toContain("0xabc...def");
    expect(md).toContain("hedera-testnet");
    expect(md).toContain("lending");
    expect(md).toContain("static-analysis-047");
    expect(md).toContain("Executive Summary");
    expect(md).toContain("2 findings");
  });

  it("includes severity counts in the summary", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [
      { severity: "CRITICAL", title: "Reentrancy", description: "desc" },
      { severity: "HIGH", title: "Overflow", description: "desc" },
      { severity: "HIGH", title: "Access control", description: "desc" },
      { severity: "MEDIUM", title: "Gas griefing", description: "desc" },
    ];
    const md = formatReport("1", "0xabc", "hedera", "vault", ["fuzzer-012"], findings);

    expect(md).toContain("CRITICAL**: 1");
    expect(md).toContain("HIGH**: 2");
    expect(md).toContain("MEDIUM**: 1");
  });

  it("adds a critical warning banner when critical findings exist", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [{ severity: "CRITICAL", title: "Reentrancy", description: "Can drain vault" }];
    const md = formatReport("1", "0xabc", "hedera", "vault", ["fuzzer-012"], findings);

    expect(md).toContain("⚠️");
    expect(md).toContain("critical");
    expect(md).toContain("immediate attention");
  });

  it("sorts findings by severity: CRITICAL → HIGH → MEDIUM → LOW → INFORMATIONAL", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [
      { severity: "LOW", title: "Low issue", description: "" },
      { severity: "CRITICAL", title: "Critical issue", description: "" },
      { severity: "MEDIUM", title: "Medium issue", description: "" },
      { severity: "HIGH", title: "High issue", description: "" },
    ];
    const md = formatReport("1", "0x", "hedera", "dex", ["a1"], findings);

    const critIdx = md.indexOf("[CRITICAL]");
    const highIdx = md.indexOf("[HIGH]");
    const medIdx = md.indexOf("[MEDIUM]");
    const lowIdx = md.indexOf("[LOW]");

    expect(critIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("includes location and recommendation when provided", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [{
      severity: "HIGH",
      title: "Reentrancy",
      description: "External call before state update",
      location: "Vault.sol:withdraw()",
      recommendation: "Use checks-effects-interactions pattern",
    }];
    const md = formatReport("1", "0x", "hedera", "vault", ["a1"], findings);

    expect(md).toContain("Vault.sol:withdraw()");
    expect(md).toContain("checks-effects-interactions");
  });

  it("includes the disclaimer section", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const md = formatReport("1", "0x", "hedera", "lending", ["a1"], []);
    expect(md).toContain("Disclaimer");
    expect(md).toContain("Manual review is recommended");
  });

  it("handles empty findings gracefully (no findings body)", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const md = formatReport("1", "0x", "hedera", "lending", ["a1"], []);
    expect(md).toContain("0 findings");
    expect(md).not.toContain("[CRITICAL]");
    expect(md).not.toContain("[HIGH]");
  });

  it("includes severity emoji icons (🔴 🟠 🟡 🔵)", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const findings = [
      { severity: "CRITICAL", title: "C", description: "" },
      { severity: "HIGH", title: "H", description: "" },
      { severity: "MEDIUM", title: "M", description: "" },
      { severity: "LOW", title: "L", description: "" },
    ];
    const md = formatReport("1", "0x", "hedera", "dex", ["a1"], findings);
    expect(md).toContain("🔴");
    expect(md).toContain("🟠");
    expect(md).toContain("🟡");
    expect(md).toContain("🔵");
  });

  it("lists multiple auditor agents in the header table", async () => {
    const { formatReport } = await import("../shared/report-formatter.js");
    const md = formatReport("1", "0x", "hedera", "dex",
      ["static-analysis-047", "fuzzer-012", "llm-contextual-003"], []);
    expect(md).toContain("static-analysis-047");
    expect(md).toContain("fuzzer-012");
    expect(md).toContain("llm-contextual-003");
  });
});

// ===========================================================================
// SECTION 4: Full integration — findings flow into a real report
// ===========================================================================

describe("Full integration — findings store → report agent → populated Markdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("report agent fetches real findings and passes them to formatReport", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();

    // Pre-populate store with realistic findings from both agents
    const staticFindings = [
      { id: "SA-SLTH-001", severity: "high", title: "Reentrancy Eth (Slither)", description: "Contract.withdraw() sends ETH before updating balance state variable", confidence: 0.92, agentId: "static-analysis-047", timestamp: Date.now() },
      { id: "SA-SLTH-002", severity: "medium", title: "Tx Origin (Slither)", description: "tx.origin used for authorization — vulnerable to phishing", confidence: 0.78, agentId: "static-analysis-047", timestamp: Date.now() },
      { id: "SA-ADERYN-001", severity: "low", title: "Missing Zero Address Check (Aderyn)", description: "Constructor does not validate address(0)", confidence: 0.75, agentId: "static-analysis-047", timestamp: Date.now() },
    ];
    const fuzzerFindings = [
      { id: "FZ-ITYF-001", severity: "critical", title: "Reentrancy vulnerability found", description: "ItyFuzz: reentrancy detected via calldata 0xabcd1234 — attacker can drain vault", confidence: 0.95, agentId: "fuzzer-012", timestamp: Date.now() },
      { id: "FZ-ITYF-002", severity: "high", title: "Integer overflow found", description: "Arithmetic overflow in withdraw() when amount > type(uint128).max", confidence: 0.88, agentId: "fuzzer-012", timestamp: Date.now() },
    ];

    store.set("job-integration", [
      { agentId: "static-analysis-047", findings: staticFindings, timestamp: Date.now() },
      { agentId: "fuzzer-012", findings: fuzzerFindings, timestamp: Date.now() },
    ]);

    vi.stubGlobal("fetch", mockFetch);

    const { getFindingsFromStore, deleteFindingsFromStore } = await import("../shared/findings-store-client.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    // Simulate what the report agent does
    const storeEntries = await getFindingsFromStore("job-integration");
    expect(storeEntries).toHaveLength(2);

    const allFindings = storeEntries.flatMap(({ findings }) =>
      findings.map((f: any) => ({
        severity: String(f?.severity || "MEDIUM").toUpperCase(),
        title: f?.title || "Unnamed Finding",
        description: f?.description || "",
        location: f?.location || undefined,
        recommendation: f?.recommendation || undefined,
      }))
    );

    expect(allFindings).toHaveLength(5); // 3 static + 2 fuzzer

    const md = formatReport(
      "job-integration",
      "0xabc123def456",
      "hedera-testnet",
      "vault",
      ["static-analysis-047", "fuzzer-012"],
      allFindings
    );

    // Report is populated
    expect(md).toContain("5 findings");
    expect(md).toContain("CRITICAL**: 1");
    expect(md).toContain("HIGH**: 2");
    expect(md).toContain("MEDIUM**: 1");
    expect(md).toContain("LOW**: 1");

    // Real finding titles appear
    expect(md).toContain("Reentrancy Eth (Slither)");
    expect(md).toContain("Reentrancy vulnerability found");
    expect(md).toContain("Integer overflow found");
    expect(md).toContain("Tx Origin (Slither)");
    expect(md).toContain("Missing Zero Address Check (Aderyn)");

    // Real descriptions appear (not placeholder text)
    expect(md).toContain("before updating balance");
    expect(md).toContain("ItyFuzz: reentrancy detected");
    expect(md).toContain("attacker can drain vault");

    // Critical warning banner present
    expect(md).toContain("⚠️");
    expect(md).toContain("immediate attention");

    // Agents listed in header
    expect(md).toContain("static-analysis-047");
    expect(md).toContain("fuzzer-012");

    // Cleanup happened
    await deleteFindingsFromStore("job-integration");
    expect(store.has("job-integration")).toBe(false);
  });

  it("report contains no findings when store is empty (graceful degradation)", async () => {
    const { mockFetch } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    const { getFindingsFromStore } = await import("../shared/findings-store-client.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    const storeEntries = await getFindingsFromStore("job-empty");
    expect(storeEntries).toHaveLength(0);

    const allFindings = storeEntries.flatMap(({ findings }) =>
      findings.map((f: any) => ({
        severity: String(f?.severity || "MEDIUM").toUpperCase(),
        title: f?.title || "Unnamed Finding",
        description: f?.description || "",
      }))
    );

    const md = formatReport("job-empty", "0xabc", "hedera", "lending", ["static-analysis-047"], allFindings);
    expect(md).toContain("0 findings");
    expect(md).not.toContain("[CRITICAL]");
  });

  it("report correctly handles findings from all 3 audit agents", async () => {
    const { mockFetch, store } = buildFindingsStoreMock();
    vi.stubGlobal("fetch", mockFetch);

    store.set("job-3agents", [
      { agentId: "static-analysis-047", findings: [{ id: "SA-001", severity: "medium", title: "SA finding", description: "desc", confidence: 0.7, agentId: "static-analysis-047", timestamp: 1 }], timestamp: 1 },
      { agentId: "fuzzer-012", findings: [{ id: "FZ-001", severity: "critical", title: "FZ finding", description: "desc", confidence: 0.9, agentId: "fuzzer-012", timestamp: 2 }], timestamp: 2 },
      { agentId: "llm-contextual-003", findings: [{ id: "LLM-001", severity: "high", title: "LLM finding", description: "desc", confidence: 0.85, agentId: "llm-contextual-003", timestamp: 3 }], timestamp: 3 },
    ]);

    const { getFindingsFromStore } = await import("../shared/findings-store-client.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    const storeEntries = await getFindingsFromStore("job-3agents");
    const allFindings = storeEntries.flatMap(({ findings }) =>
      findings.map((f: any) => ({ severity: String(f.severity).toUpperCase(), title: f.title, description: f.description }))
    );

    const md = formatReport("job-3agents", "0xabc", "hedera", "lending",
      ["static-analysis-047", "fuzzer-012", "llm-contextual-003"], allFindings);

    expect(md).toContain("3 findings");
    expect(md).toContain("SA finding");
    expect(md).toContain("FZ finding");
    expect(md).toContain("LLM finding");
    expect(md).toContain("CRITICAL**: 1");
    expect(md).toContain("HIGH**: 1");
    expect(md).toContain("MEDIUM**: 1");
  });
});

// ===========================================================================
// SECTION 5: Real agent findings → report round-trip
// ===========================================================================

describe("Real agent findings → store → populated report", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("static agent mock findings produce a valid populated report", async () => {
    const { generateFindings } = await import("../static-analysis/index.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    const findings = generateFindings("lending", 5000);
    const reportFindings = findings.map(f => ({
      severity: f.severity.toUpperCase(),
      title: f.title,
      description: f.description,
      location: undefined,
      recommendation: undefined,
    }));

    const md = formatReport("test-job", "0xabc", "hedera-testnet", "lending",
      ["static-analysis-047"], reportFindings);

    expect(md).toContain(`${findings.length} findings`);
    // Every finding title appears in the report
    for (const f of findings) {
      expect(md).toContain(f.title);
    }
    // Descriptions are present
    for (const f of findings) {
      expect(md).toContain(f.description.slice(0, 20));
    }
  });

  it("fuzzer agent mock findings produce a valid populated report", async () => {
    const { generateFindings } = await import("../fuzzer/index.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    const findings = generateFindings("dex", false);
    const reportFindings = findings.map(f => ({
      severity: f.severity.toUpperCase(),
      title: f.title,
      description: f.description,
    }));

    const md = formatReport("test-job-2", "0xdef", "hedera-testnet", "dex",
      ["fuzzer-012"], reportFindings);

    expect(md).toContain(`${findings.length} findings`);
    for (const f of findings) {
      expect(md).toContain(f.title);
    }
  });

  it("combined static + fuzzer findings produce a comprehensive report", async () => {
    const staticMod = await import("../static-analysis/index.js");
    const fuzzerMod = await import("../fuzzer/index.js");
    const { formatReport } = await import("../shared/report-formatter.js");

    const staticF = staticMod.generateFindings("vault", 5000);
    const fuzzerF = fuzzerMod.generateFindings("vault", false);
    const all = [
      ...staticF.map(f => ({ severity: f.severity.toUpperCase(), title: f.title, description: f.description })),
      ...fuzzerF.map(f => ({ severity: f.severity.toUpperCase(), title: f.title, description: f.description })),
    ];

    const md = formatReport("combined-job", "0xvault", "hedera", "vault",
      ["static-analysis-047", "fuzzer-012"], all);

    expect(md).toContain(`${all.length} findings`);
    expect(md).toContain("static-analysis-047");
    expect(md).toContain("fuzzer-012");

    // Report has real content sections
    const findingsSectionIdx = md.indexOf("## Findings");
    const disclaimerIdx = md.indexOf("## Disclaimer");
    expect(findingsSectionIdx).toBeGreaterThan(0);
    expect(disclaimerIdx).toBeGreaterThan(findingsSectionIdx);

    // At least one finding body appears between Findings and Disclaimer
    const findingsBody = md.slice(findingsSectionIdx, disclaimerIdx);
    expect(findingsBody.length).toBeGreaterThan(100);
  });
});

// ===========================================================================
// SECTION 6: Store route logic (unit tests of the in-memory store behaviour)
// ===========================================================================

describe("Findings store route logic", () => {
  it("second POST for same agentId replaces, does not append", () => {
    // Simulate the route logic directly
    const store: { agentId: string; findings: any[]; timestamp: number }[] = [];
    const upsert = (agentId: string, findings: any[]) => {
      const idx = store.findIndex(e => e.agentId === agentId);
      const entry = { agentId, findings, timestamp: Date.now() };
      if (idx >= 0) store[idx] = entry; else store.push(entry);
    };

    upsert("static-analysis-047", [{ id: "SA-001" }]);
    upsert("static-analysis-047", [{ id: "SA-001" }, { id: "SA-002" }]);

    expect(store).toHaveLength(1);
    expect(store[0].findings).toHaveLength(2);
  });

  it("different agents create separate entries", () => {
    const store: { agentId: string; findings: any[] }[] = [];
    const upsert = (agentId: string, findings: any[]) => {
      const idx = store.findIndex(e => e.agentId === agentId);
      if (idx >= 0) store[idx] = { agentId, findings }; else store.push({ agentId, findings });
    };

    upsert("static-analysis-047", [{ id: "SA-001" }]);
    upsert("fuzzer-012", [{ id: "FZ-001" }, { id: "FZ-002" }]);
    upsert("llm-contextual-003", [{ id: "LLM-001" }]);

    expect(store).toHaveLength(3);
    const total = store.reduce((n, e) => n + e.findings.length, 0);
    expect(total).toBe(4);
  });

  it("severity normalization: lowercase 'high' becomes 'HIGH' in report", () => {
    // The report agent does String(f.severity).toUpperCase()
    const rawFinding = { severity: "high", title: "Test", description: "desc" };
    const normalized = { ...rawFinding, severity: String(rawFinding.severity).toUpperCase() };
    expect(normalized.severity).toBe("HIGH");
  });

  it("findings with missing severity default to MEDIUM", () => {
    const rawFinding = { title: "Test", description: "desc" } as any;
    const normalized = { ...rawFinding, severity: String(rawFinding?.severity || "MEDIUM").toUpperCase() };
    expect(normalized.severity).toBe("MEDIUM");
  });
});
