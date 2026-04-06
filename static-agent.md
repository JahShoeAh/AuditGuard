# AuditGuard — Static Analysis Agent: Tool Research

## Context

The `static-analysis-047` agent currently uses `Math.random()` to generate mock findings.
This document covers every serious static analysis tool candidate for replacing that mock,
ranked by usefulness for AuditGuard's use case (arbitrary deployed contracts on Hedera testnet,
no guaranteed source code).

---

## Tool Landscape

### Tier 1 — Production-ready, actively maintained

#### [Slither](https://github.com/crytic/slither) — Trail of Bits
- **Source needed:** Yes (Solidity)
- **Language:** Python
- **Detectors:** 90+ — reentrancy, integer overflow, uninitialized storage, tx.origin, shadowing, incorrect ERC20, arbitrary send-ETH, and many more
- **Output:** JSON, text, Markdown, SARIF
- **CI:** Native Hardhat / Foundry / Truffle integration
- **Speed:** Very fast (seconds on most contracts)
- **License:** AGPL-3.0
- **Install:** `pip3 install slither-analyzer` or `docker pull trailofbits/eth-security-toolbox`
- **Invoke:**
  ```bash
  slither contracts/MyContract.sol --json results.json
  slither . --json results.json   # auto-detects Hardhat/Foundry project
  ```
- **Verdict:** The gold standard. Highest community adoption, lowest false positive rate among
  source-based tools. **Best first choice when contract source is available.**

---

#### [Aderyn](https://github.com/Cyfrin/aderyn) — Cyfrin
- **Source needed:** Yes (Solidity)
- **Language:** Rust
- **Detectors:** 50+ — centralization risk, unsafe casting, weak randomness, dangerous strict equality,
  unprotected initializers, incorrect ERC standards, and more
- **Output:** JSON, Markdown
- **Speed:** Fastest of all source-based tools (compiled Rust binary)
- **VSCode extension:** Official (`cyfrin/vscode-aderyn`)
- **License:** GPL-3.0
- **Install:** `cargo install aderyn` or `brew install cyfrin/tap/aderyn`
- **Invoke:**
  ```bash
  aderyn .                    # analyze current Foundry/Hardhat project
  aderyn --output report.json
  ```
- **Used in:** Code4rena and Sherlock audit contests
- **Verdict:** The modern Slither challenger. Best for speed and CI pipelines. Good complement
  to Slither for a second pass — low detector overlap.

---

#### [Wake](https://github.com/Ackee-Blockchain/wake) — Ackee Blockchain
- **Source needed:** Yes (Solidity)
- **Language:** Python
- **Features:** Static analysis detectors + fuzzing + LSP + VS Code integration in one framework
- **Detectors:** Built-in + extensible custom detectors (Python API)
- **Used by:** Auditors of Lido, Safe, Axelar
- **License:** ISC
- **Install:** `pip3 install eth-wake`
- **Invoke:**
  ```bash
  wake detect all              # run all detectors
  wake detect all --json       # JSON output
  ```
- **Verdict:** Most complete all-in-one framework. Overkill if you only want static analysis,
  but excellent if you want fuzzing + static analysis in a single tool.

---

### Tier 2 — Useful, more specialized

#### [Semgrep](https://github.com/semgrep/semgrep) + [Decurity rules](https://github.com/Decurity/semgrep-smart-contracts)
- **Source needed:** Yes (Solidity — experimental support)
- **Language:** OCaml engine, YAML rules
- **Rules:** Decurity's repo has rules derived from real DeFi exploits — flash loan price
  manipulation, donation attacks, first-depositor issues, unsafe approvals, etc.
- **Strength:** Pattern-matching against known exploit signatures; extremely fast; easy to
  write custom rules in YAML
- **Limitation:** Solidity support is "experimental"; cross-function taint tracking requires
  Semgrep Pro (paid)
- **Install:** `pip3 install semgrep`
- **Invoke:**
  ```bash
  semgrep --config https://github.com/Decurity/semgrep-smart-contracts .
  semgrep --config p/smart-contracts --json .
  ```
