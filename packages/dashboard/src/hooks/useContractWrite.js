import { useState } from 'react';
import { Contract } from 'ethers';
import useWalletStore from '../store/wallet';
import { loadConfig } from '../services/hedera-connection';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

function parseErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (error.code === 4001 || error.code === 'ACTION_REJECTED') return 'Transaction rejected by user';
  if (error.reason) return error.reason;
  if (error.message) {
    if (error.message.includes('insufficient')) return 'Insufficient GUARD balance';
    if (error.message.includes('not accepting')) return 'Agent is not accepting delegations';
    if (error.message.includes('gas')) return 'Gas estimation failed — check contract state';
    return error.message.slice(0, 120);
  }
  return 'Transaction failed';
}

/**
 * Hook for executing write transactions against any contract method.
 * Manages status transitions: idle → confirming → success | error
 */
export function useContractWrite() {
  const signer = useWalletStore((s) => s.signer);

  const [state, setState] = useState({
    status: 'idle', // idle | approving | confirming | success | error
    txHash: null,
    error: null,
  });

  const execute = async (contract, method, args) => {
    if (!signer) throw new Error('Wallet not connected');

    const writableContract = contract.connect(signer);
    setState({ status: 'confirming', txHash: null, error: null });

    try {
      const tx = await writableContract[method](...args);
      setState((s) => ({ ...s, txHash: tx.hash }));
      const receipt = await tx.wait();
      setState({ status: 'success', txHash: tx.hash, error: null });
      return receipt;
    } catch (error) {
      const message = parseErrorMessage(error);
      setState({ status: 'error', txHash: null, error: message });
      throw error;
    }
  };

  const reset = () => setState({ status: 'idle', txHash: null, error: null });

  return { execute, ...state, reset };
}

/**
 * Hook that checks whether a GUARD token approval is needed for a given
 * spender + amount, and can trigger the approval transaction.
 *
 * @param {string|null}  spenderAddress  Contract address to approve (e.g. DelegatedStaking)
 * @param {bigint|null}  amount          Amount in 8-decimal GUARD units (GUARD has 8 decimals on Hedera HTS)
 */
export function useGuardApproval(spenderAddress, amount) {
  const signer = useWalletStore((s) => s.signer);
  const address = useWalletStore((s) => s.address);

  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Returns true if the current allowance is less than `amount`.
   */
  const needsApproval = async () => {
    if (!signer || !address || !spenderAddress || !amount) return true;
    try {
      const config = loadConfig();
      const guardContract = new Contract(
        config.guardTokenEvmAddress,
        ERC20_ABI,
        signer.provider ?? signer,
      );
      const currentAllowance = await guardContract.allowance(address, spenderAddress);
      return currentAllowance < amount;
    } catch {
      return true;
    }
  };

  /**
   * Checks allowance and, if insufficient, submits an ERC-20 approve tx.
   * Returns true if an approval tx was sent, false if already approved.
   */
  const approve = async () => {
    if (!signer || !address || !spenderAddress || !amount) {
      throw new Error('Missing required parameters for GUARD approval');
    }

    const config = loadConfig();
    const guardContract = new Contract(config.guardTokenEvmAddress, ERC20_ABI, signer);
    const currentAllowance = await guardContract.allowance(address, spenderAddress);

    if (currentAllowance >= amount) {
      return false;
    }

    setIsApproving(true);
    setError(null);
    try {
      const tx = await guardContract.approve(spenderAddress, amount);
      await tx.wait();
      return true;
    } catch (err) {
      const message = parseErrorMessage(err);
      setError(message);
      throw err;
    } finally {
      setIsApproving(false);
    }
  };

  return { approve, needsApproval, isApproving, error };
}
