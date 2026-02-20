import { useState } from 'react';
import { ethers } from 'ethers';
import { useWalletStore } from '../store/wallet';
import config from '@sdk/config.json';

const HBAR_POOL_ABI = [
  'function hbarToGuard() payable returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

// Fixed rate: 1 HBAR = 100 GUARD (both 8 decimals on Hedera)
const RATE = 100;

function getTargetAddress(contractInstance) {
  return contractInstance?.target ?? contractInstance?.address ?? null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simplified HBAR swap hook.
 *
 * With HbarPool at a fixed 100:1 rate, quoting is pure math.
 * Delegation ops use single-tx contract calls (delegateWithHbar, etc.).
 * This hook is still used for non-delegation ops (agent registration,
 * report purchase) that need: HBAR → GUARD → approve → execute.
 */
export function useHbarSwap() {
  const { signer, provider, address } = useWalletStore();

  const [isSwapping, setIsSwapping] = useState(false);
  const [swapStep, setSwapStep] = useState(null);
  const [swapError, setSwapError] = useState(null);

  const hbarPoolAddress = config?.contracts?.hbarPool?.evmAddress;
  const guardTokenAddress = config?.guardTokenEvmAddress;

  /** Pure-math quote: how much GUARD for X HBAR */
  function quoteGuardForHbar(hbarAmount) {
    const n = parseFloat(hbarAmount || '0');
    if (!Number.isFinite(n) || n <= 0) return '0';
    return (n * RATE).toFixed(2);
  }

  /** Pure-math quote: how much HBAR for X GUARD */
  function quoteHbarForGuard(guardAmount) {
    const n = parseFloat(guardAmount || '0');
    if (!Number.isFinite(n) || n <= 0) return '0';
    return (n / RATE).toFixed(4);
  }

  /**
   * Convert HBAR → GUARD via HbarPool, approve to target, call target method.
   * Used for agent registration and report purchases (contracts that still
   * accept GUARD directly).
   *
   * @param {string} guardAmountHuman  GUARD amount needed (human units)
   * @param {Contract} targetContract  Contract to call after conversion
   * @param {string} method           Method name on targetContract
   * @param {Array} args              Arguments for the method
   */
  async function swapAndExecute(guardAmountHuman, targetContract, method, args) {
    if (!signer || !provider || !address) throw new Error('Wallet not connected');
    if (!hbarPoolAddress || !guardTokenAddress) throw new Error('HbarPool or GUARD token config missing');

    setIsSwapping(true);
    setSwapError(null);

    try {
      const guardContract = new ethers.Contract(guardTokenAddress, ERC20_ABI, signer);
      const pool = new ethers.Contract(hbarPoolAddress, HBAR_POOL_ABI, signer);

      setSwapStep('quoting');
      // Calculate HBAR needed: GUARD / RATE, then convert tinybars → weibars
      const guardBaseUnits = ethers.parseUnits(String(guardAmountHuman), 8);
      const hbarTinybars = guardBaseUnits / BigInt(RATE);
      const hbarWei = hbarTinybars * (10n ** 10n);
      // Add 2% buffer for rounding
      const hbarWithBuffer = (hbarWei * 102n) / 100n;

      setSwapStep('swapping');
      const balanceBefore = await guardContract.balanceOf(address);
      const swapTx = await pool.hbarToGuard({ value: hbarWithBuffer, gasLimit: 300_000 });
      await swapTx.wait();
      await delay(2000);

      const balanceAfter = await guardContract.balanceOf(address);
      const guardReceived = balanceAfter - balanceBefore;
      if (guardReceived <= 0n) throw new Error('No GUARD received from HbarPool');

      setSwapStep('approving');
      const targetAddress = getTargetAddress(targetContract);
      if (!targetAddress) throw new Error('Target contract address not found');
      const approveTx = await guardContract.approve(targetAddress, ethers.MaxUint256, { gasLimit: 200_000 });
      await approveTx.wait();
      await delay(2000);

      setSwapStep('executing');
      const writableTarget = targetContract.connect(signer);
      const tx = await writableTarget[method](...(args || []), { gasLimit: 500_000 });
      const receipt = await tx.wait();

      setSwapStep('done');
      setIsSwapping(false);
      return receipt;
    } catch (err) {
      setSwapStep('error');
      setSwapError(err?.message ?? String(err));
      setIsSwapping(false);
      throw err;
    }
  }

  return {
    quoteGuardForHbar,
    quoteHbarForGuard,
    swapAndExecute,
    isSwapping,
    swapStep,
    swapError,
    reset: () => {
      setIsSwapping(false);
      setSwapStep(null);
      setSwapError(null);
    },
  };
}
