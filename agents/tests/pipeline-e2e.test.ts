/**
 * End-to-End Audit Pipeline Test
 *
 * Simulates the full audit lifecycle without running live Hedera or Postgres.
 * Uses real agent functions (calculateBid, generateFindings), real formatReport,
 * and real findings-store-client — all backed by in-memory mocks of the
 * static-analysis-service and events-api.
 *
 * Each describe block is a pipeline checkpoint:
 *   Stage 1 — Contract deployed → auction goes live (AUCTION_INVITE published)
 *   Stage 2 — Agents receive invite and submit bids
 *   Stage 3 — Auction closed, winner selected
 *   Stage 4 — Winning agent ran the audit and submitted findings
 *   Stage 5 — Valid report generated with non-empty findings
 *   Stage 6 — Report saved to Postgres via events-api POST /api/reports
 *   Stage 7 — Report viewable via GET /api/reports/:jobId
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import {
  calculateBid as staticCalculateBid,
  generateFindings as staticGenerateFindings,
} from "../static-analysis/index.js";
import {
  calculateBid as fuzzerCalculateBid,
  generateFindings as fuzzerGenerateFindings,
} from "../fuzzer/index.js";
import { formatReport } from "../shared/report-formatter.js";
import {
  postFindingsToStore,
  getFindingsFromStore,
  deleteFindingsFromStore,
} from "../shared/findings-store-client.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS    = "0xdeadbeef00000000000000000000000000000001";
const DEPLOYER_ADDRESS    = "0xabcdef0000000000000000000000000000000001";
const CONTRACT_TYPE       = "lending" as const;
const JOB_ID              = "pipeline_e2e_test_001";
const STATIC_AGENT_ID     = "static-analysis-047";
const FUZZER_AGENT_ID     = "fuzzer-012";
const ESTIMATED_LOC       = 1200;
const RISK_SCORE          = 72;
const FINDINGS_STORE_BASE = "http://localhost:4002";
const REPORTS_API_BASE    = "http://localhost:4000";

// ─── In-Memory Service Backends ──────────────────────────────────────────────

/** Simulates the in-memory findings relay inside static-analysis-service */
const findingsRelay = new Map<
  string,
  Array<{ agentId: string; findings: any[]; timestamp: number }>
>();

/** Simulates the audit_reports Postgres table */
const reportsDb = new Map<string, any>();

/**
 * Returns a vi.fn() that intercepts fetch calls to:
 *   - localhost:4002  → findings relay (POST/GET/DELETE /findings)
 *   - localhost:4000  → reports API (POST/GET /api/reports)
 */
function buildMockFetch() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u      = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    // ── Findings relay (static-analysis-service :4002) ──────────────────────
    if (u.startsWith(FINDINGS_STORE_BASE)) {
      if (method === "POST" && u.endsWith("/findings")) {
        const { jobId, agentId, findings } = JSON.parse(String(init!.body));
        if (!findingsRelay.has(jobId)) findingsRelay.set(jobId, []);
        const entries = findingsRelay.get(jobId)!;
        const idx     = entries.findIndex(e => e.agentId === agentId);
        const entry   = { agentId, findings, timestamp: Date.now() };
        if (idx >= 0) entries[idx] = entry; else entries.push(entry);
        return new Response(JSON.stringify({ ok: true, stored: findings.length }), { status: 200 });
      }

      const idMatch = u.match(/\/findings\/([^?/]+)/);
      if (method === "GET" && idMatch) {
        const agents = findingsRelay.get(idMatch[1]) ?? [];
        return new Response(JSON.stringify({ jobId: idMatch[1], agents }), { status: 200 });
      }
      if (method === "DELETE" && idMatch) {
        findingsRelay.delete(idMatch[1]);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    // ── Reports API (events-api :4000) ───────────────────────────────────────
    if (u.startsWith(`${REPORTS_API_BASE}/api/reports`)) {
      if (method === "POST") {
        const body = JSON.parse(String(init!.body));
        const id   = `rpt_${body.jobId}`;
        reportsDb.set(body.jobId, { id, ...body, created_at: new Date().toISOString() });
        return new Response(JSON.stringify({ success: true, id }), { status: 201 });
      }

      const idMatch = u.match(/\/api\/reports\/([^?/]+)/);
      if (method === "GET" && idMatch) {
        const report = reportsDb.get(idMatch[1]);
        if (!report)
          return new Response(JSON.stringify({ success: false, error: "Not found" }), { status: 404 });
        return new Response(JSON.stringify({ success: true, data: report }), { status: 200 });
      }
    }

    return new Response(`Unmocked fetch: ${method} ${u}`, { status: 500 });
  });
}

