# Agent Leaderboard Fix Prompts

## Problem Summary

The agent leaderboard in the AuditGuard dashboard is not populating with existing agents. Investigation revealed that 9 agents are successfully registered in the AgentRegistry contract at `0x24F50cf56e768da01617906f1caa6010f0efe332` on Hedera Testnet, but the dashboard's `EventListenerService` is failing to fetch and display them.

**Root Cause**: The `_syncHistoricalAgents()` function in `packages/dashboard/src/services/event-listener.js` is silently failing due to rate limiting on historical event queries (`queryFilter`), and errors are being swallowed without user notification.

---

## Fix #1: Prioritize View Function Over Event Queries (CRITICAL - Quick Win)

### Context

The current implementation tries to fetch agents using two methods:
1. **Primary**: Query historical `AgentRegistered` events from block 0 to latest (slow, rate-limited)
2. **Fallback**: Call `getAllAgents()` view function (fast, reliable)

The problem is that the event query times out or gets rate-limited BEFORE the fallback executes, causing the entire hydration to fail silently.

### Prompt

```
Fix the agent hydration logic in the AuditGuard dashboard to prioritize reliable data fetching.

PROBLEM:
The agent leaderboard is empty because the EventListenerService's _syncHistoricalAgents()
function fails when querying historical AgentRegistered events due to Hedera RPC rate limits.
The fallback to view functions only executes if the event query succeeds but returns 0 results,
not when it throws an error.

FILE TO EDIT:
packages/dashboard/src/services/event-listener.js

CURRENT CODE (lines 262-298):
```javascript
async _syncHistoricalAgents() {
  if (!this.contracts?.agentRegistryContract) return;
  this._setAgentHydrationHealth('degraded', null);
  console.log('[EventListener] Syncing historical agents...');
  try {
    const eventCount = await this._syncAgentsFromRegistryEvents();
    if (eventCount > 0) {
      this._setAgentHydrationHealth('ok', null);
      console.log(`[EventListener] Synced ${eventCount} historical agents from events`);
      return;
    }
    const viewCount = await this._syncAgentsFromRegistryViews();
    if (viewCount > 0) {
      this._setAgentHydrationHealth('ok', null);
      console.log(`[EventListener] Synced ${viewCount} agents from AgentRegistry view fallback`);
      return;
    }
    // ... error handling
  }
  // ... catch block
}
```

REQUIRED CHANGES:
1. Reverse the order: try view functions FIRST, then events as fallback
2. Update log messages to reflect the new priority
3. Ensure the health status is set correctly based on which method succeeds

NEW LOGIC FLOW:
1. Try getAllAgents() view function first (fast, reliable)
2. If view function fails or returns 0 agents, THEN try event queries
3. If both fail, set health to 'failed' and log detailed error

EXPECTED BEHAVIOR AFTER FIX:
- When dashboard loads, it should immediately fetch all 9 registered agents via getAllAgents()
- Console should show: "[EventListener] Synced 9 agents from AgentRegistry views (primary method)"
- Agent leaderboard should populate within 2-3 seconds of page load
- If view function fails, it should gracefully fall back to events with clear logging

TESTING CHECKLIST:
□ Open browser console and refresh dashboard
□ Verify console shows: "[EventListener] Syncing historical agents..."
□ Verify console shows successful sync with agent count
□ Verify agent leaderboard displays 9 agents
□ Verify each agent has: address, tier, reputation score
□ Test with network throttling to ensure fallback works
□ Verify no errors in console related to agent hydration

CODE QUALITY REQUIREMENTS:
- Maintain existing error handling patterns
- Keep _setAgentHydrationHealth() calls for observability
- Preserve all existing log messages, just update their context
- Do not change the signatures of _syncAgentsFromRegistryEvents() or _syncAgentsFromRegistryViews()
- Add comments explaining why views are prioritized over events
```

---

## Fix #2: Reduce Block Range and Add Retry Logic for Event Queries (HIGH PRIORITY)

### Context

