import { jsonResponse, preflightResponse } from "./lib/http";
import { getBidSkips } from "./routes/bid-skips";
import { getEvents, postEvent } from "./routes/events";
import { getHealth } from "./routes/health";
import type { RuntimeEnv } from "./types/runtime";

export const handleRequest = async (
  request: Request,
  env: RuntimeEnv,
): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return preflightResponse(request, env);
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/health") {
    return getHealth(request, env);
  }

  if (request.method === "POST" && path === "/api/events") {
    return postEvent(request, env);
  }

  if (request.method === "GET" && path === "/api/events") {
    return getEvents(request, env);
  }

  if (request.method === "GET" && path === "/api/bid-skips") {
    return getBidSkips(request, env);
  }

  return jsonResponse(
    request,
    env,
    {
      error: `Route not found: ${request.method} ${path}`,
    },
    404,
  );
};
