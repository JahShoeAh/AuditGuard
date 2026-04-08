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
        "2": { agents: ["0xabc"], winnersAt: (nowSec * 1000) - 10_000 },
      },
      activeJobIds: [1n, 2n, 3n, 4n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["2", "4", "1", "3"]);
  });

  it("pins winner-selected rows to top and orders them by newest winner timestamp", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "1": { jobId: "1", contractType: "lending", auctionDeadline: nowSec + 60 },
        "2": { jobId: "2", contractType: "dex", auctionDeadline: nowSec - 10 },
        "3": { jobId: "3", contractType: "bridge", auctionDeadline: nowSec - 20 },
        "4": { jobId: "4", contractType: "vault", auctionDeadline: nowSec + 5 },
      },
      bids: {},
      winners: {
        "2": { agents: ["0xbbb"], winnersAt: (nowSec * 1000) - 15_000 },
        "3": { agents: ["0xccc"], winnersAt: (nowSec * 1000) - 3_000 },
      },
      activeJobIds: [1n, 2n, 3n, 4n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["3", "2", "4", "1"]);
  });

  it("strict live mode removes winner-selected rows after winner TTL expires", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "2": { jobId: "2", contractType: "dex", auctionDeadline: nowSec - 1 },
      },
      bids: {},
      winners: {
        "2": { agents: ["0xabc"], winnersAt: (nowSec * 1000) - 601_000 },
      },
      activeJobIds: [2n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows).toEqual([]);
  });

  it("strict live mode uses winner TTL precedence over completed grace window", () => {
    const nowSec = 1_700_000_000;
    const withinWinnerTtl = buildAuctionRows({
      activeJobs: {
        "51": {
          jobId: "51",
          contractType: "lending",
          auctionDeadline: nowSec - 30,
          terminalStatus: "completed",
          endedAt: (nowSec * 1000) - 30_000,
        },
      },
      bids: {},
      winners: {
        "51": { agents: ["0xabc"], winnersAt: (nowSec * 1000) - 15_000 },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });
    const outsideWinnerTtl = buildAuctionRows({
      activeJobs: {
        "52": {
          jobId: "52",
          contractType: "lending",
          auctionDeadline: nowSec - 30,
          terminalStatus: "completed",
          endedAt: (nowSec * 1000) - 30_000,
        },
      },
      bids: {},
      winners: {
        "52": { agents: ["0xabc"], winnersAt: (nowSec * 1000) - 601_000 },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(withinWinnerTtl.map((r) => r.job.jobId)).toEqual(["51"]);
    expect(outsideWinnerTtl).toEqual([]);
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

  it("strict live mode keeps future-deadline jobs even when active ids are stale", () => {
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

    expect(rows.map((r) => r.job.jobId)).toEqual(["10"]);
  });

  it("strict live mode fail-closes rows with no deadline when not active/recent", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "12": {
          jobId: "12",
          contractType: "lending",
          auctionDeadline: null,
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

  it("strict live mode keeps expired known jobs visible while on-chain active ids still include them", () => {
    const nowSec = 1_700_000_000;
    const rows = buildAuctionRows({
      activeJobs: {
        "19": {
          jobId: "19",
          contractType: "lending",
          auctionDeadline: nowSec - 120,
          postedAt: (nowSec * 1000) - 240_000,
        },
      },
      bids: {},
      winners: {},
      activeJobIds: [19n],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["19"]);
  });

  it("strict live mode keeps just-expired auctions briefly while winner state hydrates", () => {
    const nowSec = 1_700_000_000;
    const withinGraceRows = buildAuctionRows({
      activeJobs: {
        "31": {
          jobId: "31",
          contractType: "staking",
          auctionDeadline: nowSec - 10,
          postedAt: (nowSec * 1000) - 180_000,
        },
      },
      bids: {},
      winners: {},
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });
    const outsideGraceRows = buildAuctionRows({
      activeJobs: {
        "32": {
          jobId: "32",
          contractType: "staking",
          auctionDeadline: nowSec - 45,
          postedAt: (nowSec * 1000) - 180_000,
        },
      },
      bids: {},
      winners: {},
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(withinGraceRows.map((r) => r.job.jobId)).toEqual(["31"]);
    expect(outsideGraceRows).toEqual([]);
  });

  it("strict live mode keeps expired auctions with bids visible longer while winner state catches up", () => {
    const nowSec = 1_700_000_000;
    const withinBidGraceRows = buildAuctionRows({
      activeJobs: {
        "35": {
          jobId: "35",
          contractType: "staking",
          auctionDeadline: nowSec - 45,
          postedAt: (nowSec * 1000) - 180_000,
        },
      },
      bids: {
        "35": [
          { agent: "0xabc", bidAmount: 33.6, timestamp: (nowSec * 1000) - 50_000 },
        ],
      },
      winners: {},
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });
    const outsideBidGraceRows = buildAuctionRows({
      activeJobs: {
        "36": {
          jobId: "36",
          contractType: "staking",
          auctionDeadline: nowSec - 130,
          postedAt: (nowSec * 1000) - 180_000,
        },
      },
      bids: {
        "36": [
          { agent: "0xdef", bidAmount: 21, timestamp: (nowSec * 1000) - 150_000 },
        ],
      },
      winners: {},
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(withinBidGraceRows.map((r) => r.job.jobId)).toEqual(["35"]);
    expect(outsideBidGraceRows).toEqual([]);
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
        "42": { agents: ["0xabc"], winnersAt: (nowSec * 1000) - 5_000 },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(rows.map((r) => r.job.jobId)).toEqual(["42"]);
  });

  it("strict live mode falls back to endedAt when winnersAt is missing", () => {
    const nowSec = 1_700_000_000;
    const withinFallback = buildAuctionRows({
      activeJobs: {
        "61": {
          jobId: "61",
          contractType: "vault",
          auctionDeadline: nowSec - 30,
          terminalStatus: "completed",
          endedAt: (nowSec * 1000) - 12_000,
        },
      },
      bids: {},
      winners: {
        "61": { agents: ["0xabc"] },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });
    const outsideFallback = buildAuctionRows({
      activeJobs: {
        "62": {
          jobId: "62",
          contractType: "vault",
          auctionDeadline: nowSec - 30,
          terminalStatus: "completed",
          endedAt: (nowSec * 1000) - 601_000,
        },
      },
      bids: {},
      winners: {
        "62": { agents: ["0xabc"] },
      },
      activeJobIds: [],
      useMockEvents: false,
      nowSec,
    });

    expect(withinFallback.map((r) => r.job.jobId)).toEqual(["61"]);
    expect(outsideFallback).toEqual([]);
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
