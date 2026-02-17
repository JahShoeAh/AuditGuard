/**
 * iNFT Bridge — thin adapter between agent layer and packages/inft INFTService.
 *
 * Lazy-initialises the INFTService with operator credentials and provides
 * typed async methods for minting, state transitions, and reputation updates.
 *
 * The bridge gracefully degrades: if iNFT minting fails (e.g., operator account
 * issue, 0g offline), agents still function — errors are logged and swallowed.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getAgentEnv } from "./config.js";

const __bridgeDir = dirname(fileURLToPath(import.meta.url));
const INFT_SERVICE_PATH = join(__bridgeDir, "..", "..", "packages", "inft", "src", "inft-service.js");

// ─── Types matching INFTService method signatures ──────────────────────────

export interface DiscoveryMintParams {
    contractAddress: string;
    chain: string;
    contractType?: string;
    lineCount?: number;
    riskScore?: number;
    scannerAgentId: string;
    hcsMessageId?: string;
    jobId?: number;
}

export interface AgentRegistrationParams {
    agentAddress: string;
    agentId: string;
    ucpEndpoint: string;
    specializations: string[];
    stakedAmount: number;
    initialReputation: number;
}

export interface ContractHealthParams {
    contractAddress: string;
    chain: string;
    contractType?: string;
    currentCodeHash?: string;
    initialRiskScore?: number;
}

export interface AuditResultParams {
    jobId: number;
    newSecurityScore: number;
    agentsInvolved: string[];
    findingsCount: number;
    criticalFindings: number;
    totalCostGuard: number;
    reportHash?: string;
    auditJobTokenId?: string;
}

// ─── Bridge ────────────────────────────────────────────────────────────────

let _service: any = null;
let _initAttempted = false;

async function getService(): Promise<any> {
    if (_service) return _service;
    if (_initAttempted) return null; // already failed once, don't retry every call
    _initAttempted = true;

    try {
        // Dynamic import of the CJS inft-service module
        const mod = await import(INFT_SERVICE_PATH);
        const INFTService = mod.INFTService || mod.default?.INFTService;
        if (!INFTService) {
            console.warn("[iNFT-Bridge] INFTService class not found in module");
            return null;
        }

        // Use operator/deployer credentials (has supply key authority)
        // Try HEDERA_ first, fall back to OPERATOR_ (the deployer account)
        let accountId: string, privateKey: string;
        try {
            ({ accountId, privateKey } = getAgentEnv("HEDERA"));
        } catch {
            ({ accountId, privateKey } = getAgentEnv("OPERATOR"));
        }
        _service = new INFTService({
            operatorId: accountId,
            operatorKey: privateKey,
            keyType: "ECDSA",
        });

        console.log("[iNFT-Bridge] INFTService initialized successfully");
        return _service;
    } catch (err) {
        console.warn(`[iNFT-Bridge] Failed to initialize INFTService: ${err}`);
        return null;
    }
}

/**
 * Safely call an INFTService method. Returns the result or null on failure.
 */
async function safeCall<T>(methodName: string, ...args: any[]): Promise<T | null> {
    const svc = await getService();
    if (!svc || typeof svc[methodName] !== "function") return null;

    try {
        return await svc[methodName](...args);
    } catch (err) {
        console.warn(`[iNFT-Bridge] ${methodName} failed: ${err}`);
        return null;
    }
}

// ─── Public API ────────────────────────────────────────────────────────────

export const INFTBridge = {
    /**
     * Mint an Audit Job iNFT when Scanner discovers a new contract.
     * Returns { serialNumber, metadata } or null.
     */
    async mintAuditJobINFT(params: DiscoveryMintParams) {
        return safeCall("mintAuditJobINFT", params);
    },

    /**
     * Mint an Agent Profile iNFT when an agent registers.
     * Returns { serialNumber, metadata } or null.
     */
    async mintAgentProfileINFT(params: AgentRegistrationParams) {
        return safeCall("mintAgentProfileINFT", params);
    },

    /**
     * Mint a Contract Health iNFT for a new contract being audited for the first time.
     * Returns { serialNumber, metadata } or null.
     */
    async mintContractHealthINFT(params: ContractHealthParams) {
        return safeCall("mintContractHealthINFT", params);
    },

    /**
     * Transition an Audit Job iNFT to a new state.
     */
    async transitionJobState(serialNumber: number, newState: string, trigger: string, txHash?: string) {
        return safeCall("transitionAuditJobState", serialNumber, newState, trigger, txHash);
    },

    /**
     * Update reputation on an Agent Profile iNFT.
     */
    async updateAgentReputation(serialNumber: number, delta: number, reason: string, jobId?: number, txHash?: string) {
        return safeCall("updateAgentReputation", serialNumber, delta, reason, jobId, txHash);
    },

    /**
     * Record an audit result on a Contract Health iNFT.
     */
    async recordAuditOnHealth(serialNumber: number, auditResult: AuditResultParams) {
        return safeCall("recordAuditOnContractHealth", serialNumber, auditResult);
    },

    /**
     * Add a participant to an Audit Job iNFT.
     */
    async addJobParticipant(serialNumber: number, participant: { agentAddress: string; role: string;[key: string]: any }) {
        return safeCall("addJobParticipant", serialNumber, participant);
    },

    /**
     * Update auction data on an Audit Job iNFT.
     */
    async updateAuctionData(serialNumber: number, auctionData: Record<string, any>) {
        return safeCall("updateAuctionData", serialNumber, auctionData);
    },

    /**
     * Update payment data on an Audit Job iNFT.
     */
    async updatePaymentData(serialNumber: number, paymentData: Record<string, any>) {
        return safeCall("updatePaymentData", serialNumber, paymentData);
    },

    /**
     * Close the underlying INFTService Hedera client.
     */
    async close() {
        if (_service && typeof _service.close === "function") {
            _service.close();
        }
        _service = null;
        _initAttempted = false;
    },
};
