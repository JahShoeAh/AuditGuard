import test from "node:test";
import assert from "node:assert/strict";

import { parseEventIngestRequest } from "./validation.js";

test("parseEventIngestRequest accepts canonical iNFT relay payload", () => {
  const parsed = parseEventIngestRequest({
    source: "inft",
    topicId: "0.0.7940145",
    message: {
      type: "INFT_MINTED",
      agentId: "inft-service",
      timestamp: 1771660000000,
      payload: {
        collection: "auditJob",
        serialNumber: 12,
      },
    },
  });

  assert.deepEqual(parsed, {
    source: "inft",
    topicId: "0.0.7940145",
    message: {
      type: "INFT_MINTED",
      agentId: "inft-service",
      timestamp: 1771660000000,
      payload: {
        collection: "auditJob",
        serialNumber: 12,
      },
    },
  });
});
