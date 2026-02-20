import { jsonResponse } from "../lib/http";
import { checkDbHealth } from "../lib/repositories/events-repo";
import type { RuntimeEnv } from "../types/runtime";

export const getHealth = async (
  request: Request,
  env: RuntimeEnv,
): Promise<Response> => {
  try {
    const isHealthy = await checkDbHealth(env.DB);
    return jsonResponse(
      request,
      env,
      {
        data: {
          status: "ok",
          db: isHealthy ? "connected" : "error",
        },
      },
      isHealthy ? 200 : 500,
    );
  } catch (error) {
    return jsonResponse(
      request,
      env,
      {
        data: {
          status: "error",
          db: "error",
        },
        error: String(error),
      },
      500,
    );
  }
};
