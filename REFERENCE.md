# Blockchain Infrastructure Reference

## Day 1

| Artifact | Location | What It Is |
|---|---|---|
| `config.json` | `packages/sdk/config.json` | Token IDs, contract addresses, HCS topics, seeded agent profiles |
| Contract ABIs | `packages/sdk/abis/*.json` | ABI files to instantiate ethers.js Contract objects |
| Agent Interface Standard | `AgentRegistry.sol` | The on-chain spec any agent must follow: register → stake → bid → earn reputation |
| HCS Message Schemas | Documented in Prompt 6 Topic definitions | JSON schemas for Discovery, AuditLog, and AgentComms topics |
| Open Registration Flow | `AgentRegistry.registerAgent()` | How external agents join: stake GUARD → start COMMODITY → earn promotion |

