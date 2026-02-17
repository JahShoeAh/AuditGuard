import { Client } from '@hashgraph/sdk';
import { JsonRpcProvider, Contract } from 'ethers';

// ABIs — resolved via @sdk Vite alias
import AgentRegistryABI from '@sdk/abis/AgentRegistry.json';
import AuditAuctionABI from '@sdk/abis/AuditAuction.json';
import AuditBudgetVaultABI from '@sdk/abis/AuditBudgetVault.json';
import SubAuctionABI from '@sdk/abis/SubAuction.json';
import DataMarketplaceABI from '@sdk/abis/DataMarketplace.json';
import PaymentSettlementABI from '@sdk/abis/PaymentSettlement.json';

// Config — static import via @sdk alias (Vite resolves at build time)
import sdkConfig from '@sdk/config.json';

// ---------- Mock config fallback ----------
// Used when Person 1's config.json isn't available yet
const MOCK_CONFIG = {
  guardTokenId: '0.0.0000000',
  guardTokenEvmAddress: '0x0000000000000000000000000000000000000000',
  hcsTopics: {
    discovery: '0.0.0000001',
    auditLog: '0.0.0000002',
    agentComms: '0.0.0000003',
  },
  contracts: {
    agentRegistry: {
      id: '0.0.mock-registry',
      evmAddress: '0x0000000000000000000000000000000000000001',
    },
    auctionContract: {
      id: '0.0.mock-auction',
      evmAddress: '0x0000000000000000000000000000000000000002',
    },
    budgetVault: {
      id: '0.0.mock-vault',
      evmAddress: '0x0000000000000000000000000000000000000003',
    },
    subAuction: {
      id: '0.0.mock-subauction',
      evmAddress: '0x0000000000000000000000000000000000000004',
    },
    dataMarketplace: {
      id: '0.0.mock-marketplace',
      evmAddress: '0x0000000000000000000000000000000000000005',
    },
    paymentSettlement: {
      id: '0.0.mock-settlement',
      evmAddress: '0x0000000000000000000000000000000000000006',
    },
  },
  seededAgents: {
    'StaticAnalysis-47': { evmAddress: '0xAgent1' },
    'Fuzzer-12': { evmAddress: '0xAgent2' },
    'LLMContextual-3': { evmAddress: '0xAgent3' },
  },
  demoVault: {
    contractAddress: '0x000000000000000000000000000000000000dEaD',
    budget: 200,
    weeklyMonitoring: 10,
    criticalBounty: 50,
    funded: true,
  },
};

// ---------- a) loadConfig ----------
export function loadConfig() {
  if (sdkConfig && sdkConfig.guardTokenId) {
    console.log('[AuditGuard] Loaded config from @sdk/config.json');
    return sdkConfig;
  }
  console.warn('[AuditGuard] SDK config not available, using mock config');
  return MOCK_CONFIG;
}

// ---------- b) createHederaClient ----------
export function createHederaClient() {
  const client = Client.forTestnet();
  // Dashboard is read-only — no operator needed for mirror node queries
  console.log('[AuditGuard] Hedera Client initialized (testnet, read-only)');
  return client;
}

// ---------- c) createEthersProvider ----------
export function createEthersProvider() {
  const rpcUrl = import.meta.env.VITE_HEDERA_JSON_RPC || 'https://testnet.hashio.io/api';
  const provider = new JsonRpcProvider(rpcUrl);
  console.log(`[AuditGuard] Ethers provider connected to ${rpcUrl}`);
  return provider;
}

// ---------- d) createContractInstances ----------
export function createContractInstances(provider, config) {
  const agentRegistryContract = new Contract(
    config.contracts.agentRegistry.evmAddress,
    AgentRegistryABI.abi,
    provider
  );

  const auctionContract = new Contract(
    config.contracts.auctionContract.evmAddress,
    AuditAuctionABI.abi,
    provider
  );

  const budgetVaultContract = new Contract(
    config.contracts.budgetVault.evmAddress,
    AuditBudgetVaultABI.abi,
    provider
  );

  const subAuctionContract = new Contract(
    config.contracts.subAuction.evmAddress,
    SubAuctionABI.abi,
    provider
  );

  const dataMarketplaceContract = new Contract(
    config.contracts.dataMarketplace.evmAddress,
    DataMarketplaceABI.abi,
    provider
  );

  const paymentSettlementContract = new Contract(
    config.contracts.paymentSettlement.evmAddress,
    PaymentSettlementABI.abi,
    provider
  );

  console.log('[AuditGuard] Contract instances created (read-only)');
  return {
    agentRegistryContract,
    auctionContract,
    budgetVaultContract,
    subAuctionContract,
    dataMarketplaceContract,
    paymentSettlementContract,
  };
}

// ---------- e) initializeConnection ----------
export async function initializeConnection() {
  const config = loadConfig();
  const hederaClient = createHederaClient();
  const ethersProvider = createEthersProvider();
  const contracts = createContractInstances(ethersProvider, config);

  // Test connectivity by calling a view function
  try {
    const agentCount = await contracts.agentRegistryContract.getAgentCount();
    console.log(`[AuditGuard] Connection verified — ${agentCount} agents registered`);
  } catch (err) {
    console.warn('[AuditGuard] Could not verify connection (contract may not be deployed yet):', err.message);
  }

  return { config, hederaClient, ethersProvider, contracts };
}