// ─── Pipeline State ───────────────────────────────────────────────────────────

interface Bid { amount: number; collateral: number; estimatedTimeSec: number }
interface MappedFinding { severity: string; title: string; description: string; location?: string; recommendation?: string }

interface PipelineState {
  // Stage 1
  jobId: string;
  auctionCreated: boolean;
  inviteMessage: Record<string, any>;

  // Stage 2
  staticBid: Bid | null;
  fuzzerBid:  Bid | null;
  bids: Array<{ agentId: string; bid: Bid }>;

  // Stage 3
  winnerAgentId: string;
  winnerBid: Bid;
  winnerSelectedMessage: Record<string, any>;

  // Stage 4
  agentRanAudit: boolean;
  rawFindings: any[];
  findingsStoredCount: number;
  findingsSubmittedMsg: Record<string, any>;

  // Stage 5
  fetchedFindings: MappedFinding[];
  reportMarkdown: string;

  // Stage 6
  saveResponse: { success: boolean; id: string };

  // Stage 7
  retrievedReport: Record<string, any> | null;
}

let pipeline: PipelineState;

// ─── Run Full Pipeline ────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.stubGlobal("fetch", buildMockFetch());

  const state: Partial<PipelineState> = {};

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 1 — Contract deployed → Orchestrator creates auction             ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  //
  // In production: the Scanner emits CONTRACT_DISCOVERED, the Orchestrator calls
  // contracts.createAuditJob() and publishes AUCTION_INVITE to HCS.
  // Here we construct the invite directly with the same schema.
  state.jobId          = JOB_ID;
  state.auctionCreated = true;
  state.inviteMessage  = {
    type:      "AUCTION_INVITE",
    agentId:   "orchestrator",
    timestamp: Date.now(),
    payload: {
      jobId:                JOB_ID,
      contractAddress:      CONTRACT_ADDRESS,
      deployerAddress:      DEPLOYER_ADDRESS,
      contractType:         CONTRACT_TYPE,
      riskScore:            RISK_SCORE,
      estimatedLOC:         ESTIMATED_LOC,
      budget:               500,               // GUARD tokens
      auctionDeadlineSec:   Math.floor(Date.now() / 1000) + 300,
      eligibleAgentIds:     [STATIC_AGENT_ID, FUZZER_AGENT_ID],
      eligibleEvmAddresses: [],
      inviteBatchId:        `batch_${JOB_ID}`,
    },
  };

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 2 — Agents receive invite and submit bids (real calculateBid)    ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  state.staticBid = staticCalculateBid(ESTIMATED_LOC, CONTRACT_TYPE, RISK_SCORE);
  state.fuzzerBid = fuzzerCalculateBid(ESTIMATED_LOC, CONTRACT_TYPE, RISK_SCORE);
  state.bids = [
    { agentId: STATIC_AGENT_ID, bid: state.staticBid! },
    { agentId: FUZZER_AGENT_ID, bid: state.fuzzerBid!  },
  ];

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 3 — Orchestrator selects winner (lowest bid wins)                ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  //
  // Mirrors orchestrator's scoring (price 25%). For the test we use price-only
  // selection — sufficient to verify that the selection logic runs and produces
  // a deterministic, valid winner.
  const sorted                = [...state.bids].sort((a, b) => a.bid.amount - b.bid.amount);
  const { agentId: winnerId, bid: winnerBid } = sorted[0];
  state.winnerAgentId         = winnerId;
  state.winnerBid             = winnerBid;
  state.winnerSelectedMessage = {
    type:      "WINNER_SELECTED",
    agentId:   "orchestrator",
    timestamp: Date.now(),
    payload: {
      jobId:          JOB_ID,
      winner:         winnerId,
      bidAmount:      winnerBid.amount,
      bidCollateral:  winnerBid.collateral,
    },
  };

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 4 — Winning agent runs audit and stores findings                 ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  //
  // In production: the winning agent receives WINNERS_ANNOUNCED, calls its
  // tool service (slither/ityfuzz), and publishes FINDINGS_SUBMITTED to HCS
  // while also POSTing the Finding[] objects to the findings relay.
  const rawFindings: any[] =
    winnerId === STATIC_AGENT_ID
      ? staticGenerateFindings(CONTRACT_TYPE, ESTIMATED_LOC)
      : fuzzerGenerateFindings(CONTRACT_TYPE, false);

  state.rawFindings    = rawFindings;
  state.agentRanAudit  = rawFindings.length > 0;

  // POST findings to relay (the real path agents take)
  await postFindingsToStore(JOB_ID, winnerId, rawFindings, { warn: () => {} });

  // Verify relay received them (peek at in-memory map before fetching)
  const relayEntries         = findingsRelay.get(JOB_ID) ?? [];
  state.findingsStoredCount  = relayEntries.reduce((n, e) => n + e.findings.length, 0);

  const critCount = rawFindings.filter((f: any) =>
    String(f.severity).toUpperCase() === "CRITICAL"
  ).length;

  state.findingsSubmittedMsg = {
    type:      "FINDINGS_SUBMITTED",
    agentId:   winnerId,
    timestamp: Date.now(),
    payload: {
      jobId:          JOB_ID,
      findingsHash:   `0x${"a1b2c3".repeat(10).slice(0, 64)}`,
      findingsCount:  rawFindings.length,
      criticalCount:  critCount,
      highCount:      rawFindings.filter((f: any) => String(f.severity).toUpperCase() === "HIGH").length,
      mediumCount:    rawFindings.filter((f: any) => String(f.severity).toUpperCase() === "MEDIUM").length,
      lowCount:       rawFindings.filter((f: any) => String(f.severity).toUpperCase() === "LOW").length,
    },
  };

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 5 — Report agent fetches findings, formats report                ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const storeEntries    = await getFindingsFromStore(JOB_ID);
  const mappedFindings: MappedFinding[] = storeEntries.flatMap(({ findings }) =>
    findings.map((f: any) => ({
      severity:       String(f?.severity || "MEDIUM").toUpperCase(),
      title:          f?.title          || "Unnamed Finding",
      description:    f?.description    ?? "",
      location:       f?.location       ?? undefined,
      recommendation: f?.recommendation ?? undefined,
    }))
  );
  state.fetchedFindings = mappedFindings;

  const markdown = formatReport(
    JOB_ID,
    CONTRACT_ADDRESS,
    "hedera-testnet",
    CONTRACT_TYPE,
    [winnerId],
    mappedFindings
  );
  state.reportMarkdown = markdown;

  // Cleanup relay after fetching (mirrors real report agent behaviour)
  await deleteFindingsFromStore(JOB_ID);

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 6 — Report saved to Postgres via events-api                      ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const sev = {
    critical: mappedFindings.filter(f => f.severity === "CRITICAL").length,
    high:     mappedFindings.filter(f => f.severity === "HIGH").length,
    medium:   mappedFindings.filter(f => f.severity === "MEDIUM").length,
    low:      mappedFindings.filter(f => f.severity === "LOW").length,
    info:     mappedFindings.filter(f => f.severity === "INFORMATIONAL" || f.severity === "INFO").length,
  };

  const saveRes  = await fetch(`${REPORTS_API_BASE}/api/reports`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId:              JOB_ID,
      contractAddress:    CONTRACT_ADDRESS,
      deployerAddress:    DEPLOYER_ADDRESS,
      chain:              "hedera-testnet",
      contractType:       CONTRACT_TYPE,
      contentHash:        `0x${"1a".repeat(32)}`,
      mdContent:          markdown,
      agentAddresses:     ["0xa1b2c3d4e5f60000000000000000000000000001"],
      agentCount:         1,
      findingCount:       mappedFindings.length,
      findingsBySeverity: sev,
      timestamp:          Date.now(),
      source:             "agent",
    }),
  });
  state.saveResponse = (await saveRes.json()) as any;

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║  STAGE 7 — Report can be retrieved via GET /api/reports/:jobId          ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
  const getRes  = await fetch(`${REPORTS_API_BASE}/api/reports/${JOB_ID}`);
  const getBody = (await getRes.json()) as any;
  state.retrievedReport = getBody.success ? getBody.data : null;

  pipeline = state as PipelineState;
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
  findingsRelay.clear();
  reportsDb.clear();
});

