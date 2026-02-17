/**
 * Mock event generator — full Day 2 cycle.
 *
 * Reproduces the spec walkthrough:
 *   Phase 1  (t=0s)  Discovery
 *   Phase 2  (t=5s)  Auction posted
 *   Phase 3  (t=8/12/16s) Three bids
 *   Phase 4  (t=25s) Winner selection + platform fee flow
 *   Phase 5  (t=30s) Sub-auction created
 *   Phase 6  (t=35/40s) Sub-bid + contractor selected
 *   Phase 7  (t=38/44s) Data listing + purchase
 *   Phase 8  (t=50s) Sub-contract delivery + acceptance
 *   Phase 9  (t=60s) Data rating + settlement + GUARD flows
 *   Phase 10 (t=75s) New cycle begins (different contract type)
 *
 * CYCLE_DURATION_MS = 75000
 */

import { parseGuardAmount } from './event-listener';

// ── Constants ─────────────────────────────────────────────

export const CYCLE_DURATION_MS = 75_000;

const CONTRACT_TYPES  = ['lending_protocol', 'dex', 'staking_pool', 'yield_aggregator'];
const CONTRACT_LABELS = { lending_protocol: 'LendingProtocol', dex: 'DEX', staking_pool: 'StakingPool', yield_aggregator: 'YieldAgg' };

// Deterministic agent addresses
const STATIC47_ADDR  = '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f60001';
const FUZZER12_ADDR  = '0xb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a10002';
const LLM3_ADDR      = '0xc3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b20003';
const DEP8_ADDR      = '0xd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c30004';
const TREASURY_ADDR  = '0xe5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d40005';

// Agent profiles
const AGENTS = {
  static47: {
    address: STATIC47_ADDR,
    name: 'StaticAnalysis-47',
    specialization: 'static_analysis',
    reputation: 9400,
    bidGuard: 1_500_000_000n,   // 15 GUARD
    collateral: 5_000_000_000n, // 50 GUARD
    etaSeconds: 720,
  },
  fuzzer12: {
    address: FUZZER12_ADDR,
    name: 'Fuzzer-12',
    specialization: 'fuzzing',
    reputation: 8700,
    bidGuard: 2_200_000_000n,   // 22 GUARD
    collateral: 5_000_000_000n,
    etaSeconds: 2700,
  },
  llm3: {
    address: LLM3_ADDR,
    name: 'LLMContextual-3',
    specialization: 'llm_contextual',
    reputation: 8700,
    bidGuard: 3_500_000_000n,   // 35 GUARD
    collateral: 5_000_000_000n,
    etaSeconds: 7200,
  },
  dep8: {
    address: DEP8_ADDR,
    name: 'DependencyAgent-8',
    specialization: 'dependency_analysis',
    reputation: 6500,
    bidGuard: 300_000_000n,     // 3 GUARD
    collateral: 1_000_000_000n, // 10 GUARD
    etaSeconds: 600,
  },
};

// ── Cycle counters ────────────────────────────────────────

let _jobCounter    = 1;
let _subJobCounter = 1;
let _listingCounter= 1;
let _settleCounter = 1;

// ── Helpers ───────────────────────────────────────────────

