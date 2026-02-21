const test = require("node:test");
const assert = require("node:assert/strict");

const { INFTService } = require("../inft-service");

test("publish envelope is canonical and keeps backward data mirror", () => {
  const payload = {
    collection: "auditJob",
    serialNumber: 42,
    contractAddress: "0xabc",
  };
  const message = INFTService.prototype._buildAuditLogMessage.call(
    {},
    "INFT_MINTED",
    payload,
    1234567890
  );

  assert.equal(message.type, "INFT_MINTED");
  assert.equal(message.agentId, "inft-service");
  assert.equal(message.timestamp, 1234567890);
  assert.deepEqual(message.payload, payload);
  assert.deepEqual(message.data, payload);
});

test("relay publish sends events-api contract payload", async () => {
  const originalFetch = global.fetch;
  /** @type {{url: string, options: any}|null} */
  let captured = null;

  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 201 };
  };

  try {
    const service = {
      eventRelayUrl: "http://127.0.0.1:4000/api/events",
      eventRelayToken: "relay-token",
    };
    const message = {
      type: "INFT_MINTED",
      agentId: "inft-service",
      timestamp: 1,
      payload: { serialNumber: 12 },
      data: { serialNumber: 12 },
    };

    const ok = await INFTService.prototype._relayAuditLogEvent.call(
      service,
      "0.0.1234",
      message
    );

    assert.equal(ok, true);
    assert.ok(captured);
    assert.equal(captured.url, "http://127.0.0.1:4000/api/events");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers["content-type"], "application/json");
    assert.equal(captured.options.headers.authorization, "Bearer relay-token");

    const body = JSON.parse(captured.options.body);
    assert.deepEqual(body, {
      source: "inft",
      topicId: "0.0.1234",
      message,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("relay failures are non-fatal", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network down");
  };

  try {
    const service = {
      eventRelayUrl: "http://127.0.0.1:4000/api/events",
      eventRelayToken: "",
    };
    const result = await INFTService.prototype._relayAuditLogEvent.call(
      service,
      "0.0.1234",
      {
        type: "INFT_MINTED",
        agentId: "inft-service",
        timestamp: Date.now(),
        payload: {},
        data: {},
      }
    );
    assert.equal(result, false);
  } finally {
    global.fetch = originalFetch;
  }
});
