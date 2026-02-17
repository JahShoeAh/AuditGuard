/**
 * Connectivity Test — verifies all 7 agent wallets can connect to Hedera testnet.
 *
 * Usage: npx tsx test-connectivity.ts
 *
 * Checks:
 *   1. Each agent wallet loads from .env without errors
 *   2. Each Hedera Client can query account info (proves working credentials)
 *   3. One HCS publish to the discovery topic succeeds
 */

import { createAgentWallet, CONFIG } from "./shared/index.js";
import { AccountInfoQuery } from "@hashgraph/sdk";

const AGENTS = [
    "SCANNER",
    "STATIC",
    "FUZZER",
    "LLM",
    "DEPENDENCY",
    "REPORT",
    "ALERT",
];

async function main() {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║   AuditGuard Connectivity Test           ║");
    console.log("╚══════════════════════════════════════════╝\n");

    let passed = 0;
    let failed = 0;

    for (const agentName of AGENTS) {
        process.stdout.write(`  ${agentName.padEnd(12)} ... `);

        try {
            // Step 1: Load wallet
            const wallet = createAgentWallet(agentName);

            // Step 2: Query account info from Hedera
            const info = await new AccountInfoQuery()
                .setAccountId(wallet.accountId)
                .execute(wallet.hederaClient);

            const hbarBalance = info.balance.toBigNumber().toNumber();

            console.log(
                `✅  Account ${wallet.accountId}  |  ` +
                `EVM ${wallet.evmAddress.slice(0, 10)}...  |  ` +
                `${hbarBalance} tℏ`
            );
            passed++;
        } catch (err) {
            console.log(`❌  FAILED: ${err}`);
            failed++;
        }
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed out of ${AGENTS.length}`);

    if (failed === 0) {
        console.log("\n  🎉 All agents connected to Hedera testnet!\n");

        // Bonus: test HCS publish
        console.log("  Testing HCS publish to discovery topic...");
        try {
            const { HCSClient } = await import("./shared/index.js");
            const wallet = createAgentWallet("SCANNER");
            const hcs = new HCSClient(wallet.hederaClient);

            await hcs.publishDiscovery({
                type: "CONTRACT_DISCOVERED",
                agentId: "connectivity-test",
                timestamp: Date.now(),
                payload: {
                    contractAddress: "0x0000000000000000000000000000000000000000",
                    chain: "hedera-testnet",
                    deployerAddress: "0x0000000000000000000000000000000000000000",
                    estimatedLOC: 0,
                    contractType: "unknown",
                    riskScore: 0,
                    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                },
            });

            console.log(`  ✅  HCS publish to ${CONFIG.hcsTopics.discovery} succeeded!\n`);
        } catch (err) {
            console.log(`  ❌  HCS publish failed: ${err}\n`);
        }
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
