
> auditguard@1.0.0 dev:all
> npm run stop:all && npm run preflight:live && npm run dev:all:unsafe


> auditguard@1.0.0 stop:all
> bash -lc 'pkill -f "orchestrator/src/index.js|tsx run-all.ts|run-all.ts|node src/discovery-listener.js|src/discovery-listener.js|node src/event-listener.js|src/event-listener.js|packages/dashboard run dev|vite" >/dev/null 2>&1 || true'


> auditguard@1.0.0 preflight:live
> npm run preflight:runtime && npm run activate:live-agents && npm run verify:live-agents


> auditguard@1.0.0 preflight:runtime
> node scripts/preflight-runtime.js

Running runtime preflight checks...

• Credential env consistency passed (.env authoritative)
• Scanner credential format check passed (account=0.0.7951944, evm=0xDC126e103fC1193B6eeCFc336c10746e9D9D885a)
• 0g broker dependency resolved: /Users/ssongirk/Projects/AuditGuard/agents/node_modules/@0glabs/0g-serving-broker/lib.commonjs/index.js
• 0g broker CJS require probe passed
• Strict 0g env validation passed
• 0g broker dependency resolved: /Users/ssongirk/Projects/AuditGuard/agents/node_modules/@0glabs/0g-serving-broker/lib.commonjs/index.js
Detected testnet (chain ID: 16602)
• 0g model consistency check passed (mode=pinned, model=qwen/qwen-2.5-7b-instruct)

❌ preflight-runtime failed: runtime requires unique payer accounts, but scanner and orchestrator are both 0.0.7951944