When the event query method runs, it chunks historical blocks into `MAX_BLOCK_RANGE = 10000` block segments. For a network that's been running for months/years, this could mean hundreds of RPC calls, each subject to rate limiting. Reducing the block range and adding intelligent retry logic will make event queries more resilient.

### Prompt

```
Improve the resilience of historical event queries in the AuditGuard dashboard by reducing
block range size and adding exponential backoff retry logic.

PROBLEM:
The _syncAgentsFromRegistryEvents() function queries the blockchain in 10,000-block chunks,
which often triggers rate limiting on Hedera's public RPC endpoint (testnet.hashio.io).
When rate-limited, the entire query fails without retry, causing agent hydration to fail.

FILE TO EDIT:
packages/dashboard/src/services/event-listener.js

CURRENT CODE (lines 196-225):
```javascript
async _syncAgentsFromRegistryEvents() {
  if (!this.contracts?.agentRegistryContract) return 0;

  const MAX_BLOCK_RANGE = 10000;
  const latestBlock = await this.provider.getBlockNumber();
  let allEvents = [];

  for (let fromBlock = 0; fromBlock <= latestBlock; fromBlock += MAX_BLOCK_RANGE) {
    const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);
    try {
      const events = await this.contracts.agentRegistryContract.queryFilter('AgentRegistered', fromBlock, toBlock);
      allEvents = allEvents.concat(events);
    } catch (err) {
      console.warn(`[EventListener] Failed to fetch AgentRegistered events from ${fromBlock} to ${toBlock}:`, err.message);
    }
  }

  for (const ev of allEvents) {
    const a = ev.args;
    this.store.setAgent(a.agent, {
      address: a.agent,
      agentId: a.agentId,
      ucpEndpoint: a.ucpEndpoint,
      stakedAmount: a.stakedAmount,
      stakedFormatted: parseGuardAmount(a.stakedAmount),
      source: 'onchain_event',
    });
  }
  return allEvents.length;
}
```

REQUIRED CHANGES:

1. **Reduce MAX_BLOCK_RANGE**:
   - Change from 10000 to 2000 blocks (5x smaller, less likely to hit rate limits)
   - Add comment explaining why smaller chunks are used for Hedera

2. **Add Exponential Backoff Retry Logic**:
   - Create a helper function `_retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000)`
   - Retry failed queryFilter calls with 1s, 2s, 4s delays
   - Only give up after 3 consecutive failures

3. **Add Progress Logging**:
   - Log every 10th chunk to show progress: "[EventListener] Scanning blocks 20000-22000 (10/50 chunks)..."
   - This helps diagnose where queries are failing

4. **Smart Block Range Detection**:
   - Add logic to detect the AgentRegistry deployment block from config
   - Only scan from deployment block onwards, not from block 0
   - If deployment block unknown, default to scanning last 1,000,000 blocks only

IMPLEMENTATION GUIDANCE:

```javascript
// Add this helper function before _syncAgentsFromRegistryEvents
async _retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, context = '') {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries - 1) throw err; // Last attempt, give up

      const delay = baseDelay * Math.pow(2, attempt); // Exponential: 1s, 2s, 4s
      console.warn(
        `[EventListener] ${context} failed (attempt ${attempt + 1}/${maxRetries}), ` +
        `retrying in ${delay}ms: ${err.message}`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Then in _syncAgentsFromRegistryEvents:
const MAX_BLOCK_RANGE = 2000; // Reduced from 10000 for Hedera rate limits

// Get deployment block if available (avoid scanning ancient history)
const deploymentBlock = this.config?.contracts?.agentRegistry?.deployedAtBlock || 0;
const latestBlock = await this.provider.getBlockNumber();
const startBlock = Math.max(deploymentBlock, latestBlock - 1_000_000); // Max 1M blocks back

for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += MAX_BLOCK_RANGE) {
  const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, latestBlock);
  const chunkIndex = Math.floor((fromBlock - startBlock) / MAX_BLOCK_RANGE) + 1;
  const totalChunks = Math.ceil((latestBlock - startBlock) / MAX_BLOCK_RANGE);

  try {
    const events = await this._retryWithBackoff(
      () => this.contracts.agentRegistryContract.queryFilter('AgentRegistered', fromBlock, toBlock),
      3,
      1000,
      `AgentRegistered query ${fromBlock}-${toBlock}`
    );
    allEvents = allEvents.concat(events);

    // Progress logging every 10 chunks
    if (chunkIndex % 10 === 0 || chunkIndex === totalChunks) {
      console.log(
        `[EventListener] Scanned blocks ${fromBlock}-${toBlock} ` +
        `(${chunkIndex}/${totalChunks} chunks, ${allEvents.length} events found)`
      );
    }
  } catch (err) {
    // After 3 retries failed, log error but continue with other chunks
    console.error(
      `[EventListener] Gave up on blocks ${fromBlock}-${toBlock} after 3 retries: ${err.message}`
    );
  }
}
```

EXPECTED BEHAVIOR AFTER FIX:
- Event queries complete successfully even under rate limiting
- Console shows progress: "Scanned blocks 40000-42000 (20/50 chunks, 7 events found)"
- Temporary rate limit errors trigger retries with backoff
- Agent hydration succeeds even if a few chunks fail (partial success)

TESTING CHECKLIST:
□ Verify queries complete without errors in normal conditions
□ Test with network throttling (Chrome DevTools: Slow 3G) - should retry and succeed
□ Check console logs show progress every 10 chunks
□ Verify all 9 agents are fetched even if some chunks timeout
□ Confirm retry delays are visible in console (1s, 2s, 4s pattern)
□ Test with agentRegistry.deployedAtBlock in config (should skip old blocks)

ADDITIONAL NOTES:
- If AgentRegistry was deployed recently, add deployedAtBlock to config.json to optimize
- Consider adding a config option for MAX_BLOCK_RANGE to tune per environment
- The 2000 block range is a conservative default; can be increased if no rate limits occur
```

