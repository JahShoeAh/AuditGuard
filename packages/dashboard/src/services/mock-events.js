/**
 * Mock event generator — pumps realistic fake data into the Zustand store.
 *
 * Creates a complete visual cycle matching the spec:
 *   Scanner discovers contract → Orchestrator posts auction →
 *   Agents bid one-by-one → Winners selected
 *
 * Bid amounts match the spec personas:
 *   StaticAnalysis-47: 15 GUARD, 720s ETA, rep 9400
 *   Fuzzer-12:         22 GUARD, 2700s ETA, rep 8700
 *   LLMContextual-3:   35 GUARD, 7200s ETA, rep 8700
 */

import { parseGuardAmount, shortenAddress } from './event-listener';

// ── Randomness helpers ─────────────────────────────────────

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randHexAddr = () =>
  '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const CONTRACT_TYPES = ['lending_protocol', 'dex', 'staking_pool', 'yield_aggregator'];
const CHAINS = ['hedera_testnet', 'ethereum_sepolia', 'polygon_mumbai'];

// Seeded agent profiles with spec-matching bid amounts
const SEEDED_AGENTS = [
  {
    name: 'StaticAnalysis-47',
    address: '0xA1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f60001',
    specialization: 'static_analysis',
    reputation: 9400,
    bidGuard: 15,
    etaSeconds: 720,
  },
  {
    name: 'Fuzzer-12',
    address: '0xB2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6a10002',
    specialization: 'fuzzing',
    reputation: 8700,
    bidGuard: 22,
    etaSeconds: 2700,
  },
  {
    name: 'LLMContextual-3',
    address: '0xC3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b20003',
    specialization: 'llm_contextual',
    reputation: 8700,
    bidGuard: 35,
    etaSeconds: 7200,
  },
];

let _mockJobCounter = 1;

// ── Generators (exported for external use) ─────────────────

export function generateMockDiscovery(contractAddr) {
  return {
    type: 'CONTRACT_DISCOVERY',
    contractAddress: contractAddr || randHexAddr(),
    chain: pick(CHAINS),
    discoveryTimestamp: new Date().toISOString(),
    estimatedLineCount: randInt(200, 5000),
    initialRiskScore: randInt(30, 90),
    deployerAddress: randHexAddr(),
    contractType: pick(CONTRACT_TYPES),
    tvlEstimate: randInt(5000, 500000),
  };
}

export function generateMockJobPosted(contractAddr, contractType, riskScore, lineCount) {
  const jobId = String(_mockJobCounter++);
  const budget = BigInt(randInt(80, 250)) * 100_000_000n;
  return {
    type: 'JobPosted',
    jobId,
    contractAddress: contractAddr || randHexAddr(),
    contractChain: pick(CHAINS),
    contractType: contractType || pick(CONTRACT_TYPES),
    budgetAvailable: budget,
    budgetFormatted: parseGuardAmount(budget),
    auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + 90), // 90s for demo visibility
    initialRiskScore: riskScore || randInt(30, 90),
    lineCount: lineCount || randInt(200, 5000),
    blockNumber: randInt(10000, 99999),
    timestamp: Date.now(),
  };
}

export function generateMockBid(jobId, agent) {
  const a = agent || pick(SEEDED_AGENTS);
  const bidAmount = BigInt(a.bidGuard) * 100_000_000n;
  const collateral = BigInt(50) * 100_000_000n;
  return {
    jobId: jobId || '1',
    agent: a.address,
    agentName: a.name,
    bidAmount,
    bidFormatted: parseGuardAmount(bidAmount),
    collateralLocked: collateral,
    collateralFormatted: parseGuardAmount(collateral),
    reputationAtBid: a.reputation,
    specialization: a.specialization,
    estimatedCompletionTime: a.etaSeconds,
    blockNumber: randInt(10000, 99999),
    timestamp: Date.now(),
  };
}

export function generateMockWinnerSelection(jobId) {
  // Pick 2 of 3 agents as winners
  const winners = SEEDED_AGENTS.slice(0, 2).map((a) => a.address);
  const totalEscrowed = BigInt(37) * 100_000_000n; // 15 + 22 = 37 GUARD
  const platformFee = totalEscrowed / 20n; // 5%
  return {
    jobId: jobId || '1',
    agents: winners,
    totalEscrowed,
    totalEscrowedFormatted: parseGuardAmount(totalEscrowed),
    platformFee,
    platformFeeFormatted: parseGuardAmount(platformFee),
  };
}

// ── Sequential auction cycle ───────────────────────────────

/**
 * Runs a single complete auction cycle:
 * Discovery → (wait) → Job posted → (wait) → Bid 1 → Bid 2 → Bid 3 → (wait) → Winners
 *
 * @returns {Function} cancel — stops pending timeouts
 */