Suggested fixes:
  - Set SCANNER_ACCOUNT_ID/SCANNER_PRIVATE_KEY to a dedicated scanner payer account
  - Keep ORCHESTRATOR_ACCOUNT_ID/ORCHESTRATOR_PRIVATE_KEY (or OPERATOR_*) separate
  - Set ALLOW_SHARED_PAYER=true only for temporary local debugging (not recommended)
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mcalculateSubBid()[2m > [22mreturns an object with amount for any positive amount[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mcalculateSubBid()[2m > [22malways bids less than the offered payment[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mcalculateSubBid()[2m > [22mbid scales linearly with offered amount[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22mreturns all required fields[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22mgenerates deps in range 3–15[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22mgenerates 0–3 vulnerable deps[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22manalysis hash is always defined[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22mrisk factors come from the known set[32m 1[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mDependency Agent[2m > [22mgenerateDependencyAnalysis()[2m > [22mgenerates 0–5 outdated dependencies[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22maggregates a single submission correctly[32m 1[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22mdetects ~20% duplicates with multiple submitters[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22mno duplicates for single submitter[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22mscores each submitting agent with 0.6–1.0 accuracy[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22mreport hash is a valid hex hash[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22maggregateFindings()[2m > [22mhandles 3 submitters correctly[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22mcalculateReputationDeltas()[2m > [22mgives positive delta to high-accuracy agents[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22mcalculateReputationDeltas()[2m > [22mgives negative delta to low-accuracy agents[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22mcalculateReputationDeltas()[2m > [22mgives zero delta at 0.7 accuracy baseline[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22mcalculateReputationDeltas()[2m > [22mhandles multiple agents independently[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mReport Agent[2m > [22mcalculateReputationDeltas()[2m > [22mdelta formula is (accuracy - 0.7) * 10[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mAlert Agent[2m > [22mshouldAlert()[2m > [22mreturns true for REPORT_PUBLISHED with critical findings[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mAlert Agent[2m > [22mshouldAlert()[2m > [22mreturns false for REPORT_PUBLISHED with zero critical findings[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mAlert Agent[2m > [22mshouldAlert()[2m > [22mreturns false for non-REPORT_PUBLISHED messages[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mAlert Agent[2m > [22mshouldAlert()[2m > [22mreturns false for FINDINGS_SUBMITTED messages[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mAlert Agent[2m > [22mfireWebhook()[2m > [22mdoes not throw even without DISCORD_WEBHOOK_URL[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mBidding Price Hierarchy[2m > [22mLLM > Fuzzer > Static for the same contract[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mBidding Price Hierarchy[2m > [22mhierarchy holds for different contract sizes[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mLLM Agent Selectivity[2m > [22mLLM skips contracts that Static and Fuzzer would bid on[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mLLM Agent Selectivity[2m > [22mall agents bid on large high-risk contracts[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mCollateral Ratios Reflect Trust Tiers[2m > [22mLLM (40%) < Static (50%) < Fuzzer (60%)[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mDependency Agent Sub-Bid Economics[2m > [22mdependency agent always bids less than LLM's sub-contract offer[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mDependency Agent Sub-Bid Economics[2m > [22msub-bid is profitable for dependency agent[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mFinding ID Uniqueness Across Agents[2m > [22meach agent uses a unique finding ID prefix[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mReport Agent Processes Multi-Agent Findings[2m > [22mcorrectly aggregates findings from all 3 audit agents[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mScanner → Auditor Flow[2m > [22mscanner discovery data matches what auditor agents expect[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mFull Audit Cycle Data Integrity[2m > [22mfindings from auditors can be fed into report aggregation[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mAlert Agent Integration[2m > [22malert triggers when report has critical findings[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mAlert Agent Integration[2m > [22malert does NOT trigger when report has no critical findings[32m 0[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mEconomic Consistency[2m > [22mall bid amounts are positive numbers[32m 1[2mms[22m[39m
 [32m✓[39m tests/agents.test.ts[2m > [22mInter-Agent Interactions[2m > [22mEconomic Consistency[2m > [22mall collateral values are positive and less than bid amounts[32m 0[2mms[22m[39m
 [32m✓[39m tests/health-monitoring.test.ts[2m > [22mstartPeriodicDump() / stopPeriodicDump()[2m > [22mcalling startPeriodicDump twice does not create a second interval[32m 131[2mms[22m[39m
 [32m✓[39m tests/health-monitoring.test.ts[2m > [22mstartPeriodicDump() / stopPeriodicDump()[2m > [22mstopPeriodicDump is safe to call when not running[32m 0[2mms[22m[39m
 [32m✓[39m tests/health-monitoring.test.ts[2m > [22mrestart policy semantics[2m > [22mrestarts increment correctly per crash[32m 0[2mms[22m[39m
 [32m✓[39m tests/health-monitoring.test.ts[2m > [22mrestart policy semantics[2m > [22maggregate totalRestarts includes all agents[32m 0[2mms[22m[39m

[31m⎯⎯⎯⎯⎯⎯[39m[1m[41m Failed Tests 33 [49m[22m[31m⎯⎯⎯⎯⎯⎯⎯[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22minitializes EvmDecoder singleton on first call
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m240:11[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mdoes NOT reinitialize decoder on subsequent calls
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m250:11[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mreturns EOA result with defiCategory=lending when isContract=false
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m258:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mmaps ERC3156 standard → lending
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m271:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mmaps GnosisSafe evmType → vault
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m281:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mmaps diamond evmType → vault
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m291:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mmaps ERC721 standard → vault
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m301:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mmaps ERC1155 standard → vault
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m311:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22muses DEX function selector in bytecode → dex
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m323:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22muses staking function selector in bytecode → staking
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m335:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[10/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22muses bridge function selector in bytecode → bridge
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m347:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[11/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mdefaults to lending when no standards, no selectors, unknown evmType
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m358:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[12/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22mextracts proxyTarget from last proxy entry
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m375:26[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mcontract-classifier.ts[2m > [22m_resetDecoder() allows re-initialization on next call
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m386:11[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22msource-retriever.ts[2m > [22malways returns bytecode from RPC regardless of Sourcify result
[31m[1mAssertionError[22m: expected '0x' to be '0x6080604052aabbccdd' // Object.is equality[39m

Expected: [32m"0x[7m6080604052aabbccdd[27m"[39m
Received: [31m"0x"[39m

[36m [2m❯[22m tests/classifier-risk.test.ts:[2m468:29[22m[39m
    [90m466| [39m    const { retrieveContractSource } = await import("../scanner/source…
    [90m467| [39m    const result = await retrieveContractSource("0x" + "d".repeat(40),…
    [90m468| [39m    [34mexpect[39m(result[33m.[39mbytecode)[33m.[39m[34mtoBe[39m(fakeBytecode)[33m;[39m
    [90m   | [39m                            [31m^[39m
    [90m469| [39m  })[33m;[39m
    [90m470| [39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[15/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mreturns source='0g' when 0g broker succeeds and returns valid risk JSON
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m924:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[16/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mreturns source='0g' and risk has all 5 dimensions
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m941:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[17/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mfalls back to Claude when 0g HTTP request fails
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m957:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[18/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mfalls back to Claude when 0g returns non-200 status
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m974:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[19/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mfalls back to Claude when 0g returns unparseable risk response
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m992:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[20/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mskips 0g entirely and uses Claude when missing ZG_PRIVATE_KEY
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m1028:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[21/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — assessRisk()[2m > [22mmodel field in result reflects ZG_MODEL env var
[31m[1mError[22m: Both 0g and Claude inference failed. Claude error: TypeError: () => ({
    messages: { create: mockClaudeCreate }
  }) is not a constructor[39m
[36m [2m❯[22m assessRisk scanner/risk-inference.ts:[2m279:11[22m[39m
    [90m277| [39m    }[33m;[39m
    [90m278| [39m  } [35mcatch[39m (err) {
    [90m279| [39m    throw new Error(`Both 0g and Claude inference failed. Claude error…
    [90m   | [39m          [31m^[39m
    [90m280| [39m  }
    [90m281| [39m}
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m1065:20[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[22/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — health-check loop[2m > [22mhealth check restores zgHealthy after successful probe
[31m[1mAssertionError[22m: expected '0g' to be 'claude' // Object.is equality[39m

Expected: [32m"claude"[39m
Received: [31m"0g"[39m

[36m [2m❯[22m tests/classifier-risk.test.ts:[2m1179:41[22m[39m
    [90m1177| [39m    [34mstartZgHealthCheckLoop[39m(mockLog)[33m;[39m
    [90m1178| [39m    [90m// Before tick: still using Claude (no key = zgHealthy false)[39m
    [90m1179| [39m    [34mexpect[39m([34mgetCurrentInferenceSource[39m())[33m.[39m[34mtoBe[39m([32m"claude"[39m)[33m;[39m
    [90m   | [39m                                        [31m^[39m
    [90m1180| [39m
    [90m1181| [39m    [90m// Restore key so broker can init during the health check[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[23/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mrisk-inference.ts — health-check loop[2m > [22mhealth check stays on Claude when probe returns non-ok status
[31m[1mAssertionError[22m: expected '0g' to be 'claude' // Object.is equality[39m

Expected: [32m"claude"[39m
Received: [31m"0g"[39m

[36m [2m❯[22m tests/classifier-risk.test.ts:[2m1206:41[22m[39m
    [90m1204| [39m    [35mawait[39m vi[33m.[39m[34madvanceTimersByTimeAsync[39m([34m32_000[39m)[33m;[39m
    [90m1205| [39m    [90m// Probe failed → stays on Claude[39m
    [90m1206| [39m    [34mexpect[39m([34mgetCurrentInferenceSource[39m())[33m.[39m[34mtoBe[39m([32m"claude"[39m)[33m;[39m
    [90m   | [39m                                        [31m^[39m
    [90m1207| [39m    [34mstopZgHealthCheckLoop[39m()[33m;[39m
    [90m1208| [39m  })[33m;[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[24/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() is still exported from scanner
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() in TEST_MODE produces type='CONTRACT_DISCOVERED'
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() payload has contractType that is a valid DefiCategory
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() payload does NOT contain 'unknown' contractType
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() payload has riskScore in [0, 100]
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mgenerateDiscovery() payload has required HCS envelope fields
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mContractType no longer includes 'unknown'
[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mdiscovery event shape matches ContractDiscoveryEvent — all required fields present
[31m[1mTypeError[22m: __vite_ssr_import_1__.ethers.parseUnits is not a function[39m
[36m [2m❯[22m scanner/index.ts:[2m37:31[22m[39m
    [90m 35| [39mconst SCAN_INTERVAL_MS = DEMO_MODE ? 30 * 1000 : 300 * 1000; // 30s de…
    [90m 36| [39m[35mconst[39m [33mHOT_LEAD_RISK_THRESHOLD[39m [33m=[39m [34m80[39m[33m;[39m
    [90m 37| [39m[35mconst[39m [33mHOT_LEAD_PRICE[39m [33m=[39m ethers[33m.[39m[34mparseUnits[39m([32m"0.1"[39m[33m,[39m [34m8[39m)[33m;[39m   [90m// 0.1 GUARD[39m
    [90m   | [39m                              [31m^[39m
    [90m 38| [39mconst HOT_LEAD_DELAY_MS = DEMO_MODE ? 10 * 1000 : 60 * 1000; // delay …
    [90m 39| [39mconst DEFAULT_BUDGET_GUARD = Number(process.env.SCANNER_DISCOVERY_BUDG…
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m1223:35[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[25/33]⎯[22m[39m

[41m[1m FAIL [22m[49m tests/classifier-risk.test.ts[2m > [22mScanner integration[2m > [22mfull pipeline: classifyContract → blendRiskScore produces bounded output
[31m[1mTypeError[22m: () => ({
    initialize: mockInitializeFn,
    contractInfo: mockContractInfoFn
  }) is not a constructor[39m
[36m [2m❯[22m scanner/contract-classifier.ts:[2m31:25[22m[39m
    [90m 29| [39m  [35mif[39m ([33m![39minitPromise) {
    [90m 30| [39m    initPromise [33m=[39m ([35masync[39m () [33m=>[39m {
    [90m 31| [39m      decoderInstance [33m=[39m [35mnew[39m [33mEvmDecoder[39m({
    [90m   | [39m                        [31m^[39m
    [90m 32| [39m        eth[33m:[39m {
    [90m 33| [39m          url[33m:[39m [34mgetRpcUrl[39m()[33m,[39m
[90m [2m❯[22m ensureDecoder scanner/contract-classifier.ts:[2m63:5[22m[39m
[90m [2m❯[22m classifyContract scanner/contract-classifier.ts:[2m73:25[22m[39m
[90m [2m❯[22m tests/classifier-risk.test.ts:[2m1294:34[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[26/33]⎯[22m[39m


[2m Test Files [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m10 passed[39m[22m[90m (11)[39m
[2m      Tests [22m [1m[31m33 failed[39m[22m[2m | [22m[1m[32m350 passed[39m[22m[2m | [22m[33m2 skipped[39m[90m (385)[39m
[2m   Start at [22m 23:27:18
[2m   Duration [22m 736ms[2m (transform 1.15s, setup 0ms, import 1.99s, tests 2.00s, environment 1ms)[22m

npm error Lifecycle script `test` failed with error:
npm error Error: command failed
npm error   in workspace: auditguard-agents@1.0.0
npm error   at location: /Users/ssongirk/Projects/AuditGuard/agents
