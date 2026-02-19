# AuditGuard Smart Contracts

All 10 contracts are implemented in this repo and deployed addresses are tracked in `packages/sdk/config.json`.
Treat live Hedera deployment status as environment-dependent and verify at runtime.
Testing targets local Hardhat with `MockHTS` injected at `0x167`.

---

## Contract Inventory

| Contract           | Primary Role                                    | Key Security Features          | Lines | Day |
|--------------------|-------------------------------------------------|--------------------------------|-------|-----|
| AgentRegistry      | Agent registration, staking, reputation, tiers | Pausable, Ownable, AccessControl | ~370 | 1   |
| AuditAuction       | Job lifecycle, bidding, winner selection, escrow | Pausable, Ownable, ReentrancyGuard | ~500 | 1   |
| SubAuction         | Sub-task delegation by winning agents           | Pausable, Ownable              | ~380 | 2   |
| StakingManager     | Stake lock-up, slash-with-evidence, appeal      | Pausable, Ownable, AccessControl | ~420 | 2   |
| PaymentSettlement  | Fee routing, job/sub-job settlement             | Pausable, Ownable              | ~280 | 2   |
| Treasury           | 40/50/10 fee distribution, emergency withdraw   | Ownable, AccessControl         | ~250 | 2   |
| DataMarketplace    | Audit data listings, access-controlled purchase | Ownable                        | ~320 | 3   |
| VaultFactory       | CREATE2 vault deployment, monitoring automation | Ownable                        | ~180 | 3   |
| AuditVault         | Per-contract budget management                  | Ownable                        | ~140 | 3   |
| AuditBudgetVault   | Escrow with authorized drawer                   | Ownable                        | ~160 | 3   |

---

## Current Integration Snapshot (as of February 19, 2026)

### Integrated
- Contract source, ABI artifacts, and deployment configuration are present in the monorepo.
- Cross-contract wiring expectations are documented (registry/auction/treasury/vault/staking links).
- Hedera IDs, EVM addresses, HCS topics, and iNFT collection IDs are present in `packages/sdk/config.json`.
- Hardhat config supports key normalization for testnet account input compatibility.

### In Progress / Needs Cleanup
- Local Hardhat test execution can fail if root dependency state is incomplete or `.env` key formats are incompatible.
- Root-level script ergonomics were recently corrected; dependent docs and runbooks should be kept aligned.

### Deferred (Tracked)
- No proxy-based upgrade path (redeploy+migrate strategy if changes are required).
- Single-owner admin model remains in place (no on-chain multisig/timelock governance yet).

---

## Dependency Graph

```
GUARD Token (HTS)
      │
      ├─▶ AgentRegistry ◀─────────────────────────────────────────┐
      │         │                                                   │
      │         ▼                                                   │
      ├─▶ AuditAuction ──▶ Treasury ◀── StakingManager            │
      │         │               ▲              │                   │
      │         ▼               │              │                   │
      │    SubAuction ──────────┘              │                   │
      │         │                              │                   │
      │         ▼                              │                   │
      ├─▶ PaymentSettlement ◀──────────────────┘                   │
      │                                                             │
      ├─▶ DataMarketplace ─▶ Treasury                              │
      │                                                             │
      └─▶ VaultFactory ─▶ AuditVault ─▶ AuditBudgetVault ─────────┘
```

Cross-reference wiring performed after deployment:
- `AgentRegistry.setOrchestratorAndAuction(orchestrator, auctionContract)` — one-time call
- `Treasury.addAuthorizedSource(auctionContract)` — whitelist fee senders
- `VaultFactory.setAuctionContract(auctionContract)`
- `VaultFactory.setPaymentSettlement(paymentSettlement)`
- `AuditBudgetVault.setAuthorizedDrawer(auctionContract)`
- `StakingManager.addAuthorizedSlasher(orchestrator)`

---

## Emergency Mechanisms

### Contracts with Pausable (5)

| Contract          | Pause Caller  | What Pauses                                         |
|-------------------|---------------|-----------------------------------------------------|
| AgentRegistry     | owner         | All state-changing ops (register, stake, slash)     |
| AuditAuction      | owner         | Job creation, bidding, winner selection, escrow     |
| SubAuction        | owner         | Sub-auction creation, bidding, delivery             |
| StakingManager    | owner         | Staking, unstaking, slash initiation                |
| PaymentSettlement | owner         | Settlement processing                               |

### Contracts without Pausable (5)

| Contract         | Mitigation                                                       |
|------------------|------------------------------------------------------------------|
| Treasury         | Access-controlled `addAuthorizedSource`; owner can emergency-withdraw |
| DataMarketplace  | Listings can be delisted by creator; owner can pause via future upgrade |
| VaultFactory     | Vault creation gated by AuditAuction winner status               |
| AuditVault       | Budget drawdown requires VaultFactory authorization              |
| AuditBudgetVault | `setAuthorizedDrawer` restricts who can draw funds               |