const randHex = (bytes = 40) =>
  '0x' + Array.from({ length: bytes * 2 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');

const mockTxHash = () => randHex(32);
const randHexAddr = () => randHex(20);

function mkTx() {
  return {
    hash:        mockTxHash(),
    blockNumber: Math.floor(Math.random() * 900_000) + 100_000,
    receivedAt:  Date.now(),
    finalityMs:  Math.floor(Math.random() * 3000) + 800,
  };
}

// Vary budget/bids slightly between cycles to look organic
function scaleBid(base, variancePercent = 8) {
  const factor = 1 + (Math.random() * 2 - 1) * (variancePercent / 100);
  return BigInt(Math.floor(Number(base) * factor));
}

// ── The full Day 2 cycle ──────────────────────────────────

function runDay2Cycle(getState, cycleIndex) {
  const timeouts = [];
  const schedule = (fn, ms) => timeouts.push(setTimeout(fn, ms));

  // Vary contract type across cycles
  const contractType = CONTRACT_TYPES[cycleIndex % CONTRACT_TYPES.length];
  const contractLabel = CONTRACT_LABELS[contractType] || contractType;

  // Mutable IDs for this cycle
  const jobId     = String(_jobCounter++);
  const subJobId  = String(_subJobCounter++);
  const listingId = String(_listingCounter++);
  const settleId  = String(_settleCounter++);

  const contractAddr = randHexAddr();
  const riskScore    = 55 + Math.floor(cycleIndex * 7 % 30); // 55-84
  const lineCount    = 3500 + cycleIndex * 200;

  // ── Phase 1: Discovery (t=0) ─────────────────────────────
  {
    const s = getState();
    const discovery = {
      type: 'CONTRACT_DISCOVERY',
      contractAddress: contractAddr,
      contractType,
      chain: 'hedera',
      estimatedLineCount: lineCount,
      initialRiskScore: riskScore,
      tvlEstimate: 500_000 + cycleIndex * 50_000,
      deployerAddress: randHexAddr(),
      discoveryTimestamp: new Date().toISOString(),
      timestamp: Date.now(),
    };
    s.addDiscovery(discovery);
    s.incrementStat('totalDiscoveries');
    s.addLogEntry({ ...discovery, source: 'discovery', timestamp: Date.now() });
  }

  // ── Phase 2: Auction posted (t=5s) ───────────────────────
  schedule(() => {
    const s = getState();
    const budget = 20_000_000_000n; // 200 GUARD
    const auctionDeadline = Math.floor(Date.now() / 1000) + 180;
    const job = {
      jobId,
      contractAddress: contractAddr,
      contractChain: 'hedera',
      contractType,
      budgetAvailable: budget,
      budgetFormatted: parseGuardAmount(budget),
      auctionDeadline,
      initialRiskScore: riskScore,
      lineCount,
      blockNumber: Math.floor(Math.random() * 900_000) + 100_000,
    };
    s.setJob(jobId, job);
    s.incrementStat('totalAuctions');
    s.addLogEntry({
      type: 'JobPosted',
      source: 'mock',
      jobId,
      contractAddress: contractAddr,
      budgetFormatted: parseGuardAmount(budget),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
  }, 5_000);

  // ── Phase 3: Bids (t=8, 12, 16s) ─────────────────────────

  function scheduleBid(agent, delay) {
    schedule(() => {
      const s = getState();
      const bidAmount = scaleBid(agent.bidGuard);
      const bid = {
        jobId,
        agent:                  agent.address,
        agentName:              agent.name,
        bidAmount,
        bidFormatted:           parseGuardAmount(bidAmount),
        collateralLocked:       agent.collateral,
        collateralFormatted:    parseGuardAmount(agent.collateral),
        reputationAtBid:        agent.reputation,
        specialization:         agent.specialization,
        estimatedCompletionTime:agent.etaSeconds,
        blockNumber:            Math.floor(Math.random() * 900_000) + 100_000,
        timestamp:              Date.now(),
        _tx: mkTx(),
      };
      s.addBid(jobId, bid);
      s.incrementStat('totalBids');
      s.addLogEntry({
        type: 'BidSubmitted',
        source: 'mock',
        jobId,
        agentName: agent.name,
        bidFormatted: bid.bidFormatted,
        timestamp: Date.now(),
        _tx: bid._tx,
      });
    }, delay);
  }

  scheduleBid(AGENTS.static47, 8_000);
  scheduleBid(AGENTS.fuzzer12, 12_000);
  scheduleBid(AGENTS.llm3, 16_000);

  // ── Phase 4: Winner selection + refund + fee flow (t=25s) ─
  schedule(() => {
    const s = getState();
    const totalEscrowed = 4_750_000_000n; // 47.50 GUARD (15+35-2.5 fee = escrowed for winners)
    const platformFee   = 250_000_000n;   // 2.50 GUARD
    s.setWinners(jobId, {
      agents: [STATIC47_ADDR, LLM3_ADDR],
      totalEscrowed,
      totalEscrowedFormatted: parseGuardAmount(totalEscrowed),
      platformFee,
      platformFeeFormatted: parseGuardAmount(platformFee),
    });
    const tx = mkTx();
    s.addLogEntry({
      type: 'WinnersSelected',
      source: 'mock',
      jobId,
      winnerCount: 2,
      timestamp: Date.now(),
      _tx: tx,
    });
    // Refund Fuzzer-12 (loser)
    s.addLogEntry({
      type: 'BidRefunded',
      source: 'mock',
      jobId,
      agent: FUZZER12_ADDR,
      agentName: AGENTS.fuzzer12.name,
      refunded: parseGuardAmount(AGENTS.fuzzer12.collateral),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
    // Platform fee flow: vault → Treasury
    s.addGuardFlow({
      from: 'vault',
      fromName: 'Vault',
      to: TREASURY_ADDR,
      toName: 'Treasury',
      amount: platformFee,
      amountFormatted: parseGuardAmount(platformFee),
      type: 'PLATFORM_FEE',
      jobId,
      timestamp: Date.now(),
    });
  }, 25_000);

  // ── Phase 5: Sub-auction created (t=30s) ─────────────────
  schedule(() => {
    const s = getState();
    const paymentAmount  = 300_000_000n; // 3 GUARD
    const slaDeadline    = Math.floor(Date.now() / 1000) + 900;
    const auctionDl      = Math.floor(Date.now() / 1000) + 120;
    const subJob = {
      subJobId,
      parentJobId: jobId,
      requester: LLM3_ADDR,
      requesterName: AGENTS.llm3.name,
      taskDescription: `Dependency tree analysis for ${contractLabel} OpenZeppelin v4.9 integration`,
      requiredSpecialization: 'dependency_analysis',
      paymentAmount,
      paymentFormatted: parseGuardAmount(paymentAmount),
      slaDeadline,
      auctionDeadline: auctionDl,
      status: 'OPEN',
      blockNumber: Math.floor(Math.random() * 900_000) + 100_000,
    };
    s.addSubJob(subJob);
    s.incrementStat('totalSubAuctions');
    s.addLogEntry({
      type: 'SUB_AUCTION_CREATED',
      source: 'mock',
      subJobId,
      parentJobId: jobId,
      requesterName: AGENTS.llm3.name,
      taskDescription: subJob.taskDescription,
      requiredSpecialization: 'dependency_analysis',
      paymentFormatted: parseGuardAmount(paymentAmount),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
  }, 30_000);

  // ── Phase 6a: Sub-bid (t=35s) ────────────────────────────
  schedule(() => {
    const s = getState();
    const proposedPrice = 300_000_000n; // 3 GUARD
    const bid = {
      subJobId,
      agent:                  DEP8_ADDR,
      agentName:              AGENTS.dep8.name,
      proposedPrice,
      proposedPriceFormatted: parseGuardAmount(proposedPrice),
      collateralLocked:       AGENTS.dep8.collateral,
      estimatedTime:          AGENTS.dep8.etaSeconds,
      blockNumber:            Math.floor(Math.random() * 900_000) + 100_000,
      timestamp:              Date.now(),
    };
    s.addSubBid(subJobId, bid);
    s.addLogEntry({
      type: 'SUB_BID',
      source: 'mock',
      subJobId,
      agentName: AGENTS.dep8.name,
      bidFormatted: parseGuardAmount(proposedPrice),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
  }, 35_000);

  // ── Phase 7a: Data listing (t=38s) ───────────────────────
  schedule(() => {
    const s = getState();
    const price = 50_000_000n; // 0.50 GUARD
    const listing = {
      listingId,
      parentJobId: jobId,
      seller: STATIC47_ADDR,
      sellerName: AGENTS.static47.name,
      title: `Static Analysis Report — ${contractLabel} v2.1`,
      category: 0,          // SCAN_REPORT
      categoryStr: 'SCAN_REPORT',
      listingType: 0,        // ONE_TIME
      listingTypeStr: 'ONE_TIME',
      price,
      priceFormatted: parseGuardAmount(price),
      contentHash: randHex(32),
      blockNumber: Math.floor(Math.random() * 900_000) + 100_000,
      active: true,
      _tx: mkTx(),
    };
    s.addDataListing(listing);
    s.addLogEntry({
      type: 'DATA_LISTED',
      source: 'mock',
      listingId,
      parentJobId: jobId,
      sellerName: AGENTS.static47.name,
      title: listing.title,
      priceFormatted: parseGuardAmount(price),
      timestamp: Date.now(),
      _tx: listing._tx,
    });
  }, 38_000);

  // ── Phase 6b: Sub-contractor selected (t=40s) ────────────
  schedule(() => {
    const s = getState();
    const agreedPrice = 300_000_000n;
    s.updateSubJobStatus(subJobId, {
      selectedAgent: DEP8_ADDR,
      selectedAgentName: AGENTS.dep8.name,
      agreedPrice,
      agreedPriceFormatted: parseGuardAmount(agreedPrice),
      status: 'IN_PROGRESS',
    });
    s.addLogEntry({
      type: 'SUB_SELECTED',
      source: 'mock',
      subJobId,
      agentName: AGENTS.dep8.name,
      agreedPriceFormatted: parseGuardAmount(agreedPrice),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
  }, 40_000);

  // ── Phase 7b: Data purchase (t=44s) ──────────────────────
  schedule(() => {
    const s = getState();
    const pricePaid   = 50_000_000n;   // 0.50 GUARD
    const platformFee = 1_500_000n;    // 0.015 GUARD
    const netToSeller = 48_500_000n;   // 0.485 GUARD
    const purchase = {
      listingId,
      buyer: FUZZER12_ADDR,
      buyerName: AGENTS.fuzzer12.name,
      seller: STATIC47_ADDR,
      sellerName: AGENTS.static47.name,
      pricePaid,
      pricePaidFormatted: parseGuardAmount(pricePaid),
      platformFee,
      timestamp: Date.now(),
    };
    s.addDataPurchase(purchase);
    // Net to seller flow
    s.addGuardFlow({
      from: FUZZER12_ADDR,
      fromName: AGENTS.fuzzer12.name,
      to: STATIC47_ADDR,
      toName: AGENTS.static47.name,
      amount: netToSeller,
      amountFormatted: parseGuardAmount(netToSeller),
      type: 'DATA_PURCHASE',
      listingId,
      timestamp: Date.now(),
    });
    // Platform fee flow
    s.addGuardFlow({
      from: FUZZER12_ADDR,
      fromName: AGENTS.fuzzer12.name,
      to: TREASURY_ADDR,
      toName: 'Treasury',
      amount: platformFee,
      amountFormatted: parseGuardAmount(platformFee),
      type: 'PLATFORM_FEE',
      listingId,
      timestamp: Date.now(),
    });
    s.incrementStat('totalDataSales');
    s.addLogEntry({
      type: 'DATA_PURCHASED',
      source: 'mock',
      listingId,
      buyerName: AGENTS.fuzzer12.name,
      sellerName: AGENTS.static47.name,
      pricePaidFormatted: parseGuardAmount(pricePaid),
      timestamp: Date.now(),
      _tx: mkTx(),
    });
  }, 44_000);

  // ── Phase 8: Sub-contract delivery + acceptance (t=50s) ──
  schedule(() => {
    const s = getState();
    const resultHash = randHex(32);
    s.updateSubJobStatus(subJobId, {
      resultHash,
      deliveredBy: DEP8_ADDR,
      status: 'DELIVERED',
    });
    s.addLogEntry({
      type: 'RESULT_DELIVERED',
      source: 'mock',
      subJobId,
      agentName: AGENTS.dep8.name,
      timestamp: Date.now(),
      _tx: mkTx(),
    });

    // Acceptance + payment after short delay
    setTimeout(() => {
      const s2 = getState();
      const paymentAmount = 300_000_000n; // 3 GUARD
      s2.updateSubJobStatus(subJobId, {
        status: 'ACCEPTED',
        completedAt: Date.now(),
      });
      s2.addGuardFlow({
        from: LLM3_ADDR,
        fromName: AGENTS.llm3.name,
        to: DEP8_ADDR,
        toName: AGENTS.dep8.name,
        amount: paymentAmount,
        amountFormatted: parseGuardAmount(paymentAmount),
        type: 'SUB_CONTRACT',
        jobId,
        timestamp: Date.now(),
      });
      s2.addLogEntry({
        type: 'RESULT_ACCEPTED',
        source: 'mock',
        subJobId,
        paymentFormatted: parseGuardAmount(paymentAmount),
        timestamp: Date.now(),
        _tx: mkTx(),
      });
    }, 3_000);
  }, 50_000);

  // ── Phase 9: Data rating + settlement (t=60s) ────────────
  schedule(() => {
    const s = getState();

    // Data rating
    s.updateDataPurchaseRating(listingId, FUZZER12_ADDR, 4);
    s.addLogEntry({
      type: 'DATA_RATED',
      source: 'mock',
      listingId,
      buyerName: AGENTS.fuzzer12.name,
      rating: 4,
      timestamp: Date.now(),
    });

    // Settlement
    const totalDisbursed     = 5_250_000_000n; // 52.50 GUARD
    const platformFee        = 250_000_000n;   // 2.50 GUARD
    const reportFees         = 15_000_000n;    // 0.15 GUARD
    const staticPayment      = 1_695_000_000n; // 16.95 GUARD (15 base + 2 speed bonus - 0.05 report)
    const llmPayment         = 4_290_000_000n; // 42.90 GUARD (35 base + 8 unique bonus - 0.10 report)
    const reportFee          = 15_000_000n;    // 0.15 GUARD

    const settlementTx = mkTx();
    s.addSettlement({
      settlementId: settleId,
      jobId,
      totalDisbursed,
      totalDisbursedFormatted: parseGuardAmount(totalDisbursed),
      platformFee,
      reportFees,
      recipientCount: 3,
      blockNumber: Math.floor(Math.random() * 900_000) + 100_000,
      timestamp: Date.now(),
    });
    s.incrementStat('totalSettlements');
    s.incrementStat('totalGuardTransacted', 52.50);
    s.addLogEntry({
      type: 'JOB_SETTLED',
      source: 'mock',
      settlementId: settleId,
      jobId,
      totalDisbursedFormatted: parseGuardAmount(totalDisbursed),
      recipientCount: 3,
      timestamp: Date.now(),
      _tx: settlementTx,
    });

    // Settlement GUARD flows — staggered 50ms apart for "burst" effect
    setTimeout(() => {
      getState().addGuardFlow({
        from: 'vault',
        fromName: 'Vault',
        to: STATIC47_ADDR,
        toName: AGENTS.static47.name,
        amount: staticPayment,
        amountFormatted: parseGuardAmount(staticPayment),
        type: 'MAIN_AUDIT',
        jobId,
        timestamp: Date.now(),
      });
    }, 0);

    setTimeout(() => {
      getState().addGuardFlow({
        from: 'vault',
        fromName: 'Vault',
        to: LLM3_ADDR,
        toName: AGENTS.llm3.name,
        amount: llmPayment,
        amountFormatted: parseGuardAmount(llmPayment),
        type: 'MAIN_AUDIT',
        jobId,
        timestamp: Date.now(),
      });
    }, 50);

    setTimeout(() => {
      getState().addGuardFlow({
        from: 'vault',
        fromName: 'Vault',
        to: TREASURY_ADDR,
        toName: 'Treasury',
        amount: reportFee,
        amountFormatted: parseGuardAmount(reportFee),
        type: 'REPORT_FEE',
        jobId,
        timestamp: Date.now(),
      });
    }, 100);
  }, 60_000);

  return () => timeouts.forEach(clearTimeout);
}

// ── Agent comms chatter ────────────────────────────────────

const CHATTER_AGENTS = [AGENTS.static47, AGENTS.fuzzer12, AGENTS.llm3, AGENTS.dep8];
const CHATTER_MSGS   = [
  'SUB_AUCTION', 'DATA_LISTING', 'MONITORING_OFFER', 'COORDINATION_REQUEST',
];

function generateMockAgentComms() {
  const agent   = CHATTER_AGENTS[Math.floor(Math.random() * CHATTER_AGENTS.length)];
  const msgType = CHATTER_MSGS[Math.floor(Math.random() * CHATTER_MSGS.length)];
  return {
    type: msgType,
    fromAgent: agent.address,
    fromAgentName: agent.name,
    data: {
      description: `${agent.name} sent ${msgType.toLowerCase().replace(/_/g, ' ')}`,
      timestamp: new Date().toISOString(),
    },
  };
}

// ── Public API ────────────────────────────────────────────

let _cycleIndex = 0;

/**
 * Starts the mock event stream.
 * @param {Function} getState  zustand getState (returns store with actions)
 * @param {object}   config    SDK config.json
 * @returns {Function} cleanup — stops all timers
 */
export function startMockEventStream(getState, config) {
  const cleanups = [];
  _cycleIndex = 0;

  // Fire first cycle immediately
  cleanups.push(runDay2Cycle(getState, _cycleIndex++));

  // Repeat every CYCLE_DURATION_MS
  const cycleInterval = setInterval(() => {
    cleanups.push(runDay2Cycle(getState, _cycleIndex++));
  }, CYCLE_DURATION_MS);
  cleanups.push(() => clearInterval(cycleInterval));

  // Agent comms chatter every ~12s
  const commsInterval = setInterval(() => {
    const msg = generateMockAgentComms();
    const s = getState();
    s.addLogEntry({ ...msg, source: 'agentComms', timestamp: Date.now() });
  }, 12_000);
  cleanups.push(() => clearInterval(commsInterval));

  return () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };
}
