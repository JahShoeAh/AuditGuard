// Message type strings aligned with agents/shared/types.ts
export const MessageType = {
  CONTRACT_DISCOVERED: "CONTRACT_DISCOVERED",
  SUB_AUCTION_POSTED: "SUB_AUCTION_POSTED",
  SUB_RESULT_DELIVERED: "SUB_RESULT_DELIVERED",
  DATA_LISTING_CREATED: "DATA_LISTING_CREATED",
  FINDINGS_SUBMITTED: "FINDINGS_SUBMITTED",
  AGENT_REGISTERED: "AGENT_REGISTERED",
  PING: "PING",
  PONG: "PONG",
  AUCTION_INVITE: "AUCTION_INVITE",                // orchestrator-originated (safe new type)
  WINNERS_SELECTED_FALLBACK: "WINNERS_SELECTED_FALLBACK", // orchestrator-originated
  AUDIT_LOG: "AUDIT_LOG",
};

export function now() {
  return Date.now();
}
