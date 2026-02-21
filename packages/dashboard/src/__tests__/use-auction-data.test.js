import { describe, expect, it } from "vitest";
import { buildAuctionRows } from "../hooks/useAuctionData";

describe("buildAuctionRows", () => {
  it("strict live mode keeps winner-selected jobs visible even after deadline", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "1": { jobId: "1", contractType: "lending", auctionDeadline: nowSec + 40 },
        "2": { jobId: "2", contractType: "dex", auctionDeadline: nowSec - 1 },
        "3": { jobId: "3", contractType: "bridge", auctionDeadline: null },
        "4": { jobId: "4", contractType: "vault", auctionDeadline: nowSec + 10 },
      },
      bids: {},
      winners: {
        "2": { agents: ["0xabc"] },
      },
      activeJobIds: [1n, 2n, 3n, 4n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["2", "4", "1"]);
  });

  it("strict live mode excludes jobs missing from on-chain active ids", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "10": {
          jobId: "10",
          contractType: "lending",
          auctionDeadline: nowSec + 100,
          postedAt: (nowSec * 1000) - 2_000,
        },
      },
      bids: {},
      winners: {},
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["10"]);
  });

  it("strict live mode excludes stale jobs not present in active ids", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "10": {
          jobId: "10",
          contractType: "lending",
          auctionDeadline: nowSec + 100,
          postedAt: (nowSec * 1000) - 120_000,
        },
      },
      bids: {},
      winners: {},
      activeJobIds: [11n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows).toEqual([]);
  });

  it("strict live mode keeps expired jobs if winners exist even when active-id poll is behind", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "42": {
          jobId: "42",
          contractType: "bridge",
          auctionDeadline: nowSec - 5,
          postedAt: (nowSec * 1000) - 120_000,
        },
      },
      bids: {},
      winners: {
        "42": { agents: ["0xabc"] },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["42"]);
  });

  it("mock mode keeps permissive behavior for local/demo streams", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "21": { jobId: "21", contractType: "lending", auctionDeadline: null },
      },
      bids: {},
      winners: {},
      activeJobIds: [],
      useMockEvents: true,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["21"]);
  });
});