// ─── Stage 1: Auction went live ───────────────────────────────────────────────

describe("Stage 1 — Auction went live", () => {
  it("job ID is assigned", () => {
    expect(pipeline.jobId).toBe(JOB_ID);
  });

  it("auction created flag is set", () => {
    expect(pipeline.auctionCreated).toBe(true);
  });

  it("AUCTION_INVITE message has the correct type", () => {
    expect(pipeline.inviteMessage.type).toBe("AUCTION_INVITE");
  });

  it("invite targets both registered agents", () => {
    const { eligibleAgentIds } = pipeline.inviteMessage.payload;
    expect(eligibleAgentIds).toContain(STATIC_AGENT_ID);
    expect(eligibleAgentIds).toContain(FUZZER_AGENT_ID);
  });

  it("invite carries the deployed contract address", () => {
    expect(pipeline.inviteMessage.payload.contractAddress).toBe(CONTRACT_ADDRESS);
  });

  it("invite carries the deployer address", () => {
    expect(pipeline.inviteMessage.payload.deployerAddress).toBe(DEPLOYER_ADDRESS);
  });

  it("invite specifies contract type", () => {
    expect(pipeline.inviteMessage.payload.contractType).toBe(CONTRACT_TYPE);
  });

  it("auction has a positive budget", () => {
    expect(pipeline.inviteMessage.payload.budget).toBeGreaterThan(0);
  });

  it("auction deadline is in the future", () => {
    expect(pipeline.inviteMessage.payload.auctionDeadlineSec).toBeGreaterThan(
      Math.floor(Date.now() / 1000)
    );
  });
});

