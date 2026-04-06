function extractToken(authorizationHeader) {
  if (!authorizationHeader) return "";
  if (authorizationHeader.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length).trim();
  }
  return authorizationHeader.trim();
}

function isLocalAppEnv() {
  const appEnv = String(process.env.APP_ENV ?? "production").trim().toLowerCase();
  return appEnv === "local" || appEnv === "development" || appEnv === "dev";
}

export function requireAuth(req, res, next) {
  const requiredToken = (process.env.EVENTS_API_INGEST_TOKEN || "").trim();

  if (!requiredToken || requiredToken.length === 0) {
    if (isLocalAppEnv()) {
      return next();
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  const providedToken = extractToken(req.headers.authorization);
  if (providedToken.length > 0 && providedToken === requiredToken) {
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}
