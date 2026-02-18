import { useState, useEffect } from 'react';
import useStore from '../store/index';
import { getVaultInstance } from '../services/hedera-connection';

/**
 * Builds an enriched list of contract health objects for the health grid.
 * Merges store.contractHealth (from AuditRecorded events / mock data)
 * with store.discoveries (for contract type / chain metadata).
 *
 * When a live connection is available, polls VaultFactory.getAllVaults()
 * and per-vault AuditVault.getVaultSummary() every 20s.
 */
export function useContractHealth() {
  const contractHealth = useStore((s) => s.contractHealth);
  const discoveries    = useStore((s) => s.discoveries);
  const contracts      = useStore((s) => s.contracts);
  const ethersProvider = useStore((s) => s.ethersProvider);
  const useMockEvents  = useStore((s) => s.useMockEvents);

  const [enriched, setEnriched] = useState([]);

  // Rebuild enriched list on any store change
  useEffect(() => {
    const combined = Object.entries(contractHealth).map(([addr, health]) => {
      const disc = discoveries.find(
        (d) => d.contractAddress?.toLowerCase() === addr.toLowerCase()
      );
      return {
        ...health,
        contractAddress: addr,
        contractType:  disc?.contractType  || health.contractType  || 'UNKNOWN',
        contractChain: disc?.chain         || health.contractChain || 'hedera',
        tvlEstimate:   disc?.tvlEstimate   || null,
      };
    });
    setEnriched(combined);
  }, [contractHealth, discoveries]);

  // Poll VaultFactory + AuditVault when live
  useEffect(() => {
    if (useMockEvents) return;
    if (!contracts?.vaultFactoryContract || !ethersProvider) return;

    const poll = async () => {
      try {
        const vaults = await contracts.vaultFactoryContract.getAllVaults();
        for (const vaultAddr of vaults) {
          try {
            const vault = getVaultInstance(vaultAddr, ethersProvider);
            const summary = await vault.getVaultSummary();
            // summary returns tuple:
            // (contractAddress, balance, reserved, bountyRemaining, lastAudit, securityScore, monitoringActive, reauditDue)
            const [
              contractAddr, balance, reserved, bountyRemaining,
              lastAudit, securityScore, monitoringActive, reauditDue,
            ] = summary;

            const existing = useStore.getState().contractHealth[contractAddr] || {};
            useStore.getState().setContractHealth(contractAddr, {
              ...existing,
              vaultAddress: vaultAddr,
              vaultBalance: balance.toString(),
              vaultReserved: reserved.toString(),
              bountyRemaining: bountyRemaining.toString(),
              lastAudit: Number(lastAudit) * 1000,
              securityScore: Number(securityScore),
              monitoringActive,
              reauditDue,
            });
          } catch {
            // Skip individual vault errors
          }
        }
      } catch (err) {
        console.warn('[useContractHealth] VaultFactory poll error:', err.message);
      }
    };

    const id = setInterval(poll, 20_000);
    poll();
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, ethersProvider, useMockEvents]);

  return { contracts: enriched };
}