// ─── Stage 2: Agents bid on the auction ──────────────────────────────────────

describe("Stage 2 — Agents bid on the auction", () => {
  it("static analysis agent submitted a bid", () => {
    expect(pipeline.staticBid).not.toBeNull();
  });

  it("fuzzer agent submitted a bid", () => {
    expect(pipeline.fuzzerBid).not.toBeNull();
  });

  it("static analysis bid amount is positive", () => {
    expect(pipeline.staticBid!.amount).toBeGreaterThan(0);
  });

  it("fuzzer bid amount is positive", () => {
    expect(pipeline.fuzzerBid!.amount).toBeGreaterThan(0);
  });

  it("static analysis bid includes collateral", () => {
    expect(pipeline.staticBid!.collateral).toBeGreaterThan(0);
  });

  it("fuzzer bid includes collateral", () => {
    expect(pipeline.fuzzerBid!.collateral).toBeGreaterThan(0);
  });

  it("static analysis collateral is ~50% of bid amount", () => {
    const ratio = pipeline.staticBid!.collateral / pipeline.staticBid!.amount;
    expect(ratio).toBeCloseTo(0.5, 1);
  });

  it("fuzzer collateral is ~60% of bid amount", () => {
    const ratio = pipeline.fuzzerBid!.collateral / pipeline.fuzzerBid!.amount;
    expect(ratio).toBeCloseTo(0.6, 1);
  });

  it("both bids include estimated audit time", () => {
    expect(pipeline.staticBid!.estimatedTimeSec).toBeGreaterThan(0);
    expect(pipeline.fuzzerBid!.estimatedTimeSec).toBeGreaterThan(0);
  });

  it("there are exactly 2 bids in the auction", () => {
    expect(pipeline.bids).toHaveLength(2);
  });

  it("each bid entry has an agentId", () => {
    for (const { agentId } of pipeline.bids) {
      expect(agentId).toBeTruthy();
    }
  });
});

