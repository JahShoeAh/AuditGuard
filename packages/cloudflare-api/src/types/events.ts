export interface HCSMessagePayload {
  type: string;
  agentId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface EventIngestRequest {
  source: string;
  topicId: string;
  message: HCSMessagePayload;
}

export interface StoredAuditEvent {
  id: string;
  source: string;
  topicId: string;
  messageType: string;
  agentId: string;
  messageTimestamp: number;
  payload: Record<string, unknown>;
  rawMessage: HCSMessagePayload;
  receivedAt: string;
}

export interface StoredBidSkip {
  id: string;
  eventId: string;
  jobId: number | null;
  agentId: string;
  reasonCode: string | null;
  reason: string | null;
  inviteBudget: number | null;
  bidAmount: number | null;
  createdAt: string;
}

export interface BidSkipExtract {
  jobId: number | null;
  agentId: string;
  reasonCode: string | null;
  reason: string | null;
  inviteBudget: number | null;
  bidAmount: number | null;
}
