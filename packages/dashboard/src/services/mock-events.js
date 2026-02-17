/**
 * Mock event generator — pumps realistic fake data into the Zustand store
 * so the UI can be developed and demoed before agents are running.
 */

import { parseGuardAmount, shortenAddress } from './event-listener';

// ── Randomness helpers ─────────────────────────────────────

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randHexAddr = () =>
  '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const CONTRACT_TYPES = ['lending_protocol', 'dex', 'staking_pool', 'yield_aggregator'];
const SPECIALIZATIONS = ['static_analysis', 'fuzzing', 'llm_contextual', 'dependency_analysis'];
const CHAINS = ['hedera_testnet', 'ethereum_sepolia', 'polygon_mumbai'];

// Seeded agent profiles (matches Person 1's seeded agents)
const SEEDED_AGENTS = [
  {
    name: 'StaticAnalysis-47',
    address: '0xA1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f60001',
    specialization: 'static_analysis',
    reputation: 9400,
  },
  {
    name: 'Fuzzer-12',
    address: '0xB2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6a10002',
    specialization: 'fuzzing',
    reputation: 8700,
  },
  {
    name: 'LLMContextual-3',
    address: '0xC3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b20003',
    specialization: 'llm_contextual',
    reputation: 8700,
  },
];

let _mockJobCounter = 1;

// ── Generators ─────────────────────────────────────────────

export function generateMockDiscovery() {
  const contractAddr = randHexAddr();
  return {
    type: 'CONTRACT_DISCOVERY',
    contractAddress: contractAddr,
    chain: pick(CHAINS),
    discoveryTimestamp: new Date().toISOString(),
    estimatedLineCount: randInt(200, 5000),
    initialRiskScore: randInt(20, 95),
    deployerAddress: randHexAddr(),
    contractType: pick(CONTRACT_TYPES),
    tvlEstimate: randInt(1000, 500000),
  };
}

export function generateMockJobPosted() {
  const jobId = String(_mockJobCounter++);
  const budget = BigInt(randInt(5, 200)) * 100_000_000n; // 5–200 GUARD in raw
  return {
    type: 'JobPosted',
    jobId,
    contractAddress: randHexAddr(),
    contractChain: pick(CHAINS),
    contractType: pick(CONTRACT_TYPES),
    budgetAvailable: budget,
    budgetFormatted: parseGuardAmount(budget),
    auctionDeadline: BigInt(Math.floor(Date.now() / 1000) + randInt(600, 3600)),
    initialRiskScore: randInt(30, 90),
    lineCount: randInt(200, 5000),
    blockNumber: randInt(10000, 99999),
  };
}

export function generateMockBid(jobId) {
  const agent = pick(SEEDED_AGENTS);
  const bidAmount = BigInt(randInt(2, 50)) * 100_000_000n;
  const collateral = bidAmount / 5n; // 20% collateral
  return {
    jobId: jobId || '1',
    agent: agent.address,
    agentName: agent.name,
    bidAmount,
    bidFormatted: parseGuardAmount(bidAmount),
    collateralLocked: collateral,
    reputationAtBid: agent.reputation,
    specialization: agent.specialization,
    estimatedCompletionTime: randInt(300, 1800),
    blockNumber: randInt(10000, 99999),
  };
}

export function generateMockWinnerSelection(jobId) {
  const numWinners = randInt(1, 3);
  const winners = SEEDED_AGENTS.slice(0, numWinners).map((a) => a.address);
  const totalEscrowed = BigInt(randInt(20, 150)) * 100_000_000n;
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
 * Starts pumping mock events into the store at realistic intervals.
 * @param {Function} getState  zustand getState (useStore.getState)
 * @param {object}   config    SDK config for agent resolution
 * @returns {Function} cleanup — call to stop the stream
 */
export function startMockEventStream(getState, config) {
  const intervals = [];
  let activeJobId = null;

  // Discovery every ~8 s
  intervals.push(setInterval(() => {
    const d = generateMockDiscovery();
    const s = getState();
    s.addDiscovery(d);
    s.incrementStat('totalDiscoveries');
    s.addLogEntry({ ...d, source: 'discovery', timestamp: Date.now() });
  }, 8_000));

  // Job posted every ~15 s
  intervals.push(setInterval(() => {
    const job = generateMockJobPosted();
    activeJobId = job.jobId;
    const s = getState();
    s.setJob(job.jobId, job);
    s.incrementStat('totalAuctions');
    s.addLogEntry({
      type: 'JobPosted', source: 'mock',
      jobId: job.jobId, budgetFormatted: job.budgetFormatted,
      contractAddress: shortenAddress(job.contractAddress),
      timestamp: Date.now(),
    });
  }, 15_000));

  // Bids every ~5 s
  intervals.push(setInterval(() => {
    if (!activeJobId) return;
    const bid = generateMockBid(activeJobId);
    const s = getState();
    s.addBid(bid.jobId, bid);
    s.incrementStat('totalBids');
    s.addLogEntry({
      type: 'BidSubmitted', source: 'mock',
      jobId: bid.jobId, agentName: bid.agentName,
      bidFormatted: bid.bidFormatted,
      timestamp: Date.now(),
    });
  }, 5_000));

  // Winner selection every ~30 s
  intervals.push(setInterval(() => {
    if (!activeJobId) return;
    const w = generateMockWinnerSelection(activeJobId);
    const s = getState();
    s.setWinners(w.jobId, w);
    s.addLogEntry({
      type: 'WinnersSelected', source: 'mock',
      jobId: w.jobId, winnerCount: w.agents.length,
      timestamp: Date.now(),
    });
  }, 30_000));

  // Agent comms chatter every ~10 s
  intervals.push(setInterval(() => {
    const msg = generateMockAgentComms();
    const s = getState();
    s.addLogEntry({ ...msg, source: 'agentComms', timestamp: Date.now() });
  }, 10_000));

  // Fire initial burst so UI is not empty on load
  setTimeout(() => {
    const s = getState();

    const d = generateMockDiscovery();
    s.addDiscovery(d);
    s.incrementStat('totalDiscoveries');
    s.addLogEntry({ ...d, source: 'discovery', timestamp: Date.now() });

    const job = generateMockJobPosted();
    activeJobId = job.jobId;
    s.setJob(job.jobId, job);
    s.incrementStat('totalAuctions');
    s.addLogEntry({
      type: 'JobPosted', source: 'mock',
      jobId: job.jobId, budgetFormatted: job.budgetFormatted,
      contractAddress: shortenAddress(job.contractAddress),
      timestamp: Date.now(),
    });

    const bid = generateMockBid(activeJobId);
    s.addBid(bid.jobId, bid);
    s.incrementStat('totalBids');
    s.addLogEntry({
      type: 'BidSubmitted', source: 'mock',
      jobId: bid.jobId, agentName: bid.agentName,
      bidFormatted: bid.bidFormatted,
      timestamp: Date.now(),
    });
  }, 500);

  return () => intervals.forEach(clearInterval);
}
