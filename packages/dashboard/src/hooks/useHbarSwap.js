import { useState } from 'react';
import { ethers } from 'ethers';
import { useWalletStore } from '../store/wallet';
import config from '@sdk/config.json';

const EXCHANGE_ABI = [
  'function buyGuard(uint256 minGuardOut) payable returns (uint256)',
  'function sellGuard(uint256 guardIn, uint256 minHbarOut) returns (uint256)',
  'function quoteGuardOut(uint256 hbarIn) view returns (uint256)',
  'function quoteHbarIn(uint256 guardOut) view returns (uint256)',
  'function getRate() view returns (uint256)',
  'function getReserves() view returns (uint256 hbarReserve, uint256 guardReserve)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const TRANSFER_EVENT_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const SWAP_EVENT_ABI = [
  'event Swap(address indexed sender, uint256 hbarIn, uint256 guardIn, uint256 hbarOut, uint256 guardOut)',
];

function getTargetAddress(contractInstance) {
  return contractInstance?.target ?? contractInstance?.address ?? null;
}

function toFourDecimals(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(4);
}

export function useHbarSwap() {
  const { signer, provider, address } = useWalletStore();

  const [isSwapping, setIsSwapping] = useState(false);
  const [swapStep, setSwapStep] = useState(null);
  const [swapError, setSwapError] = useState(null);

  const exchangeAddress = config?.contracts?.guardExchange?.evmAddress;
  const guardTokenAddress = config?.guardTokenEvmAddress;

  async function quoteHbarCost(guardAmount) {
    try {
      if (!guardAmount || Number(guardAmount) <= 0) return '0';
      if (!exchangeAddress || !provider) return '0';

      const exchange = new ethers.Contract(exchangeAddress, EXCHANGE_ABI, provider);
      const guardBaseUnits = ethers.parseUnits(String(guardAmount), 8);
      const hbarTinybars = await exchange.quoteHbarIn(guardBaseUnits);
      // Convert tinybars (8 decimals) to weibars (18 decimals) for ethers.js
      const hbarWei = hbarTinybars * (10n ** 10n);
      const bufferedHbarWei = (hbarWei * 101n) / 100n;
      return toFourDecimals(ethers.formatEther(bufferedHbarWei));
    } catch {
      return '0';
    }
  }

  async function swapAndExecute(guardAmountHuman, targetContract, method, args, options = {}) {
    if (!signer || !provider || !address) {
      throw new Error('Wallet not connected');
    }
    if (!exchangeAddress || !guardTokenAddress) {
      throw new Error('GuardExchange or GUARD token config is missing');
    }

    setIsSwapping(true);
    setSwapError(null);

    try {
      const exchange = new ethers.Contract(exchangeAddress, EXCHANGE_ABI, provider);

      setSwapStep('quoting');
      const guardBaseUnits = ethers.parseUnits(String(guardAmountHuman), 8);
      const hbarNeededTinybars = await exchange.quoteHbarIn(guardBaseUnits);
      // CRITICAL: Contract returns tinybars (8 decimals), but ethers.js { value: } expects weibars (18 decimals)
      const hbarNeededWei = hbarNeededTinybars * (10n ** 10n);
      const slippageBps = options.slippageBps ?? 100;
      const hbarWithSlippage = (hbarNeededWei * BigInt(10000 + slippageBps)) / 10000n;
      const minGuardOut = (guardBaseUnits * 99n) / 100n;

      setSwapStep('swapping');
      const writableExchange = exchange.connect(signer);
      const swapTx = await writableExchange.buyGuard(minGuardOut, {
        value: hbarWithSlippage,
      });
      await swapTx.wait();

      setSwapStep('approving');
      const targetAddress = getTargetAddress(targetContract);
      if (!targetAddress) {
        throw new Error('Target contract address not found');
      }
      const guardContract = new ethers.Contract(guardTokenAddress, ERC20_ABI, signer);
      const currentAllowance = await guardContract.allowance(address, targetAddress);
      if (currentAllowance < guardBaseUnits) {
        const approveTx = await guardContract.approve(targetAddress, guardBaseUnits);
        await approveTx.wait();
      }

      setSwapStep('executing');
      const writableTarget = targetContract.connect(signer);
      const tx = await writableTarget[method](...(args || []));
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

  async function claimAndConvert(agentAddress, delegatedStakingContract) {
    if (!signer || !provider || !address) {
      throw new Error('Wallet not connected');
    }
    if (!exchangeAddress || !guardTokenAddress) {
      throw new Error('GuardExchange or GUARD token config is missing');
    }

    setIsSwapping(true);
    setSwapError(null);

    try {
      const guardContract = new ethers.Contract(guardTokenAddress, ERC20_ABI, signer);
      const exchange = new ethers.Contract(exchangeAddress, EXCHANGE_ABI, provider);
      const transferIface = new ethers.Interface(TRANSFER_EVENT_ABI);
      const swapIface = new ethers.Interface(SWAP_EVENT_ABI);

      const balanceBefore = await guardContract.balanceOf(address);

      setSwapStep('executing');
      const writableDS = delegatedStakingContract.connect(signer);
      const claimTx = await writableDS.claimRewards(agentAddress);
      const claimReceipt = await claimTx.wait();

      let claimedBaseUnits = 0n;
      for (const log of claimReceipt.logs || []) {
        if (!log?.address || log.address.toLowerCase() !== guardTokenAddress.toLowerCase()) continue;
        try {
          const parsed = transferIface.parseLog(log);
          if (parsed?.name === 'Transfer' && String(parsed.args.to).toLowerCase() === address.toLowerCase()) {
            claimedBaseUnits += parsed.args.value;
          }
        } catch {
          // Non-Transfer log; ignore.
        }
      }

      if (claimedBaseUnits === 0n) {
        const balanceAfter = await guardContract.balanceOf(address);
        claimedBaseUnits = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
      }

      if (claimedBaseUnits === 0n) {
        setSwapStep('done');
        setIsSwapping(false);
        return { guardClaimed: '0', hbarReceived: '0' };
      }

      setSwapStep('approving');
      const approveTx = await guardContract.approve(exchangeAddress, claimedBaseUnits);
      await approveTx.wait();

      setSwapStep('converting');
      const writableExchange = exchange.connect(signer);
      const sellTx = await writableExchange.sellGuard(claimedBaseUnits, 0n);
      const sellReceipt = await sellTx.wait();

      let hbarReceivedWei = 0n;
      for (const log of sellReceipt.logs || []) {
        if (!log?.address || log.address.toLowerCase() !== exchangeAddress.toLowerCase()) continue;
        try {
          const parsed = swapIface.parseLog(log);
          if (parsed?.name === 'Swap' && String(parsed.args.sender).toLowerCase() === address.toLowerCase()) {
            hbarReceivedWei = parsed.args.hbarOut;
            break;
          }
        } catch {
          // Non-Swap log; ignore.
        }
      }

      setSwapStep('done');
      setIsSwapping(false);
      return {
        guardClaimed: ethers.formatUnits(claimedBaseUnits, 8),
        hbarReceived: ethers.formatEther(hbarReceivedWei),
      };
    } catch (err) {
      setSwapStep('error');
      setSwapError(err?.message ?? String(err));
      setIsSwapping(false);
      throw err;
    }
  }

  async function getExchangeRate() {
    try {
      if (!exchangeAddress || !provider) {
        return { hbarPerGuard: '0', guardPerHbar: '0' };
      }

      const exchange = new ethers.Contract(exchangeAddress, EXCHANGE_ABI, provider);
      const [rate, reserves] = await Promise.all([exchange.getRate(), exchange.getReserves()]);
      const hbarReserve = reserves[0];
      const guardReserve = reserves[1];

      if (hbarReserve === 0n || guardReserve === 0n) {
        return { hbarPerGuard: '0', guardPerHbar: '0' };
      }

      const guardPerHbarRaw = (guardReserve * 100n) / hbarReserve;
      const guardPerHbar = (Number(guardPerHbarRaw) / 100).toFixed(2);

      return {
        hbarPerGuard: ethers.formatEther(rate),
        guardPerHbar,
      };
    } catch {
      return { hbarPerGuard: '0', guardPerHbar: '0' };
    }
  }

  return {
    quoteHbarCost,
    swapAndExecute,
    claimAndConvert,
    getExchangeRate,
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