---

## Fix #3: Add UI Indicator for Agent Hydration Status (MEDIUM PRIORITY - UX)

### Context

Currently, when agent hydration fails, users see "No agents registered yet — waiting for live registration events..." which incorrectly implies agents haven't registered. The `EventListenerService` already tracks hydration status via `_setAgentHydrationHealth()` and stores it in `store.ingestionHealth.agentHydrationStatus`, but this information is never displayed to users.

### Prompt

```
Add visible user feedback in the agent leaderboard to show the status of agent data synchronization.

PROBLEM:
When the dashboard fails to fetch agents from the blockchain, users see a misleading message:
"No agents registered yet — waiting for live registration events..."

This makes users think no agents have been registered, when in reality the dashboard
simply failed to fetch the existing 9 registered agents. The underlying sync status is
tracked in store.ingestionHealth but never displayed.

FILES TO EDIT:
1. packages/dashboard/src/components/AgentLeaderboard.jsx (primary changes)
2. packages/dashboard/src/store/index.js (verify ingestionHealth structure)

CURRENT CODE - AgentLeaderboard.jsx (lines 54-60):
```javascript
<div className="flex-1 overflow-y-auto min-h-0">
  {agents.length === 0 ? (
    <div className="text-gray-600 text-xs font-mono p-3">
      No agents registered yet — waiting for live registration events...
    </div>
  ) : (
    // ... agent rows
  )}
