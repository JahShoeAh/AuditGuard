/**
 * packages/sdk/db/report-db.js
 *
 * STUB — replace this entire file when task/report-backend (Task A) merges.
 * Task B and C import from this path; these stubs keep both tasks buildable
 * without a live PostgreSQL connection or S3 bucket.
 *
 * DEMO MODE: getReportsByDeployer returns sample reports for any connected
 * wallet so Tasks B + C can be demonstrated end-to-end without PostgreSQL.
 * Remove SAMPLE_REPORTS and restore the empty-array returns when Task A merges.
 */

/** @type {import('./report-types.js').StoredAuditReport[]} */
const SAMPLE_REPORTS = [
  {
    id: 'report:101',
    jobId: '101',
    contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    deployerAddress: '', // filled in at query time
    hederaAccountId: null,
    chain: 'hedera-testnet',
    contractType: 'lending',
    s3Key: '',
    contentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    cid: '',
    agentAddresses: ['0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f60001', '0xb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a10002'],
    agentCount: 2,
    findingCount: 5,
    findingsBySeverity: { critical: 1, high: 2, medium: 1, low: 1, info: 0 },
    timestamp: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
    tags: ['reentrancy', 'access control'],
    source: 'orchestrator',
  },
  {
    id: 'report:102',
    jobId: '102',
    contractAddress: '0xcafecafecafecafecafecafecafecafecafecafe',
    deployerAddress: '',
    hederaAccountId: null,
    chain: 'hedera-testnet',
    contractType: 'dex',
    s3Key: '',
    contentHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
    cid: '',
    agentAddresses: ['0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f60001'],
    agentCount: 1,
    findingCount: 2,
    findingsBySeverity: { critical: 0, high: 0, medium: 1, low: 1, info: 0 },
    timestamp: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
    tags: ['oracle'],
    source: 'orchestrator',
  },
  {
    id: 'report:103',
    jobId: '103',
    contractAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    deployerAddress: '',
    hederaAccountId: null,
    chain: 'hedera-testnet',
    contractType: 'staking',
    s3Key: '',
    contentHash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    cid: '',
    agentAddresses: [
      '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f60001',
      '0xb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a10002',
      '0xc3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b20003',
    ],
    agentCount: 3,
    findingCount: 0,
    findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    timestamp: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago
    tags: [],
    source: 'orchestrator',
  },
];

const SAMPLE_MD = {
  '101': `# Audit Report — Job #101\n\n**Contract:** \`0xdeadbeef...beef\`\n**Chain:** hedera-testnet\n**Contract Type:** lending\n**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n## Executive Summary\n\nThis audit identified **5 findings** across 2 automated analysis agents.\n\n## Severity Breakdown\n\n- Critical: 1\n- High: 2\n- Medium: 1\n- Low: 1\n\n## Findings\n\n### F-1: Reentrancy in withdraw()\n\n**Severity:** CRITICAL\n**Agent:** static-analysis\n\nThe \`withdraw()\` function updates the user's balance after the external call, allowing a malicious contract to re-enter and drain funds.\n\n**Recommendation:** Apply the checks-effects-interactions pattern or use a reentrancy guard.\n\n### F-2: Missing access control on setOracle()\n\n**Severity:** HIGH\n**Agent:** static-analysis\n\nAny address can call \`setOracle()\`, allowing an attacker to redirect price feeds.\n\n**Recommendation:** Add \`onlyOwner\` or role-based access control.\n`,
  '102': `# Audit Report — Job #102\n\n**Contract:** \`0xcafecafe...cafe\`\n**Chain:** hedera-testnet\n**Contract Type:** dex\n**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n## Executive Summary\n\nThis audit identified **2 findings** across 1 automated analysis agent.\n\n## Severity Breakdown\n\n- Medium: 1\n- Low: 1\n\n## Findings\n\n### F-1: Oracle price staleness not checked\n\n**Severity:** MEDIUM\n**Agent:** fuzzer\n\nThe contract reads from a Chainlink oracle but does not validate \`updatedAt\`, allowing use of stale prices.\n\n**Recommendation:** Check that \`updatedAt\` is within an acceptable staleness window.\n`,
  '103': `# Audit Report — Job #103\n\n**Contract:** \`0xabcdef12...ef12\`\n**Chain:** hedera-testnet\n**Contract Type:** staking\n**Report Date:** ${new Date().toISOString().split('T')[0]}\n\n## Executive Summary\n\nThis audit identified **0 findings** across 3 automated analysis agents. The contract appears well-structured with no critical vulnerabilities detected.\n`,
};

/**
 * @param {string} addr  Deployer EVM or Hedera address (normalized)
 * @returns {Promise<import('./report-types.js').StoredAuditReport[]>}
 */
export async function getReportsByDeployer(addr) {
  // Demo: return sample reports for any connected wallet, stamped with the queried address.
  return SAMPLE_REPORTS.map((r) => ({ ...r, deployerAddress: addr }));
}

/**
 * @param {string} jobId
 * @returns {Promise<(import('./report-types.js').StoredAuditReport & { mdContent: string }) | null>}
 */
export async function getReportById(jobId) {
  const report = SAMPLE_REPORTS.find((r) => r.jobId === jobId);
  if (!report) return null;
  return { ...report, mdContent: SAMPLE_MD[jobId] ?? '' };
}

/**
 * @param {import('./report-types.js').StoredAuditReport & { mdContent?: string }} r
 * @returns {Promise<string>} canonical report ID
 */
export async function saveReport(r) {
  return `report:${r.jobId}`;
}

/**
 * @param {string} _jobId
 * @returns {Promise<boolean>}
 */
export async function reportExists(_jobId) {
  return false;
}
