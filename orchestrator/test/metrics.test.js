/**
 * Quick verification that Prometheus metrics exports are working.
 * Run with: node orchestrator/test/metrics.test.js
 */

import { getMetrics, auctionsCreated, activeJobs } from '../src/metrics.js';

console.log('Testing Prometheus metrics...');

// Increment some counters
auctionsCreated.inc();
activeJobs.set(5);

// Get metrics output
const metricsOutput = await getMetrics();

// Verify format
if (!metricsOutput.includes('# HELP')) {
  throw new Error('Metrics output missing HELP comments');
}

if (!metricsOutput.includes('auditguard_auctions_created_total')) {
  throw new Error('Missing auctions_created_total metric');
}

if (!metricsOutput.includes('auditguard_active_jobs')) {
  throw new Error('Missing active_jobs metric');
}

// Verify default metrics are present
if (!metricsOutput.includes('process_cpu')) {
  throw new Error('Missing default CPU metrics');
}

if (!metricsOutput.includes('nodejs_eventloop')) {
  throw new Error('Missing event loop metrics');
}

console.log('✅ All metrics tests passed!');
console.log('\nSample metrics output:');
console.log('─'.repeat(80));
console.log(metricsOutput.split('\n').slice(0, 20).join('\n'));
console.log('...');
console.log('─'.repeat(80));