</div>
```

REQUIRED CHANGES:

1. **Import ingestionHealth from store**:
```javascript
const ingestionHealth = useStore((s) => s.ingestionHealth);
```

2. **Create enhanced EmptyState component** that shows hydration status:
```javascript
function EmptyAgentState({ ingestionHealth }) {
  const status = ingestionHealth?.agentHydrationStatus;
  const error = ingestionHealth?.agentHydrationError;
  const lastSync = ingestionHealth?.agentHydrationLastAt;

  // Show different messages based on hydration status
  if (status === 'failed') {
    return (
      <div className="text-gray-600 text-xs font-mono p-4 space-y-2">
        <div className="flex items-center gap-2 text-red-400">
          <span className="text-lg">⚠️</span>
          <span className="font-bold">Agent Sync Failed</span>
        </div>
        <p>Failed to fetch agents from AgentRegistry contract.</p>
        {error && <p className="text-gray-700 text-[10px]">Error: {error}</p>}
        <p className="text-cyan-400 mt-2">
          → Refresh the page or check browser console for details
        </p>
      </div>
    );
  }

  if (status === 'degraded') {
    return (
      <div className="text-gray-600 text-xs font-mono p-4 space-y-2">
        <div className="flex items-center gap-2 text-amber-400">
          <span className="text-lg animate-pulse">⏳</span>
          <span className="font-bold">Syncing Agents...</span>
        </div>
        <p>Fetching agent data from blockchain. This may take 10-30 seconds.</p>
      </div>
    );
  }

  // Status is 'ok' or unknown but still no agents
  return (
    <div className="text-gray-600 text-xs font-mono p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">📭</span>
        <span className="font-bold">No Agents Registered</span>
      </div>
      <p>No agents have registered on-chain yet.</p>
      <p className="text-gray-700 text-[10px] mt-2">
        Agents can register via AgentRegistry at{' '}
        <span className="text-cyan-500">0x24F5...e332</span>
      </p>
    </div>
  );
}
```

3. **Add status indicator in header** (even when agents are loaded):
```javascript
// In the header section (around line 38), add sync status indicator
<span className="ml-auto text-xs text-gray-500 font-mono flex items-center gap-2">
  {agents.length} registered agents
  {isLoading && <span className="ml-1 text-cyan-400 animate-pulse">•</span>}

  {/* Add hydration status indicator */}
  {ingestionHealth?.agentHydrationStatus === 'ok' && agents.length > 0 && (
    <span className="text-green-500" title="Agent sync successful">✓</span>
  )}
  {ingestionHealth?.agentHydrationStatus === 'degraded' && (
    <span className="text-amber-400 animate-pulse" title="Agent sync in progress">⏳</span>
  )}
  {ingestionHealth?.agentHydrationStatus === 'failed' && (
    <span className="text-red-400" title={ingestionHealth?.agentHydrationError || 'Sync failed'}>⚠️</span>
  )}
</span>
```

4. **Update the render logic** to use new EmptyAgentState:
```javascript
<div className="flex-1 overflow-y-auto min-h-0">
  {agents.length === 0 ? (
    <EmptyAgentState ingestionHealth={ingestionHealth} />
  ) : (
    <AnimatePresence>
      {agents.map((agent, i) => (
        <AgentLeaderboardRow
          key={agent.address}
          rank={i + 1}
          profile={agent}
          isSelected={selectedAgent === agent.address}
          onSelect={setSelectedAgent}
          isFlashing={isFlashing}
        />
      ))}
    </AnimatePresence>
  )}
</div>
```

EXPECTED BEHAVIOR AFTER FIX:

**Scenario 1 - Successful Sync**:
- Header shows: "9 registered agents ✓"
- Green checkmark indicates successful sync
- All agent rows display normally

**Scenario 2 - Sync In Progress**:
- Empty state shows: "⏳ Syncing Agents... Fetching agent data from blockchain."
- Header shows pulsing hourglass icon
- After 2-10 seconds, transitions to Scenario 1

**Scenario 3 - Sync Failed**:
- Empty state shows: "⚠️ Agent Sync Failed" with error details
- Header shows red warning icon with tooltip
- User knows to refresh or check console

**Scenario 4 - Truly No Agents**:
- Empty state shows: "📭 No Agents Registered"
- Clear message that blockchain has no agents yet
- Provides AgentRegistry contract address for reference

TESTING CHECKLIST:
□ Normal load: agents appear within 5 seconds, green checkmark in header
□ Simulate failure: see "Agent Sync Failed" with retry suggestion
□ Simulate slow network: see "Syncing Agents..." loading state
□ Hover over status icons in header: tooltips show helpful info
□ Verify error messages are user-friendly (no technical jargon)
□ Test on mobile: status icons and messages still visible
□ Check accessibility: screen readers can read status messages

STYLE REQUIREMENTS:
- Use existing Tailwind classes from the project
- Match color scheme: green (ok), amber (degraded), red (failed)
- Maintain font-mono for technical info (addresses, errors)
- Ensure animations are subtle (animate-pulse for loading states)
- Keep layout consistent with other dashboard components

ACCESSIBILITY NOTES:
- Add aria-live="polite" to status indicators
- Include title attributes on icons for tooltip context
- Ensure color is not the only indicator (use icons + text)
```

