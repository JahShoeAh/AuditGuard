## 1.4 — Full Dependency Manifest

| Package | Version | Purpose | Used By |
|---|---|---|---|
| `@hashgraph/sdk` | ^2.46.0 | Hedera native SDK (HTS, HCS, HSCS) | All packages |
| `@hashgraph/json-rpc-relay` | ^0.62.0 | Hedera EVM JSON-RPC for Hardhat | contracts (dev) |
| `hardhat` | ^2.22.0 | Solidity compilation, testing, deploy | contracts |
| `@nomicfoundation/hardhat-toolbox` | ^5.0.0 | Hardhat test/deploy utilities | contracts |
| `@nomicfoundation/hardhat-ethers` | ^3.0.0 | ethers.js Hardhat integration | contracts |
| `@nomicfoundation/hardhat-chai-matchers` | ^2.0.0 | Chai matchers for Solidity testing | contracts |
| `ethers` | ^6.13.0 | Contract interaction from JS | agents, sdk |
| `@openzeppelin/contracts` | ^5.0.0 | Solidity base contracts | contracts |
| `solc` | 0.8.24 | Pinned Solidity compiler | contracts |
| `chai` | ^4.4.0 | Test assertions | test |
| `dotenv` | ^16.4.0 | Environment variable loading | all |
| `typescript` | ^5.4.0 | TypeScript support (dev) | all (dev) |
| `ts-node` | ^10.9.0 | Run TS directly (dev) | all (dev) |
| `@types/node` | ^20.0.0 | Node type definitions (dev) | all (dev) |
| `winston` | ^3.13.0 | Structured agent logging | agents |
| `concurrently` | ^8.2.0 | Parallel script runner (dev) | scripts (dev) |

**Node.js version requirement:** `>=18.0.0` (required by `@hashgraph/sdk` v2)

### Workspace Install Policy

- Root npm workspaces include `agents`, `orchestrator`, and `packages/*`.
- Default bootstrap path is now one command at repo root: `npm install`.
- Avoid committing nested `package-lock.json` files from workspace subdirectories; use the root lockfile as source of truth.
