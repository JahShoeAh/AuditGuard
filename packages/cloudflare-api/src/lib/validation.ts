import type { BidSkipExtract, EventIngestRequest } from "../types/events";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asNumber = (value: unknown): number | null => {
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

export const parseEventIngestRequest = (value: unknown): EventIngestRequest | null => {
  if (!isRecord(value)) return null;

  const source = asString(value.source);
  const topicId = asString(value.topicId);
  const message = value.message;

  if (!source || !topicId || !isRecord(message)) return null;

  const type = asString(message.type);
  const agentId = asString(message.agentId);
  const timestamp = asNumber(message.timestamp);
  const payload = message.payload;

  if (!type || !agentId || timestamp === null || !isRecord(payload)) {
    return null;
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

export const parseBidSkipPayload = (
  payload: Record<string, unknown>,
  fallbackAgentId: string,
): BidSkipExtract => {
  return {
    jobId: asNumber(payload.jobId),
    agentId: asString(payload.agentId) ?? fallbackAgentId,
    reasonCode: asString(payload.reasonCode),
    reason: asString(payload.reason),
    inviteBudget: asNumber(payload.inviteBudget),
    bidAmount: asNumber(payload.bidAmount),
  };
};

export const parseLimit = (
  value: string | null,
  fallback: number,
  max: number,
): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};
