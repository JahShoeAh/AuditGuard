import { isAuthorized } from "../lib/auth";
import { jsonResponse } from "../lib/http";
import {
  insertAuditEvent,
  insertBidSkip,
  listEvents,
} from "../lib/repositories/events-repo";
import { parseEventIngestRequest, parseBidSkipPayload, parseLimit } from "../lib/validation";
import type { RuntimeEnv } from "../types/runtime";

export const postEvent = async (
  request: Request,
  env: RuntimeEnv,
): Promise<Response> => {
  if (!isAuthorized(request, env)) {
    return jsonResponse(request, env, { error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error: "Invalid JSON body" }, 400);
  }

  const parsed = parseEventIngestRequest(body);
  if (!parsed) {
    return jsonResponse(
      request,
      env,
      {
        error:
          "Invalid payload. Expected { source, topicId, message: { type, agentId, timestamp, payload } }.",
      },
      400,
    );
  }

  try {
    const eventId = await insertAuditEvent(env.DB, parsed);
    let bidSkipId: string | null = null;

    if (parsed.message.type === "BID_SKIPPED") {
      const bidSkip = parseBidSkipPayload(parsed.message.payload, parsed.message.agentId);
      bidSkipId = await insertBidSkip(env.DB, eventId, bidSkip);
    }

    return jsonResponse(
      request,
      env,
      {
        data: {
          eventId,
          bidSkipId,
        },
      },
      201,
    );
  } catch (error) {
    return jsonResponse(
      request,
      env,
      {
        error: `Failed to persist event: ${String(error)}`,
      },
      500,
    );
  }
};

export const getEvents = async (
  request: Request,
  env: RuntimeEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"), 100, 1000);
  const messageType = url.searchParams.get("type")?.trim() || undefined;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const topicId = url.searchParams.get("topicId")?.trim() || undefined;

  try {
    const events = await listEvents(env.DB, {
      limit,
      messageType,
      agentId,
      topicId,
    });

    return jsonResponse(request, env, { data: { events } }, 200);
  } catch (error) {
    return jsonResponse(
      request,
      env,
      {
        error: `Failed to load events: ${String(error)}`,
      },
      500,
    );
  }
};
