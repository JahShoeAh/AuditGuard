const test = require("node:test");
const assert = require("node:assert/strict");

const { EventListener } = require("../event-listener");

const deepClone = (value) => JSON.parse(JSON.stringify(value));

function createHarness(initialAuditJobs = []) {
  const auditJobs = new Map();
  for (const entry of initialAuditJobs) {
    auditJobs.set(entry.serial, deepClone(entry.metadata));
  }

  const calls = {
    transitions: [],
    publishes: [],
    auctionUpdates: [],
  };

  const storage = {
    listAll(collectionKey) {
      if (collectionKey === "auditJob") {
        return [...auditJobs.values()].map((item) => deepClone(item));
      }
      return [];
    },
    findSerialBy(collectionKey, field, value) {
      if (collectionKey !== "auditJob") return null;
      for (const [serial, metadata] of auditJobs.entries()) {
        if (field === "jobId" && metadata.jobId === value) return serial;
        if (
          field === "target.contractAddress" &&
          metadata?.target?.contractAddress === value
        ) {
          return serial;
        }
      }
      return null;
    },
    async load(collectionKey, serial) {
      if (collectionKey !== "auditJob") return null;
      const metadata = auditJobs.get(serial);
      return metadata ? deepClone(metadata) : null;
    },
    async save(collectionKey, serial, metadata) {
      if (collectionKey !== "auditJob") return;
      auditJobs.set(serial, deepClone(metadata));
    },
  };

  const harness = {
    storage,
    inftService: {
      async transitionAuditJobState(serial, newState, trigger) {
        calls.transitions.push({ serial, newState, trigger });
        const existing = auditJobs.get(serial);
        if (existing?.state?.current) {
          existing.state.current = newState;
          auditJobs.set(serial, existing);
        }
      },
      async publishToAuditLog(eventType, payload) {
        calls.publishes.push({ eventType, payload });
      },
      async updateAuctionData(serial, payload) {
        calls.auctionUpdates.push({ serial, payload });
        const existing = auditJobs.get(serial);
        if (!existing) return;
        existing.auction = { ...(existing.auction || {}), ...payload };
        auditJobs.set(serial, existing);
      },
    },
    _jobIndex: new Map(),
    _auditJobContractIndex: new Map(),
    _agentIndex: new Map(),
    _contractIndex: new Map(),
    _subJobToParentJob: new Map(),
    _vaultAddresses: new Map(),
    _pendingJobLinks: new Map(),
    _processedJobPosts: new Set(),
  };

  const proto = EventListener.prototype;
  harness._normalizeAddress = proto._normalizeAddress;
  harness._extractSerialFromTokenId = proto._extractSerialFromTokenId;
  harness._resolveAuditJobSerialByContract = proto._resolveAuditJobSerialByContract;
  harness._queuePendingJobLink = proto._queuePendingJobLink;
  harness._applyJobPostedLink = proto._applyJobPostedLink;
  harness._replayPendingJobLinks = proto._replayPendingJobLinks;
  harness._onAuditAuction_JobPosted = proto._onAuditAuction_JobPosted;
  harness._initIndices = proto._initIndices;

  harness._initIndices();

  return { harness, auditJobs, calls };
}

test("JobPosted links case-insensitively to existing audit job iNFT", async () => {
  const { harness, calls } = createHarness([
    {
      serial: 77,
      metadata: {
        tokenId: "0.0.700:77",
        jobId: 0,
        target: { contractAddress: "0xAbCdEf1234567890aBcDef1234567890abCDef12" },
        state: { current: "DISCOVERED" },
        auction: {},
      },
    },
  ]);

  await harness._onAuditAuction_JobPosted(
    {
      jobId: 201,
      contractAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      auctionDeadline: 1772000000,
      budgetAvailable: 12000000000,
    },
    "1.2"
  );

  assert.equal(harness._jobIndex.get(201), 77);
  assert.equal(harness._pendingJobLinks.size, 0);
  assert.equal(calls.transitions.length, 1);
  assert.equal(calls.publishes.length, 1);
  assert.equal(calls.auctionUpdates.length, 1);
});

test("JobPosted self-heals when discovery mint arrives later", async () => {
  const { harness, auditJobs, calls } = createHarness();

  await harness._onAuditAuction_JobPosted(
    {
      jobId: 202,
      contractAddress: "0x1111111111111111111111111111111111111111",
      auctionDeadline: 1772000100,
      budgetAvailable: 5000000000,
    },
    "1.3"
  );

  assert.equal(harness._pendingJobLinks.size, 1);
  assert.equal(calls.transitions.length, 0);

  auditJobs.set(88, {
    tokenId: "0.0.700:88",
    jobId: 0,
    target: { contractAddress: "0x1111111111111111111111111111111111111111" },
    state: { current: "DISCOVERED" },
    auction: {},
  });

  await harness._replayPendingJobLinks();

  assert.equal(harness._pendingJobLinks.size, 0);
  assert.equal(harness._jobIndex.get(202), 88);
  assert.equal(calls.transitions.length, 1);
});

test("Repeated JobPosted handling is idempotent for transition publish", async () => {
  const { harness, calls } = createHarness([
    {
      serial: 99,
      metadata: {
        tokenId: "0.0.700:99",
        jobId: 0,
        target: { contractAddress: "0x2222222222222222222222222222222222222222" },
        state: { current: "DISCOVERED" },
        auction: {},
      },
    },
  ]);

  const eventArgs = {
    jobId: 303,
    contractAddress: "0x2222222222222222222222222222222222222222",
    auctionDeadline: 1772000200,
    budgetAvailable: 9000000000,
  };

  await harness._onAuditAuction_JobPosted(eventArgs, "1.4");
  await harness._onAuditAuction_JobPosted(eventArgs, "1.5");

  assert.equal(calls.transitions.length, 1);
  assert.equal(calls.publishes.length, 1);
  assert.equal(harness._jobIndex.get(303), 99);
});
