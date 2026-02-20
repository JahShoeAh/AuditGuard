import { BrowserProvider, formatEther } from 'ethers';
import { create } from 'zustand';

const HEDERA_TESTNET_HEX_CHAIN_ID = '0x128';
const HEDERA_TESTNET_DEC_CHAIN_ID = '296';
const BALANCE_POLL_MS = 30_000;

let balancePollInterval = null;
let ethereumListenersBound = false;

function shortenAddress(address) {
  if (!address) return null;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function ensureHederaTestnet(ethereum) {
  const chainId = await ethereum.request({ method: 'eth_chainId' });
  if (chainId === HEDERA_TESTNET_HEX_CHAIN_ID) return;

  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: HEDERA_TESTNET_HEX_CHAIN_ID }],
    });
  } catch (switchError) {
    if (switchError?.code !== 4902) throw switchError;

    await ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: HEDERA_TESTNET_HEX_CHAIN_ID,
        chainName: 'Hedera Testnet',
        rpcUrls: ['https://testnet.hashio.io/api'],
        nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
        blockExplorerUrls: ['https://hashscan.io/testnet'],
      }],
    });
  }
}

function clearBalancePolling() {
  if (balancePollInterval) {
    clearInterval(balancePollInterval);
    balancePollInterval = null;
  }
}

function bindEthereumListeners() {
  if (ethereumListenersBound || typeof window === 'undefined' || !window.ethereum) return;

  window.ethereum.on('accountsChanged', (accounts) => {
    const state = useWalletStore.getState();
    if (!accounts?.length) {
      state.disconnect();
      return;
    }
    const nextAddress = accounts[0];
    useWalletStore.setState({
      address: nextAddress,
      displayName: shortenAddress(nextAddress),
    });
    state.refreshBalances();
  });

  window.ethereum.on('chainChanged', (chainId) => {
    if (chainId !== HEDERA_TESTNET_HEX_CHAIN_ID) {
      useWalletStore.setState({
        connectionStatus: 'error',
        error: `Wrong network (${chainId}). Please switch to Hedera Testnet (${HEDERA_TESTNET_DEC_CHAIN_ID}).`,
      });
      return;
    }
    const state = useWalletStore.getState();
    if (state.connectionStatus === 'connected') state.refreshBalances();
  });

  ethereumListenersBound = true;
}

export const useWalletStore = create((set, get) => ({
  connectionStatus: 'disconnected',
  walletType: null,
  error: null,

  address: null,
  hederaAccountId: null,
  displayName: null,

  signer: null,
  provider: null,

  hbarBalance: null,

  isModalOpen: false,
  modalContext: null,

  openWalletModal: (context = null) => set({ isModalOpen: true, modalContext: context }),
  closeWalletModal: () => set({ isModalOpen: false, modalContext: null }),

  connect: async (type) => {
    if (type !== 'metamask') {
      set({
        connectionStatus: 'error',
        walletType: null,
        error: 'HashPack support coming soon. Please use MetaMask for now.',
      });
      return false;
    }

    try {
      set({
        connectionStatus: 'connecting',
        walletType: type,
        error: null,
      });

      if (typeof window === 'undefined' || !window.ethereum) {
        throw new Error('MetaMask not detected. Install MetaMask to connect.');
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' });
      await ensureHederaTestnet(window.ethereum);

      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();

      set({
        connectionStatus: 'connected',
        walletType: 'metamask',
        address,
        displayName: shortenAddress(address),
        signer,
        provider,
        error: null,
        isModalOpen: false,
        modalContext: null,
      });

      bindEthereumListeners();
      await get().refreshBalances();

      clearBalancePolling();
      balancePollInterval = setInterval(() => {
        const state = useWalletStore.getState();
        if (state.connectionStatus === 'connected') {
          state.refreshBalances();
        }
      }, BALANCE_POLL_MS);

      return true;
    } catch (error) {
      set({
        connectionStatus: 'error',
        walletType: null,
        signer: null,
        provider: null,
        address: null,
        displayName: null,
        hbarBalance: null,
        error: error?.message || 'Wallet connection failed',
      });
      return false;
    }
  },

  disconnect: () => {
    clearBalancePolling();
    set({
      connectionStatus: 'disconnected',
      walletType: null,
      error: null,
      address: null,
      hederaAccountId: null,
      displayName: null,
      signer: null,
      provider: null,
      hbarBalance: null,
      isModalOpen: false,
      modalContext: null,
    });
  },

  refreshBalances: async () => {
    const { signer, address } = get();
    if (!signer || !address) return;

    try {
      const provider = signer.provider;
      const hbarRaw = await provider.getBalance(address);
      set({ hbarBalance: Number(formatEther(hbarRaw)) });
    } catch (error) {
      set({ error: error?.message || 'Failed to refresh wallet balances' });
    }
  },

  isConnected: () => get().connectionStatus === 'connected',
}));

export default useWalletStore;
