require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

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
      accounts: process.env.HEDERA_PRIVATE_KEY ? [process.env.HEDERA_PRIVATE_KEY] : [],
      chainId: 296, // Hedera Testnet chain ID
      timeout: 60000
    }
  },
  paths: {
    sources: "./contracts",
    tests: "../../test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};