function runAuctionCycle(getState) {
  const timeouts = [];
  const schedule = (fn, ms) => {
    timeouts.push(setTimeout(fn, ms));
  };

  const contractAddr = randHexAddr();
  const contractType = pick(CONTRACT_TYPES);
  const riskScore = randInt(35, 88);
  const lineCount = randInt(500, 4500);

  // T+0: Discovery
  const s = getState();
  const discovery = generateMockDiscovery(contractAddr);
  discovery.contractType = contractType;
  discovery.initialRiskScore = riskScore;
  discovery.estimatedLineCount = lineCount;
  s.addDiscovery(discovery);
  s.incrementStat('totalDiscoveries');
  s.addLogEntry({ ...discovery, source: 'discovery', timestamp: Date.now() });

  // T+5s: Job posted (linked to the discovered contract)
  schedule(() => {
    const s = getState();
    const job = generateMockJobPosted(contractAddr, contractType, riskScore, lineCount);
    s.setJob(job.jobId, job);
    s.incrementStat('totalAuctions');
    s.addLogEntry({
      type: 'JobPosted', source: 'mock',
      jobId: job.jobId, budgetFormatted: job.budgetFormatted,
      contractAddress: shortenAddress(job.contractAddress),
      timestamp: Date.now(),
    });

    const jobId = job.jobId;

    // T+5+4s: Bid from StaticAnalysis-47
    schedule(() => {
      const s = getState();
      const bid = generateMockBid(jobId, SEEDED_AGENTS[0]);
      s.addBid(bid.jobId, bid);
      s.incrementStat('totalBids');
      s.addLogEntry({
        type: 'BidSubmitted', source: 'mock',
        jobId: bid.jobId, agentName: bid.agentName,
        bidFormatted: bid.bidFormatted,
        timestamp: Date.now(),
      });
    }, 4_000);

    // T+5+8s: Bid from Fuzzer-12
    schedule(() => {
      const s = getState();
      const bid = generateMockBid(jobId, SEEDED_AGENTS[1]);
      s.addBid(bid.jobId, bid);
      s.incrementStat('totalBids');
      s.addLogEntry({
        type: 'BidSubmitted', source: 'mock',
        jobId: bid.jobId, agentName: bid.agentName,
        bidFormatted: bid.bidFormatted,
        timestamp: Date.now(),
      });
    }, 8_000);

    // T+5+13s: Bid from LLMContextual-3
    schedule(() => {
      const s = getState();
      const bid = generateMockBid(jobId, SEEDED_AGENTS[2]);
      s.addBid(bid.jobId, bid);
      s.incrementStat('totalBids');
      s.addLogEntry({
        type: 'BidSubmitted', source: 'mock',
        jobId: bid.jobId, agentName: bid.agentName,
        bidFormatted: bid.bidFormatted,
        timestamp: Date.now(),
      });
    }, 13_000);

    // T+5+23s: Winner selection (picks SA-47 + Fuzzer-12)
    schedule(() => {
      const s = getState();
      const w = generateMockWinnerSelection(jobId);
      s.setWinners(w.jobId, w);
      s.addLogEntry({
        type: 'WinnersSelected', source: 'mock',
        jobId: w.jobId, winnerCount: w.agents.length,
        timestamp: Date.now(),
      });
    }, 23_000);
  }, 5_000);

  return () => timeouts.forEach(clearTimeout);
}

// ── Agent comms chatter ────────────────────────────────────

function generateMockAgentComms() {
  const agent = pick(SEEDED_AGENTS);
  const msgType = pick(['SUB_AUCTION', 'DATA_LISTING', 'MONITORING_OFFER']);
  return {
    type: msgType,
    fromAgent: agent.address,
    fromAgentName: agent.name,
    data: {
      description: `${agent.name} posted a ${msgType.toLowerCase().replace('_', ' ')}`,
      timestamp: new Date().toISOString(),
    },
  };
}

// ── Stream controller ──────────────────────────────────────

/**
 * Starts the mock event stream with sequential auction cycles.
 * @param {Function} getState  zustand getState
 * @param {object}   config    SDK config
 * @returns {Function} cleanup
 */
export function startMockEventStream(getState, config) {
  const cleanups = [];

  // Fire first cycle immediately
  cleanups.push(runAuctionCycle(getState));

  // Fire new cycles every ~35 seconds (previous cycle takes ~28s total)
  const cycleInterval = setInterval(() => {
    cleanups.push(runAuctionCycle(getState));
  }, 35_000);
  cleanups.push(() => clearInterval(cycleInterval));

  // Agent comms chatter every ~12s
  const commsInterval = setInterval(() => {
    const msg = generateMockAgentComms();
    const s = getState();
    s.addLogEntry({ ...msg, source: 'agentComms', timestamp: Date.now() });
  }, 12_000);
  cleanups.push(() => clearInterval(commsInterval));

  // Extra discovery every ~18s (independent of auction cycles)
  const extraDiscoveryInterval = setInterval(() => {
    const d = generateMockDiscovery();
    const s = getState();
    s.addDiscovery(d);
    s.incrementStat('totalDiscoveries');
    s.addLogEntry({ ...d, source: 'discovery', timestamp: Date.now() });
  }, 18_000);
  cleanups.push(() => clearInterval(extraDiscoveryInterval));

  return () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };
}
