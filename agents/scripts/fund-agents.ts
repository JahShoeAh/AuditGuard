/**
 * Fund Agent Wallets with GUARD Tokens
 *
 * Distributes GUARD tokens from the operator/treasury account to each agent wallet.
 * Must be run once before agents can submit bids, create listings, or settle payments.
 *
 * Usage:
 *   npx tsx scripts/fund-agents.ts
 *   npx tsx scripts/fund-agents.ts --amount 500   # custom amount per agent
 */

import { Client, AccountId, PrivateKey, TokenAssociateTransaction, TransferTransaction, TokenId } from "@hashgraph/sdk";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath, URL } from "url";
import { readFileSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dir, "..", ".env") });

// ─── Configuration ─────────────────────────────────────────────────────────

// Load GUARD token ID from SDK config
const sdkConfig = JSON.parse(
    readFileSync(join(__dir, "..", "..", "packages", "sdk", "config.json"), "utf-8")
);
const GUARD_TOKEN_ID = sdkConfig.guardTokenId;
const AMOUNT_PER_AGENT = parseInt(process.argv.find(a => a.startsWith("--amount="))?.split("=")[1] || "100", 10);

// Agent account mappings (from .env)
const AGENTS = [
    { name: "SCANNER", envPrefix: "SCANNER" },
    { name: "STATIC", envPrefix: "STATIC" },
    { name: "FUZZER", envPrefix: "FUZZER" },
    { name: "LLM", envPrefix: "LLM" },
    { name: "DEPENDENCY", envPrefix: "DEPENDENCY" },
    { name: "REPORT", envPrefix: "REPORT" },
    { name: "ALERT", envPrefix: "ALERT" },
];

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log("═══════════════════════════════════════════════════════");
    console.log("  GUARD Token Distribution to Agent Wallets");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Token ID:     ${GUARD_TOKEN_ID}`);
    console.log(`  Amount/agent: ${AMOUNT_PER_AGENT} GUARD`);
    console.log();

    // Operator (treasury) account
    const operatorId = AccountId.fromString(process.env.OPERATOR_ACCOUNT_ID!);
    const operatorKey = PrivateKey.fromStringECDSA(process.env.OPERATOR_PRIVATE_KEY!);

    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    const tokenId = TokenId.fromString(GUARD_TOKEN_ID);
    const decimals = 8;
    const rawAmount = AMOUNT_PER_AGENT * (10 ** decimals);

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const agent of AGENTS) {
        const accountIdStr = process.env[`${agent.envPrefix}_ACCOUNT_ID`];
        const privateKeyStr = process.env[`${agent.envPrefix}_PRIVATE_KEY`];

        if (!accountIdStr || !privateKeyStr) {
            console.log(`  ⚠ ${agent.name}: No credentials in .env — skipping`);
            skipCount++;
            continue;
        }

        // Skip if operator == agent (e.g. SCANNER shares operator account)
        if (accountIdStr === operatorId.toString()) {
            console.log(`  ○ ${agent.name}: Same as operator account — no transfer needed`);
            skipCount++;
            continue;
        }

        const agentAccountId = AccountId.fromString(accountIdStr);
        const agentKey = PrivateKey.fromStringECDSA(privateKeyStr);

        try {
            // Step 1: Associate GUARD token with agent account (if not already)
            try {
                const assocTx = new TokenAssociateTransaction()
                    .setAccountId(agentAccountId)
                    .setTokenIds([tokenId])
                    .freezeWith(client);

                // Agent must sign their own association
                const agentClient = Client.forTestnet();
                agentClient.setOperator(agentAccountId, agentKey);

                const signedTx = await assocTx.sign(agentKey);
                const response = await signedTx.execute(client);
                const receipt = await response.getReceipt(client);
                console.log(`  ✓ ${agent.name}: Token associated (status: ${receipt.status})`);
            } catch (err: any) {
                if (err.message?.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") || err.toString().includes("TOKEN_ALREADY_ASSOCIATED")) {
                    console.log(`  ○ ${agent.name}: Token already associated`);
                } else {
                    throw err;
                }
            }

            // Step 2: Transfer GUARD tokens from operator to agent
            const transferTx = new TransferTransaction()
                .addTokenTransfer(tokenId, operatorId, -rawAmount)
                .addTokenTransfer(tokenId, agentAccountId, rawAmount)
                .freezeWith(client);

            const response = await transferTx.execute(client);
            const receipt = await response.getReceipt(client);

            console.log(`  ✓ ${agent.name}: ${AMOUNT_PER_AGENT} GUARD transferred (status: ${receipt.status})`);
            successCount++;

        } catch (err) {
            console.error(`  ✗ ${agent.name}: Failed — ${err}`);
            failCount++;
        }
    }

    console.log();
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Results: ${successCount} funded, ${skipCount} skipped, ${failCount} failed`);
    console.log("═══════════════════════════════════════════════════════");

    client.close();
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(`Fatal error: ${err}`);
    process.exit(1);
});
