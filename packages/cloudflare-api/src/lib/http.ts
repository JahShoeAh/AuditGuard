import type { RuntimeEnv } from "../types/runtime";

const defaultHeaders = {
  "content-type": "application/json; charset=utf-8",
};

export const corsHeaders = (
  request: Request,
  env: RuntimeEnv,
): Record<string, string> => {
  const requestOrigin = request.headers.get("origin");
  const configuredOrigin = env.FRONTEND_ORIGIN?.trim() || "*";

  if (configuredOrigin === "*") {
    return {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    };
  }

  const allowOrigin = requestOrigin === configuredOrigin ? requestOrigin : configuredOrigin;
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    vary: "origin",
  };
};

export const jsonResponse = (
  request: Request,
  env: RuntimeEnv,
  body: unknown,
  status = 200,
): Response => {
  const headers = {
    ...defaultHeaders,
    ...corsHeaders(request, env),
  };

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
};

export const preflightResponse = (request: Request, env: RuntimeEnv): Response => {
  const headers = {
    ...corsHeaders(request, env),
  };

  return new Response(null, {
    status: 204,
    headers,
  });
};
