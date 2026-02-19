/**
 * Per-agent wallet management.
 *
 * Provides a single place to resolve agent credentials from environment
 * variables, create an ethers.js Wallet (for EVM contract calls), and
 * return the raw Hedera AccountId / PrivateKey (for HCS operations).
 *
 * Env-var convention:
 *   {AGENT_PREFIX}_ACCOUNT_ID / {AGENT_PREFIX}_PRIVATE_KEY
 *   Falls back to OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY
 */

import { ethers } from "ethers";
import {
    AccountId,
    PrivateKey,
    Client,
} from "@hashgraph/sdk";
import { getAgentEnv } from "./config.js";

const HEDERA_TESTNET_RPC = "https://testnet.hashio.io/api";

export interface AgentWallet {
    /** ethers.js Wallet connected to Hedera JSON-RPC (for EVM contract calls) */
    evmWallet: ethers.Wallet;
    /** ethers.js Provider */
    provider: ethers.JsonRpcProvider;
    /** Hedera account ID string (e.g., "0.0.12345") */
    accountId: string;
    /** Hedera PrivateKey object (for HCS publish/subscribe) */
    hederaKey: PrivateKey;
    /** Pre-configured Hedera Client (for HCS operations) */
    hederaClient: Client;
    /** EVM address derived from the private key */
    evmAddress: string;
}

/**
 * Attempt to parse a hex private key.
 * Supports raw 64-char hex (ECDSA secp256k1) and 0x-prefixed.
 */
function parseHederaKey(rawKey: string): PrivateKey {
    const key = rawKey.trim().replace(/^['"]|['"]$/g, "");
    const stripped = key.startsWith("0x") ? key.slice(2) : key;

    // 64-char hex → ECDSA (most common for EVM-compatible agents)
    if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
        return PrivateKey.fromStringECDSA(stripped);
    }

    // Try generic fromString (handles DER-encoded, ED25519, etc.)
    return PrivateKey.fromString(key);
}

/**
 * Create a fully configured wallet for a given agent.
 *
 * @param agentName - Agent name prefix used to look up env vars
 *   (e.g., "SCANNER" → looks for SCANNER_ACCOUNT_ID / SCANNER_PRIVATE_KEY)
 */
export function createAgentWallet(agentName: string): AgentWallet {
    const { accountId, privateKey } = getAgentEnv(agentName);

    const hederaKey = parseHederaKey(privateKey);

    // Hedera Client for HCS
    const hederaClient = Client.forTestnet();
    hederaClient.setOperator(
        AccountId.fromString(accountId),
        hederaKey
    );

    // ethers.js Wallet for EVM contract calls
    // We need the raw hex key for ethers — extract from the Hedera key
    const hexKey = hederaKey.toStringRaw();
    const provider = new ethers.JsonRpcProvider(HEDERA_TESTNET_RPC, undefined, { batchMaxCount: 1 });
    const evmWallet = new ethers.Wallet(hexKey, provider);

    return {
        evmWallet,
        provider,
        accountId,
        hederaKey,
        hederaClient,
        evmAddress: evmWallet.address,
    };
}
