// ============================================================
// Validation Constants
// ============================================================

const MAX_STRING_LENGTH = 500;
const MAX_PAYLOAD_SIZE = 50000; // 50KB

// Known message types - any message not in this set will be rejected
const VALID_MESSAGE_TYPES = new Set([
  "CONTRACT_DISCOVERED",
  "AUCTION_INVITE",
  "BID_SUBMITTED",
  "BID_SKIPPED",
  "BID_DEDUPED",
  "BID_QUEUE_DROPPED",
  "BID_LATE_DROP",
  "BID_SUBMISSION_FAILED",
  "AUCTION_INVITE_SUMMARY",
  "JOB_CREATE_DEFERRED",
  "JOB_CREATE_RETRYING",
  "JOB_CREATE_ABORTED",
  "WINNER_SELECTION_SUMMARY",
  "LLM_PROVIDER_READY",
  "LLM_PROVIDER_UNHEALTHY",
  "LLM_INFERENCE_STARTED",
  "LLM_INFERENCE_SUCCEEDED",
  "LLM_INFERENCE_FAILED",
  "WINNER_SELECTED",
  "WINNERS_SELECTED",
  "SUB_AUCTION_CREATED",
  "SUB_AUCTION_POSTED",
  "SUB_BID_SUBMITTED",
  "SUB_WINNER_SELECTED",
  "SUB_RESULT_DELIVERED",
  "SUB_RESULT_ACCEPTED",
  "DATA_LISTED",
  "DATA_LISTING_CREATED",
  "DATA_PURCHASED",
  "PAYMENT_SETTLED",
  "FINDINGS_SUBMITTED",
  "REPORT_PUBLISHED",
  "REPUTATION_UPDATED",
  "ALERT_FIRED",
  "AUCTION_CREATED",
  "JOB_CANCELLED",
  "PING",
  "PONG",
]);

// ============================================================
// Helper Functions
// ============================================================

const isRecord = (value) =>
  typeof value === "object" && value !== null;

const asString = (value, maxLength = MAX_STRING_LENGTH) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
};

const asNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

// ============================================================
// Validation Functions
// ============================================================

export const parseEventIngestRequest = (value) => {
  if (!isRecord(value)) {
    throw new Error("Body must be an object");
  }

  const source = asString(value.source);
  const topicId = asString(value.topicId);
  const message = value.message;

  if (!source) {
    throw new Error("Invalid or missing 'source' field");
  }

  if (!topicId) {
    throw new Error("Invalid or missing 'topicId' field");
  }

  if (!isRecord(message)) {
    throw new Error("Invalid 'message' field - must be an object");
  }

  const type = asString(message.type);
  const agentId = asString(message.agentId, 100); // agentId limited to 100 chars
  const timestamp = asNumber(message.timestamp);
  const payload = message.payload;

  if (!type) {
    throw new Error("Invalid or missing 'message.type' field");
  }

  // Validate message type against known enum
  if (!VALID_MESSAGE_TYPES.has(type)) {
    throw new Error(`Unknown message type: ${type}`);
  }

  if (!agentId) {
    throw new Error("Invalid or missing 'message.agentId' field");
  }

  if (timestamp === null) {
    throw new Error("Invalid or missing 'message.timestamp' field");
  }

  if (!isRecord(payload)) {
    throw new Error("Invalid 'message.payload' field - must be an object");
  }

  // Validate payload size
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE} bytes`);
  }

  return {
    source,
    topicId,
    message: {
      type,
      agentId,
      timestamp,
      payload,
    },
  };
};

export const parseBidSkipPayload = (payload, fallbackAgentId) => {
  return {
    jobId: asNumber(payload.jobId),
    agentId: asString(payload.agentId) ?? fallbackAgentId,
    reasonCode: asString(payload.reasonCode),
    reason: asString(payload.reason),
    inviteBudget: asNumber(payload.inviteBudget),
    bidAmount: asNumber(payload.bidAmount),
  };
};

export const parseLimit = (value, fallback, max) => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};