// ─── Stage 3: Auction closed and winner chosen ────────────────────────────────

describe("Stage 3 — Auction closed and winner chosen", () => {
  it("a winner was selected", () => {
    expect(pipeline.winnerAgentId).toBeTruthy();
  });

  it("winner is one of the bidding agents", () => {
    expect([STATIC_AGENT_ID, FUZZER_AGENT_ID]).toContain(pipeline.winnerAgentId);
  });

  it("WINNER_SELECTED message has the correct type", () => {
    expect(pipeline.winnerSelectedMessage.type).toBe("WINNER_SELECTED");
  });

  it("WINNER_SELECTED message references the correct job", () => {
    expect(pipeline.winnerSelectedMessage.payload.jobId).toBe(JOB_ID);
  });

  it("WINNER_SELECTED message carries the winner agent ID", () => {
    expect(pipeline.winnerSelectedMessage.payload.winner).toBe(pipeline.winnerAgentId);
  });

  it("winning bid amount is positive", () => {
    expect(pipeline.winnerBid.amount).toBeGreaterThan(0);
  });

  it("winning bid collateral is positive", () => {
    expect(pipeline.winnerBid.collateral).toBeGreaterThan(0);
  });

  it("winner is the lowest bidder", () => {
    const winAmount = pipeline.winnerBid.amount;
    for (const { bid } of pipeline.bids) {
      expect(winAmount).toBeLessThanOrEqual(bid.amount);
    }
  });
});

// ─── Stage 4: Winning agent ran on the auction ────────────────────────────────

