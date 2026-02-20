#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const DEFAULT_OUTPUT = path.join(__dirname, "..", "recon", "test-logs", "lifecycle_summary.json");
const EVENT_PATTERNS = [
  { name: "JOB_CREATED", regex: /\bJOB_CREATED\b|\bJobPosted\b/i },
  { name: "AUCTION_INVITE", regex: /\bAUCTION_INVITE\b/i },
  { name: "BID_SUBMITTED", regex: /\bBID_SUBMITTED\b|\bBidSubmitted\b/i },
  { name: "WINNER_SELECTED", regex: /\bWINNER_SELECTED\b|\bWinnersSelected\b/i },
  { name: "JOB_CANCELLED", regex: /\bJOB_CANCELLED\b|\bJobCancelled\b/i },
  { name: "JOB_COMPLETED", regex: /\bJOB_COMPLETED\b|\bJobCompleted\b/i },
  { name: "JOB_FAILED", regex: /\bJOB_FAILED\b/i },
  { name: "PAYMENT_SETTLED", regex: /\bPAYMENT_SETTLED\b|\bJOB_SETTLED\b/i },
  { name: "REPORT_PUBLISHED", regex: /\bREPORT_PUBLISHED\b/i },
];

function extractJobId(line) {
  const candidates = [
    line.match(/\bjob(?:Id)?\s*[:=#]?\s*["']?(\d+)["']?/i),
    line.match(/\bJob\s*#\s*(\d+)/i),
    line.match(/\bjob[_\s-]?(\d+)\b/i),
  ];
  for (const match of candidates) {
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const events = [];
  const perJob = new Map();

  lines.forEach((line, index) => {
    for (const { name, regex } of EVENT_PATTERNS) {
      if (!regex.test(line)) continue;
      const jobId = extractJobId(line);
      events.push({ file: filePath, line: index + 1, event: name, jobId, raw: line.trim() });
      if (!jobId) continue;
      if (!perJob.has(jobId)) perJob.set(jobId, new Set());
      perJob.get(jobId).add(name);
      break;
    }
  });

  return { events, perJob };
}

function classifyMissingLinks(jobId, eventSet) {
  const events = eventSet;
  const missing = [];
  if (events.has("JOB_CREATED")) {
    if (
      !events.has("WINNER_SELECTED") &&
      !events.has("JOB_CANCELLED") &&
      !events.has("JOB_COMPLETED") &&
      !events.has("JOB_FAILED")
    ) {
      missing.push("created_without_resolution");
    }
  }
  if (events.has("WINNER_SELECTED") && !events.has("BID_SUBMITTED")) {
    missing.push("winner_without_bid");
  }
  if (events.has("PAYMENT_SETTLED") && !events.has("REPORT_PUBLISHED")) {
    missing.push("settled_without_report");
  }
  if (events.has("JOB_COMPLETED") && !events.has("WINNER_SELECTED")) {
    missing.push("completed_without_winner");
  }
  return missing;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function main() {
  const files = process.argv.slice(2).filter(Boolean);
  if (!files.length) {
    console.error("Usage: node scripts/parse-lifecycle-log.js <log1> [log2 ...]");
    process.exit(1);
  }

  const existingFiles = files.filter((f) => fs.existsSync(f));
  if (!existingFiles.length) {
    console.error("No input log files found.");
    process.exit(1);
  }

  const allEvents = [];
  const aggregatePerJob = new Map();

  for (const file of existingFiles) {
    const { events, perJob } = parseFile(file);
    allEvents.push(...events);
    for (const [jobId, eventSet] of perJob.entries()) {
      if (!aggregatePerJob.has(jobId)) aggregatePerJob.set(jobId, new Set());
      const dest = aggregatePerJob.get(jobId);
      for (const event of eventSet.values()) dest.add(event);
    }
  }

  const jobSummaries = Array.from(aggregatePerJob.entries())
    .map(([jobId, eventSet]) => {
      const events = Array.from(eventSet.values()).sort();
      const missingLinks = classifyMissingLinks(jobId, eventSet);
      return { jobId, events, missingLinks };
    })
    .sort((a, b) => Number(a.jobId) - Number(b.jobId));

  const output = {
    generatedAt: new Date().toISOString(),
    files: existingFiles,
    totalEvents: allEvents.length,
    distinctJobs: jobSummaries.length,
    jobsWithMissingLinks: jobSummaries.filter((j) => j.missingLinks.length > 0).length,
    jobs: jobSummaries,
  };

  ensureDir(DEFAULT_OUTPUT);
  fs.writeFileSync(DEFAULT_OUTPUT, JSON.stringify(output, null, 2));

  console.log(`Lifecycle summary written: ${DEFAULT_OUTPUT}`);
  console.log(`Parsed events: ${output.totalEvents}`);
  console.log(`Distinct jobs: ${output.distinctJobs}`);
  console.log(`Jobs with missing links: ${output.jobsWithMissingLinks}`);

  if (output.jobsWithMissingLinks > 0) {
    for (const row of jobSummaries.filter((j) => j.missingLinks.length > 0).slice(0, 10)) {
      console.log(`- job ${row.jobId}: ${row.missingLinks.join(", ")}`);
    }
  }
}

main();