---

## Gas Analysis

Run the gas report locally:

```bash
cd packages/contracts
npx hardhat run scripts/gas-report.js
```

Expected output (approximate values on Hardhat local):

| Operation                      | Estimated Gas |
|--------------------------------|---------------|
| AgentRegistry.registerAgent    |   ~180,000    |
| AgentRegistry.addStake         |    ~50,000    |
| AgentRegistry.updateReputation |    ~35,000    |
| AgentRegistry.slashAgent       |    ~70,000    |
| AuditAuction.createAuditJob    |   ~210,000    |
| AuditAuction.submitBid         |   ~120,000    |
| AuditAuction.selectWinners     |   ~100,000    |
| AuditAuction.releaseEscrow     |   ~150,000    |
| AuditAuction.completeJob       |    ~60,000    |
| SubAuction.createSubAuction    |   ~180,000    |
| SubAuction.submitSubBid        |    ~90,000    |
| DataMarketplace.createListing  |   ~130,000    |
| DataMarketplace.purchaseData   |    ~80,000    |
| VaultFactory.createVault       |   ~400,000    |
| AuditBudgetVault.deposit       |    ~55,000    |

Actual values are written to `gas-report.json` after running the script.

---

## Known Limitations

1. **No upgradeability** — Contracts are deployed without proxy patterns. Bug fixes require redeployment and migration of state.
2. **Single owner** — All admin functions are gated by a single `owner` address. No multisig enforced on-chain.
3. **Hedera HTS dependency** — `transferToken` calls go through the HTS precompile at `0x167`. On non-Hedera EVM networks, `MockHTS` must be injected.
4. **No on-chain governance** — Parameters (stake minimums, fee percentages, distribution ratios) are set at deploy time or by owner call; no DAO/timelock.
5. **Reputation is 0–10000 scale** — Displayed as `rep / 100` percent. Precision loss of 0.01% per update is acceptable.
6. **setOrchestratorAndAuction is one-time** — Reverts if called again; immutable cross-reference after first wiring.

---

## Deployed Addresses (Hedera Testnet)

| Contract          | Hedera ID                                          | EVM Address                                  |
|-------------------|----------------------------------------------------|----------------------------------------------|
| GUARD Token       | `0.0.7936262`                                      | `0x0000000000000000000000000000000000791906`  |
| AgentRegistry     | `0.0.e86218b5bf5c21ca7a69cba04c5be0d3c2be2303`    | `0xe86218b5Bf5C21CA7a69cba04C5be0D3c2Be2303` |
| AuditAuction      | `0.0.95a0a0e78a32c849526d6ac32e98c6829fb2cd88`    | `0x95A0A0e78a32c849526d6AC32e98c6829FB2Cd88` |
| SubAuction        | `0.0.5fbdb2315678afecb367f032d93f642f64180aa3`    | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| StakingManager    | `0.0.e7f1725e7734ce288f8367e1bb143e90bb3f0512`    | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| PaymentSettlement | `0.0.9fe46736679d2d9a65f0992f2272de9f3c7fa6e0`    | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| Treasury          | `0.0.5fbdb2315678afecb367f032d93f642f64180aa3`    | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| DataMarketplace   | `0.0.e7f1725e7734ce288f8367e1bb143e90bb3f0512`    | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| VaultFactory      | `0.0.9fe46736679d2d9a65f0992f2272de9f3c7fa6e0`    | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| AuditBudgetVault  | `0.0.68780a12b36f3ed04cef937efc38b593683c5fcd`    | `0x68780A12b36f3ed04CEF937EFc38b593683c5fCd` |

**HCS Topics:**
| Topic            | ID             |
|------------------|----------------|
| Discovery        | `0.0.7940144`  |
| Audit Log        | `0.0.7940145`  |
| Agent Comms      | `0.0.7940146`  |

**iNFT Collections:**
| Collection       | Token ID       | EVM Address                                  |
|------------------|----------------|----------------------------------------------|
| AG-JOB           | `0.0.7946509`  | `0x000000000000000000000000000000000079410d`  |
| AG-AGENT         | `0.0.7946510`  | `0x000000000000000000000000000000000079410e`  |
| AG-HEALTH        | `0.0.7946511`  | `0x000000000000000000000000000000000079410f`  |

Explorer: [HashScan Testnet](https://hashscan.io/testnet)

---

## Running Tests

```bash
# Full test suite (local Hardhat)
cd packages/contracts
npx hardhat test

# Gas benchmarking
npx hardhat run scripts/gas-report.js

# Post-deployment verification (requires .env with HEDERA_PRIVATE_KEY)
npx hardhat run scripts/verify-deployment.js --network hedera_testnet
```