---

## Fix #4: Add Automatic Retry and Refresh Logic (LOW PRIORITY - Polish)

### Context

Even with the above fixes, network issues or temporary RPC outages could cause initial hydration to fail. Adding automatic retry logic and a manual refresh button gives users control and makes the system more resilient to transient failures.

### Prompt

```
Implement automatic retry logic and manual refresh capability for agent data synchronization
to handle transient network failures gracefully.

PROBLEM:
If agent hydration fails on initial page load due to a temporary network issue or RPC
outage, the user must manually refresh the entire page. There's no way to retry just
the agent sync, and no automatic retry mechanism.

FILES TO EDIT:
1. packages/dashboard/src/services/event-listener.js (add retry logic)
2. packages/dashboard/src/components/AgentLeaderboard.jsx (add refresh button)
3. packages/dashboard/src/store/index.js (add refresh action)

PART 1 - Add Automatic Retry in EventListenerService

FILE: packages/dashboard/src/services/event-listener.js

ADD NEW PROPERTY TO CONSTRUCTOR (around line 144):
```javascript
this._agentSyncRetries = 0;
this._maxAgentSyncRetries = 3;
this._agentSyncRetryDelay = 10000; // 10 seconds
```

MODIFY _syncHistoricalAgents (lines 262-298):
```javascript
async _syncHistoricalAgents() {
  if (!this.contracts?.agentRegistryContract) {
    console.warn('[EventListener] Cannot sync agents: agentRegistryContract not available');
    this._setAgentHydrationHealth('failed', 'AgentRegistry contract not initialized');
    return;
  }

  this._setAgentHydrationHealth('degraded', null);
  console.log(`[EventListener] Syncing historical agents (attempt ${this._agentSyncRetries + 1}/${this._maxAgentSyncRetries})...`);

  try {
    // Try view function first (from Fix #1)
    const viewCount = await this._syncAgentsFromRegistryViews();
    if (viewCount > 0) {
      this._setAgentHydrationHealth('ok', null);
      console.log(`[EventListener] ✓ Synced ${viewCount} agents from AgentRegistry views`);
      this._agentSyncRetries = 0; // Reset retry counter on success
      return viewCount;
    }

    // Fallback to events
    const eventCount = await this._syncAgentsFromRegistryEvents();
    if (eventCount > 0) {
      this._setAgentHydrationHealth('ok', null);
      console.log(`[EventListener] ✓ Synced ${eventCount} agents from events`);
      this._agentSyncRetries = 0;
      return eventCount;
    }

    // No agents found (genuine empty registry)
    this._setAgentHydrationHealth('ok', null);
    console.log('[EventListener] Agent sync complete: registry is empty (0 agents)');
    return 0;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EventListener] Agent sync attempt ${this._agentSyncRetries + 1} failed:`, errorMsg);

    // Check if we should retry
    if (this._agentSyncRetries < this._maxAgentSyncRetries) {
      this._agentSyncRetries++;
      this._setAgentHydrationHealth(
        'degraded',
        `Sync failed, retrying in ${this._agentSyncRetryDelay / 1000}s (attempt ${this._agentSyncRetries}/${this._maxAgentSyncRetries})`
      );

      // Schedule retry
      setTimeout(() => {
        console.log(`[EventListener] Retrying agent sync (${this._agentSyncRetries}/${this._maxAgentSyncRetries})...`);
        this._syncHistoricalAgents();
      }, this._agentSyncRetryDelay);

      return 0;
    }

    // All retries exhausted
    this._setAgentHydrationHealth('failed', `Agent sync failed after ${this._maxAgentSyncRetries} attempts: ${errorMsg}`);
    console.error(`[EventListener] ✗ Agent sync failed permanently after ${this._maxAgentSyncRetries} attempts`);
    return 0;
  }
}
```

ADD PUBLIC METHOD for manual refresh:
```javascript
// Add after _syncHistoricalAgents method
async refreshAgents() {
  console.log('[EventListener] Manual agent refresh requested');
  this._agentSyncRetries = 0; // Reset retry counter for manual refresh
  return await this._syncHistoricalAgents();
}
```

PART 2 - Add Refresh Action to Store

FILE: packages/dashboard/src/store/index.js

ADD NEW STATE (around line 334):
```javascript
// Agent refresh control
refreshAgents: null, // Will be set to EventListenerService.refreshAgents bound function
setRefreshAgentsHandler: (handler) => set({ refreshAgents: handler }),
```

PART 3 - Wire Refresh Handler in useEventListeners

FILE: packages/dashboard/src/hooks/useEventListeners.js

MODIFY useEffect (around line 81-84):
```javascript
const service = new EventListenerService(config, contracts, storeActions, ethersProvider);
const stop = service.startAll();

// Bind refresh handler to store
useStore.getState().setRefreshAgentsHandler(() => service.refreshAgents());

cleanupRef.current = () => {
  stop();
  useStore.getState().setRefreshAgentsHandler(null); // Clear handler on cleanup
};
console.log('[useEventListeners] Live event listeners started');
```

PART 4 - Add Refresh Button to AgentLeaderboard

FILE: packages/dashboard/src/components/AgentLeaderboard.jsx

IMPORT refreshAgents from store:
```javascript
const refreshAgents = useStore((s) => s.refreshAgents);
const ingestionHealth = useStore((s) => s.ingestionHealth);
```

ADD STATE for manual refresh:
```javascript
const [isRefreshing, setIsRefreshing] = useState(false);
```

ADD REFRESH HANDLER:
```javascript
const handleRefresh = async () => {
  if (!refreshAgents || isRefreshing) return;

  setIsRefreshing(true);
  console.log('[AgentLeaderboard] Manual refresh triggered');

  try {
    await refreshAgents();
  } catch (err) {
    console.error('[AgentLeaderboard] Manual refresh failed:', err);
  } finally {
    setIsRefreshing(false);
  }
};
```

UPDATE HEADER to include refresh button:
```javascript
<div className="flex items-center gap-2 mb-2 flex-shrink-0">
  <span className="text-amber-400 text-lg">🏆</span>
  <h2 className="text-sm font-bold text-gray-100 uppercase tracking-widest font-mono">
    Agent Leaderboard
  </h2>
  <span className="ml-auto text-xs text-gray-500 font-mono flex items-center gap-2">
    {agents.length} registered agents

    {/* Status indicator (from Fix #3) */}
    {ingestionHealth?.agentHydrationStatus === 'ok' && agents.length > 0 && (
      <span className="text-green-500" title="Agent sync successful">✓</span>
    )}
    {ingestionHealth?.agentHydrationStatus === 'degraded' && (
      <span className="text-amber-400 animate-pulse" title="Syncing...">⏳</span>
    )}
    {ingestionHealth?.agentHydrationStatus === 'failed' && (
      <span className="text-red-400" title={ingestionHealth?.agentHydrationError}>⚠️</span>
    )}

    {/* Refresh button */}
    <button
      onClick={handleRefresh}
      disabled={isRefreshing || !refreshAgents}
      className="ml-2 px-2 py-1 text-[10px] font-mono font-bold rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-cyan-500/10"
      style={{
        color: 'var(--accent-cyan)',
        borderColor: 'rgba(34,211,238,0.3)',
      }}
      title="Refresh agent list"
    >
      {isRefreshing ? '↻' : '⟳'}
      <span className={isRefreshing ? 'animate-spin inline-block' : ''}>
        {isRefreshing ? ' Refreshing...' : ' Refresh'}
      </span>
    </button>
  </span>
</div>
```

UPDATE EmptyAgentState to include refresh button (from Fix #3):
```javascript
function EmptyAgentState({ ingestionHealth, onRefresh, isRefreshing }) {
  const status = ingestionHealth?.agentHydrationStatus;
  const error = ingestionHealth?.agentHydrationError;

  if (status === 'failed') {
    return (
      <div className="text-gray-600 text-xs font-mono p-4 space-y-3">
        <div className="flex items-center gap-2 text-red-400">
          <span className="text-lg">⚠️</span>
          <span className="font-bold">Agent Sync Failed</span>
        </div>
        <p>Failed to fetch agents from AgentRegistry contract.</p>
        {error && <p className="text-gray-700 text-[10px]">Error: {error}</p>}

        {/* Refresh button for failed state */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="mt-3 px-3 py-2 text-xs font-mono font-bold rounded border transition-all disabled:opacity-50"
          style={{
            color: 'var(--accent-cyan)',
            borderColor: 'rgba(34,211,238,0.5)',
            background: 'rgba(34,211,238,0.1)',
          }}
        >
          {isRefreshing ? '↻ Retrying...' : '⟳ Try Again'}
        </button>
      </div>
    );
  }

  // ... rest of EmptyAgentState component
}
```

PASS REFRESH PROPS to EmptyAgentState:
```javascript
{agents.length === 0 ? (
  <EmptyAgentState
    ingestionHealth={ingestionHealth}
    onRefresh={handleRefresh}
    isRefreshing={isRefreshing}
  />
) : (
  // ... agent rows
)}
```

EXPECTED BEHAVIOR AFTER FIX:

**Automatic Retry Flow**:
1. Page loads, agent sync fails (network timeout)
2. Console: "Agent sync attempt 1 failed, retrying in 10s"
3. After 10s, automatic retry #1
4. If fails again, retry #2 after 10s
5. If fails third time, mark as permanently failed
6. User can click "Try Again" to reset and retry manually

**Manual Refresh Flow**:
1. User clicks "⟳ Refresh" button in header
2. Button shows "↻ Refreshing..." with spinning icon
3. Sync executes (resets retry counter)
4. On success: agents populate, button returns to "⟳ Refresh"
5. On failure: status shows failed, "Try Again" button appears

**Console Output Example**:
```
[EventListener] Syncing historical agents (attempt 1/3)...
[EventListener] Agent sync attempt 1 failed: Network timeout
[EventListener] Retrying agent sync (1/3)...
[EventListener] Syncing historical agents (attempt 2/3)...
[EventListener] ✓ Synced 9 agents from AgentRegistry views
```

TESTING CHECKLIST:
□ Normal load: agents sync on first try, no retries needed
□ Simulate network failure: see 3 automatic retries over 30 seconds
□ Click refresh button during success: agents reload
□ Click refresh button during failure: resets retry counter and tries again
□ Test rapid clicking: button disables during refresh (no duplicate requests)
□ Verify console logs show attempt numbers (1/3, 2/3, 3/3)
□ After permanent failure, verify "Try Again" button appears
□ Test refresh button hover/disabled states match design system
□ Verify refresh works after tab is backgrounded (no stale state)

PERFORMANCE NOTES:
- Automatic retries use 10-second delays to avoid hammering RPC
- Manual refresh bypasses retry delay for immediate user feedback
- Retry counter resets on success to handle future transient failures
- Maximum 3 retries prevents infinite loops

ERROR HANDLING:
- If refreshAgents() is null, button is disabled (service not ready)
- Catch and log errors from manual refresh without crashing UI
- Clear isRefreshing state in finally block to prevent stuck buttons
```

---

## Implementation Order

For maximum impact with minimum risk, implement in this order:

1. **Fix #1 (Critical)** - Swap view/event priority (~15 min)
   - Immediate fix for 90% of users
   - Low risk, high reward
   - Test thoroughly before proceeding

2. **Fix #3 (UX)** - Add status indicators (~30 min)
   - Makes problems visible to users
   - Helps diagnose if Fix #1 didn't work
   - Independent of other fixes

3. **Fix #2 (Resilience)** - Improve event queries (~45 min)
   - Makes event fallback actually work
   - Requires more testing
   - Optional if Fix #1 solves everything

4. **Fix #4 (Polish)** - Add retry/refresh (~60 min)
   - Nice-to-have for edge cases
   - Only needed if network is very unstable
   - Can be deferred to later sprint

---

## Testing Strategy

### Manual Testing Checklist

After implementing each fix:

```bash
# 1. Clear browser cache and local storage
# 2. Open DevTools console
# 3. Refresh dashboard
# 4. Check for these messages:

✓ "[EventListener] Live event listeners started"
✓ "[EventListener] Syncing historical agents..."
✓ "[EventListener] Synced 9 agents from AgentRegistry views"
✓ No error messages in console

# 5. Verify agent leaderboard shows 9 agents with:
#    - Rank numbers (1-9)
#    - Agent names or addresses
#    - Tier badges
#    - Reputation scores

# 6. Test edge cases:
#    - Refresh page multiple times (should load consistently)
#    - Throttle network to Slow 3G (should show loading state)
#    - Disconnect network (should show error state)
#    - Reconnect network and click refresh (should recover)
```

### Automated Testing

```javascript
// Add to packages/dashboard/src/__tests__/event-listener.test.js

describe('Agent Hydration', () => {
  it('should prioritize view function over events', async () => {
    const viewMock = vi.fn().mockResolvedValue(9);
    const eventMock = vi.fn().mockResolvedValue(0);

    // ... test implementation

    expect(viewMock).toHaveBeenCalledBefore(eventMock);
  });

  it('should retry on failure with exponential backoff', async () => {
    // Mock to fail twice, succeed third time
    const mock = vi.fn()
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockRejectedValueOnce(new Error('Rate limit'))
      .mockResolvedValueOnce(9);

    // ... test implementation with timer mocks

    expect(mock).toHaveBeenCalledTimes(3);
  });
});
```

---

## Success Criteria

All fixes are complete when:

✅ Dashboard loads and shows all 9 registered agents within 5 seconds
✅ Console shows clear success message: "Synced X agents from AgentRegistry views"
✅ No errors or warnings related to agent hydration in console
✅ Status indicator in header shows green checkmark (✓)
✅ Network throttling (Slow 3G) triggers loading state, then succeeds
✅ Temporary network failure auto-retries and eventually succeeds
✅ Permanent network failure shows clear error message with manual refresh option
✅ Manual refresh button works and provides immediate feedback
✅ All 9 agents display with correct: rank, address/name, tier, reputation score

---

## Rollback Plan

If any fix causes regressions:

1. **Revert the specific fix** using git:
   ```bash
   git diff HEAD packages/dashboard/src/services/event-listener.js
   git checkout HEAD -- packages/dashboard/src/services/event-listener.js
   ```

2. **Each fix is independent** - you can revert Fix #2 while keeping Fix #1 and #3

3. **Minimum viable fix** - Fix #1 alone should solve 90% of cases

4. **Safe to ship incrementally** - Ship Fix #1 immediately, add others later

---

## Additional Notes

- **Production Deployment**: Test all fixes on testnet first before mainnet
- **Monitoring**: Add metrics for agent hydration success rate
- **Documentation**: Update README with troubleshooting steps for empty leaderboard
- **Config Option**: Consider adding `AGENT_SYNC_METHOD=views|events|auto` env var for flexibility