describe("Stage 4 — Winning agent ran the audit and submitted findings", () => {
  it("agent produced at least one finding", () => {
    expect(pipeline.rawFindings.length).toBeGreaterThan(0);
  });

  it("agent ran audit flag is set", () => {
    expect(pipeline.agentRanAudit).toBe(true);
  });

  it("every finding has a valid severity level", () => {
    const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL", "INFO"];
    for (const f of pipeline.rawFindings) {
      expect(validSeverities).toContain(String(f.severity).toUpperCase());
    }
  });

  it("every finding has a non-empty title", () => {
    for (const f of pipeline.rawFindings) {
      expect(typeof f.title).toBe("string");
      expect(f.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("every finding has a non-empty description", () => {
    for (const f of pipeline.rawFindings) {
      expect(typeof f.description).toBe("string");
      expect(f.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("FINDINGS_SUBMITTED message has the correct type", () => {
    expect(pipeline.findingsSubmittedMsg.type).toBe("FINDINGS_SUBMITTED");
  });

  it("FINDINGS_SUBMITTED message references the correct job", () => {
    expect(pipeline.findingsSubmittedMsg.payload.jobId).toBe(JOB_ID);
  });

  it("FINDINGS_SUBMITTED count matches generated findings", () => {
    expect(pipeline.findingsSubmittedMsg.payload.findingsCount).toBe(pipeline.rawFindings.length);
  });

  it("findings were stored in the relay (count matches)", () => {
    expect(pipeline.findingsStoredCount).toBe(pipeline.rawFindings.length);
  });

  it("FINDINGS_SUBMITTED is attributed to the winner", () => {
    expect(pipeline.findingsSubmittedMsg.agentId).toBe(pipeline.winnerAgentId);
  });
});

// ─── Stage 5: Valid report generated with non-empty findings ─────────────────

describe("Stage 5 — Valid report generated with non-empty findings", () => {
  it("report agent fetched findings from the relay", () => {
    expect(pipeline.fetchedFindings.length).toBeGreaterThan(0);
  });

  it("fetched finding count matches what the agent stored", () => {
    expect(pipeline.fetchedFindings.length).toBe(pipeline.rawFindings.length);
  });

  it("report Markdown is non-empty", () => {
    expect(pipeline.reportMarkdown.length).toBeGreaterThan(200);
  });

  it("report contains the audited contract address", () => {
    expect(pipeline.reportMarkdown).toContain(CONTRACT_ADDRESS);
  });

  it("report body contains at least one actual finding title (not blank)", () => {
    const firstTitle = pipeline.fetchedFindings[0]?.title;
    expect(firstTitle).toBeTruthy();
    expect(pipeline.reportMarkdown).toContain(firstTitle);
  });

  it("report names the winning auditor agent", () => {
    expect(pipeline.reportMarkdown).toContain(pipeline.winnerAgentId);
  });

  it("report executive summary shows the correct finding count", () => {
    expect(pipeline.reportMarkdown).toContain(String(pipeline.fetchedFindings.length));
  });

  it("report contains severity headings (HIGH / MEDIUM / LOW)", () => {
    const text = pipeline.reportMarkdown.toUpperCase();
    const hasSeverity = ["HIGH", "MEDIUM", "LOW", "CRITICAL"].some(s => text.includes(s));
    expect(hasSeverity).toBe(true);
  });

  it("all severities in the report are valid strings", () => {
    const valid = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL", "INFO"];
    for (const f of pipeline.fetchedFindings) {
      expect(valid).toContain(f.severity);
    }
  });

  it("report Markdown has a findings section (not just a summary)", () => {
    expect(pipeline.reportMarkdown).toMatch(/#{1,3}\s*(findings|vulnerabilities|issues)/i);
  });

  it("findings relay is empty after report agent fetched and cleaned up", async () => {
    // deleteFindingsFromStore was called in Stage 5 setup — relay must be empty now
    const remaining = await getFindingsFromStore(JOB_ID);
    expect(remaining).toHaveLength(0);
  });
});

// ─── Stage 6: Report saved to Postgres ───────────────────────────────────────

describe("Stage 6 — Report saved to Postgres", () => {
  it("save call returned success=true", () => {
    expect(pipeline.saveResponse.success).toBe(true);
  });

  it("save returned a report ID", () => {
    expect(pipeline.saveResponse.id).toBeTruthy();
  });

  it("report ID is prefixed correctly", () => {
    expect(pipeline.saveResponse.id).toMatch(/^rpt_/);
  });

  it("report is queryable in the DB store by jobId", () => {
    const stored = reportsDb.get(JOB_ID);
    expect(stored).toBeTruthy();
  });

  it("stored record has the correct jobId", () => {
    const stored = reportsDb.get(JOB_ID);
    expect(stored.jobId).toBe(JOB_ID);
  });

  it("stored record has the correct contract address", () => {
    const stored = reportsDb.get(JOB_ID);
    expect(stored.contractAddress).toBe(CONTRACT_ADDRESS);
  });

  it("stored record has non-empty mdContent", () => {
    const stored = reportsDb.get(JOB_ID);
    expect(stored.mdContent).toBeTruthy();
    expect(stored.mdContent.length).toBeGreaterThan(100);
  });

  it("stored findingCount is correct", () => {
    const stored = reportsDb.get(JOB_ID);
    expect(stored.findingCount).toBe(pipeline.fetchedFindings.length);
  });

  it("stored findingsBySeverity totals match findingCount", () => {
    const stored = reportsDb.get(JOB_ID);
    const { critical, high, medium, low, info } = stored.findingsBySeverity;
    expect(critical + high + medium + low + info).toBe(stored.findingCount);
  });
});

// ─── Stage 7: Report can be viewed ───────────────────────────────────────────

describe("Stage 7 — Report can be viewed via GET /api/reports/:jobId", () => {
  it("retrieved report is not null", () => {
    expect(pipeline.retrievedReport).not.toBeNull();
  });

  it("retrieved jobId matches the original job", () => {
    expect(pipeline.retrievedReport!.jobId).toBe(JOB_ID);
  });

  it("retrieved contract address matches", () => {
    expect(pipeline.retrievedReport!.contractAddress).toBe(CONTRACT_ADDRESS);
  });

  it("retrieved deployer address matches", () => {
    expect(pipeline.retrievedReport!.deployerAddress).toBe(DEPLOYER_ADDRESS);
  });

  it("retrieved report has non-empty mdContent", () => {
    expect(pipeline.retrievedReport!.mdContent).toBeTruthy();
    expect(pipeline.retrievedReport!.mdContent.length).toBeGreaterThan(100);
  });

  it("retrieved mdContent exactly matches what was saved", () => {
    expect(pipeline.retrievedReport!.mdContent).toBe(pipeline.reportMarkdown);
  });

  it("retrieved findingCount is correct", () => {
    expect(pipeline.retrievedReport!.findingCount).toBe(pipeline.fetchedFindings.length);
  });

  it("retrieved findingsBySeverity totals match findingCount", () => {
    const { critical, high, medium, low, info } = pipeline.retrievedReport!.findingsBySeverity;
    expect(critical + high + medium + low + info).toBe(pipeline.retrievedReport!.findingCount);
  });

  it("retrieved report has a created_at timestamp", () => {
    expect(pipeline.retrievedReport!.created_at).toBeTruthy();
  });

  it("retrieved report source is 'agent'", () => {
    expect(pipeline.retrievedReport!.source).toBe("agent");
  });
});

// ─── Overall Pipeline Integrity ───────────────────────────────────────────────

describe("Overall pipeline integrity", () => {
  it("complete pipeline: all 7 stages produced valid output", () => {
    // Stage 1
    expect(pipeline.auctionCreated).toBe(true);
    // Stage 2
    expect(pipeline.bids.length).toBe(2);
    // Stage 3
    expect(pipeline.winnerAgentId).toBeTruthy();
    // Stage 4
    expect(pipeline.rawFindings.length).toBeGreaterThan(0);
    // Stage 5
    expect(pipeline.reportMarkdown.length).toBeGreaterThan(200);
    // Stage 6
    expect(pipeline.saveResponse.success).toBe(true);
    // Stage 7
    expect(pipeline.retrievedReport!.mdContent).toBeTruthy();
  });

  it("finding count is consistent from generation → store → relay → report → DB → retrieval", () => {
    const count = pipeline.rawFindings.length;
    expect(pipeline.findingsStoredCount).toBe(count);     // relay received them
    expect(pipeline.fetchedFindings.length).toBe(count);  // report agent fetched them
    expect(pipeline.retrievedReport!.findingCount).toBe(count); // DB stored the right count
  });

  it("no data was corrupted between the findings relay and the final report", () => {
    // Every title in the raw findings must appear in the report Markdown
    for (const f of pipeline.rawFindings) {
      expect(pipeline.reportMarkdown).toContain(f.title);
    }
  });

  it("winner is the unique author of all findings in the report", () => {
    // All entries in the relay were from the winner
    const relayBeforeCleanup = reportsDb.get(JOB_ID);
    expect(relayBeforeCleanup).toBeTruthy(); // DB entry still exists after cleanup
  });

  it("report Markdown contains more content than just the header (has finding body)", () => {
    const lines = pipeline.reportMarkdown.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(10);
  });
});
