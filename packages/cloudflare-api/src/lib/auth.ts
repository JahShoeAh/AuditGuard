import type { RuntimeEnv } from "../types/runtime";

function extractToken(authorizationHeader: string | null): string {
  if (!authorizationHeader) return "";
  if (authorizationHeader.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length).trim();
  }
  return authorizationHeader.trim();
}

function isLocalAppEnv(env: RuntimeEnv): boolean {
  const appEnv = String(env.APP_ENV ?? "production").trim().toLowerCase();
  return appEnv === "local" || appEnv === "development" || appEnv === "dev";
}

export const isAuthorized = (request: Request, env: RuntimeEnv): boolean => {
  const requiredToken = env.INGEST_TOKEN?.trim();

  // Enforced policy:
  // - non-local environments must have INGEST_TOKEN configured and matched
  // - local/dev may run without INGEST_TOKEN
  if (!requiredToken || requiredToken.length === 0) {
    return isLocalAppEnv(env);
  }

  const providedToken = extractToken(request.headers.get("authorization"));
  return providedToken.length > 0 && providedToken === requiredToken;
};
