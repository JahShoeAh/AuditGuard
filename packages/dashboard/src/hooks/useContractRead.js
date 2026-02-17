import { useQuery } from '@tanstack/react-query';

/**
 * Generic hook for calling read-only (view) functions on ethers.js contracts,
 * powered by @tanstack/react-query for caching + polling.
 *
 * @param {import('ethers').Contract | null} contract
 * @param {string} method   Function name on the contract ABI
 * @param {any[]}  args     Positional args for the call
 * @param {object} [options]  react-query overrides (refetchInterval, enabled, …)
 *
 * @example
 *   const { data: count } = useContractRead(
 *     contracts.agentRegistryContract, 'getAgentCount', [],
 *     { refetchInterval: 10_000 }
 *   );
 */
export function useContractRead(contract, method, args = [], options = {}) {
  return useQuery({
    queryKey: ['contract', contract?.target, method, ...args],
    queryFn: async () => {
      if (!contract) throw new Error('Contract not initialised');
      const result = await contract[method](...args);
      return result;
    },
    enabled: !!contract,
    staleTime: 5_000,
    ...options,
  });
}
