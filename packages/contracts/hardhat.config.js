require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
const { PrivateKey } = require("@hashgraph/sdk");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

function normalizeEvmPrivateKey(raw) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) return null;

  const noPrefix = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(noPrefix)) {
    return `0x${noPrefix}`;
  }

  try {
    const parsed = PrivateKey.fromString(value);
    return `0x${parsed.toStringRaw()}`;
  } catch {
    return null;
  }
}

const normalizedPk = normalizeEvmPrivateKey(
  process.env.PERSONAL_PRIV
);

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai"
    }
  },
  networks: {
    hedera_testnet: {
      url: process.env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api",
      accounts: normalizedPk ? [normalizedPk] : [],
      chainId: 296, // Hedera Testnet chain ID
      timeout: 120000, // 2 minutes for Hedera mirror node delays
      gasPrice: 1010000000000, // match Hedera testnet eth_gasPrice
      gas: 4000000,
      httpHeaders: {
        "Connection": "keep-alive"
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