- **Verdict:** Excellent for known DeFi exploit patterns specifically. Complements Slither,
  which focuses on vulnerability classes rather than historical exploits.

---

#### [4naly3er](https://medium.com/@tonibarjasmartinez/a-comprehensive-guide-to-using-4naly3er-for-smart-contract-auditing-4c3092e5941f)
- **Source needed:** Yes (Solidity)
- **Language:** TypeScript / JavaScript
- **Focus:** Gas optimizations, low-severity issues, code quality — QA report generation
- **Used in:** Code4rena contests (appended to every contest's automated report)
- **Output:** Markdown report
- **Verdict:** Not a vulnerability scanner — useful as an automated QA/gas pass. Best
  combined with Slither, not as a replacement.

---

#### [Rattle](https://github.com/crytic/rattle) — Trail of Bits (crytic)
- **Source needed:** No (EVM bytecode only)
- **Language:** Python
- **What it does:** Lifts raw EVM bytecode into SSA (Static Single Assignment) IR form;
  recovers control flow graph; removes DUPs, SWAPs, PUSHs, POPs — makes bytecode
  machine-analyzable
- **Limitation:** IR framework only — no built-in detectors. You write your own analysis
  on top of it.
- **Invoke:**
  ```bash
  python3 rattle-cli.py --input bytecode.bin
  ```
- **Verdict:** Not plug-and-play. Used as a building block inside other tools (e.g. Conkas).
  Worth knowing if building custom bytecode detectors.

---

### Tier 3 — AI/LLM-based (emerging, not production-ready)

#### [GPTScan](https://www.semanticscholar.org/paper/GPTScan:-Detecting-Logic-Vulnerabilities-in-Smart-Sun-Wu/abc5e9d296adf476c8125837b89d7fb5a709fc95)
- **Approach:** GPT-4 + static analysis hybrid — GPT understands developer intent, static
  analysis confirms execution paths
- **Strength:** Finds **logic vulnerabilities** that rule-based tools miss (wrong comparison
  direction, incorrect business logic, off-by-one in reward math)
- **Status:** Research paper — no stable CLI

#### [SmartLLM](https://arxiv.org/abs/2502.13167)
- **Approach:** Fine-tuned LLaMA 3.1 + RAG over known vulnerability patterns
- **Results:** 100% recall, 70% accuracy on benchmark — outperforms Slither and Mythril
  on the tested dataset
- **Status:** Research prototype

#### [LLM-SmartAudit](https://arxiv.org/html/2410.09381v1)
- **Approach:** Multi-agent conversational architecture with buffer-of-thought mechanism;
  specialized agents iteratively refine assessments
- **Results:** Claims 98% accuracy on common vulnerabilities; caught 12 of 13 known CVEs
- **Caveat:** Academic benchmarks — real-world performance on novel bugs unknown
- **Status:** Research prototype

---

## Summary Table

| Tool | Bytecode? | Speed | Detectors | Best for |
|------|-----------|-------|-----------|---------|
| **Slither** | No (source) | Fast | 90+ | First-pass on any verified source |
| **Aderyn** | No (source) | Fastest | 50+ | Speed, modern Solidity, CI |
| **Wake** | No (source) | Medium | 40+ | Full-stack: static + fuzzing |
| **Semgrep + Decurity** | No (source) | Fast | ~30 DeFi patterns | Known exploit signatures |
| **4naly3er** | No (source) | Fast | ~20 | QA / gas / low-severity |
| **Rattle** | **Yes** | — | 0 (IR only) | Building custom bytecode detectors |
| **GPTScan / LLM tools** | No (source) | Slow | logic bugs | Logic errors that patterns miss |

For bytecode-only tools (no source), see `fuzzer.md` — ItyFuzz, Mythril, Manticore, Heimdall
are already implemented in `packages/fuzzer-service/`.

---

## Performance Benchmark (from academic research)

Real-world accuracy from a comparative evaluation study:

| Tool | Accuracy | Recall | Precision |
|------|----------|--------|-----------|
| Mythril | 21.7% | 34.8% | 20.0% |
| Slither | 35.0% | 42.3% | 31.4% |
| SmartLLM (LLaMA) | 70.0% | 100% | — |
| LLM-SmartAudit | 98.0% | — | — |

**Important caveat:** All current tools (including LLM-based) can only detect an estimated
8–20% of exploitable bugs in production contracts. No tool is a substitute for manual review.

---

## Recommendation for AuditGuard's `static-analysis-047` Agent

### When source code is available (Hashscan verified contracts)

Run Slither + Aderyn together — they take 10–30 seconds, cover the widest detector surface,
and have very low overlap:

```
Slither  (90+ detectors, deep dataflow)
    +
Aderyn   (50+ detectors, modern patterns, fast)
    +
Semgrep  (Decurity rules, DeFi exploit signatures)
```

### When only bytecode is available (most Hedera contracts)

Fall back to the tools already in `packages/fuzzer-service/`:
- Heimdall (fast static pass on decompiled bytecode)
- Mythril (symbolic execution)
- ItyFuzz (fuzzing)
- Manticore (symbolic execution)

### Architecture for the static-analysis agent

Mirrors the fuzzer-service pattern — create `packages/static-analysis-service/`:

```
POST /analyze  { contractAddress, sourceDir?, chainForkUrl }
    ├── If sourceDir: run Slither + Aderyn + Semgrep in parallel
    └── If bytecode only: run Heimdall (already in fuzzer-service, or share it)

GET /results/:jobId → { findings: Finding[], toolsUsed: string[], elapsed: number }
```

The agent calls the service, polls for results, falls back to mock if unavailable —
identical pattern to what was built for the fuzzer agent.

### Install commands (one-time, on your server)

```bash
# Slither
pip3 install slither-analyzer

# Aderyn
cargo install aderyn
# or:
brew install cyfrin/tap/aderyn

# Wake
pip3 install eth-wake

# Semgrep + Decurity rules
pip3 install semgrep
git clone https://github.com/Decurity/semgrep-smart-contracts /opt/semgrep-solidity-rules
```

---

## What to Build

1. **`packages/static-analysis-service/`** — Express API wrapping Slither + Aderyn + Semgrep (1–2 days)
2. **`agents/static-analysis/index.ts`** — replace `generateFindings()` with HTTP call to the service (2 hours)
3. **`.env`** — add `STATIC_ANALYSIS_SERVICE_URL=http://localhost:4002`
4. **`package.json`** — add `static-analysis:service` script, wire into `dev:all:unsafe`

The static-analysis agent already handles everything else — bidding, winning, submitting on-chain,
HCS messaging. Only the ~20 lines of mock `generateFindings()` need replacing.

---

## Sources

- [Slither — crytic/Trail of Bits](https://github.com/crytic/slither)
- [Aderyn — Cyfrin](https://github.com/Cyfrin/aderyn)
- [Wake — Ackee Blockchain](https://github.com/Ackee-Blockchain/wake)
- [Semgrep smart contract rules — Decurity](https://github.com/Decurity/semgrep-smart-contracts)
- [4naly3er guide — Medium](https://medium.com/@tonibarjasmartinez/a-comprehensive-guide-to-using-4naly3er-for-smart-contract-auditing-4c3092e5941f)
- [Rattle — crytic/Trail of Bits](https://github.com/crytic/rattle)
- [SmartLLM paper — arXiv 2502.13167](https://arxiv.org/abs/2502.13167)
- [LLM-SmartAudit paper — arXiv 2410.09381](https://arxiv.org/html/2410.09381v1)
- [GPTScan paper — Semantic Scholar](https://www.semanticscholar.org/paper/GPTScan:-Detecting-Logic-Vulnerabilities-in-Smart-Sun-Wu/abc5e9d296adf476c8125837b89d7fb5a709fc95)
- [Tool comparison — Vultbase](https://www.vultbase.com/articles/smart-contract-security-tools-compared)
- [H-X Technologies roundup](https://www.h-x.technology/blog/the-best-smart-contract-analysis-tools-2025)
- [Comparative evaluation — arXiv](https://arxiv.org/html/2310.20212v4)
- [Hacken audit tools review](https://hacken.io/discover/audit-tools-review/)
