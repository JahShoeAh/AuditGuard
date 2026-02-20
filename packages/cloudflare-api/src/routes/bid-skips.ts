import { jsonResponse } from "../lib/http";
import { listBidSkips } from "../lib/repositories/events-repo";
import { parseLimit } from "../lib/validation";
import type { RuntimeEnv } from "../types/runtime";

export const getBidSkips = async (
  request: Request,
  env: RuntimeEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"), 100, 1000);
  const reasonCode = url.searchParams.get("reasonCode")?.trim() || undefined;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;

  try {
    const bidSkips = await listBidSkips(env.DB, {
      limit,
      reasonCode,
      agentId,
    });

    return jsonResponse(request, env, { data: { bidSkips } }, 200);
  } catch (error) {
    return jsonResponse(
      request,
      env,
      {
        error: `Failed to load bid skips: ${String(error)}`,
      },
      500,
    );
  }
};
