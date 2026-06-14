import crypto from "node:crypto";

// ============================================================
// Helper Functions
// ============================================================

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

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - True if strings are equal
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  // Different lengths = not equal (but still do constant-time comparison of buffers)
  if (a.length !== b.length) {
    return false;
  }

  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");

    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function logSecurityEvent(event, details) {
  const timestamp = new Date().toISOString();
  console.warn(`[SECURITY] ${timestamp} ${event}`, JSON.stringify(details));
}

// ============================================================
// Authentication Middleware
// ============================================================

const MIN_TOKEN_LENGTH = 32;

export function requireAuth(req, res, next) {
  const requiredToken = (process.env.EVENTS_API_INGEST_TOKEN || "").trim();

  // ENFORCE token in production
  if (!requiredToken || requiredToken.length < MIN_TOKEN_LENGTH) {
    if (isLocalAppEnv()) {
      // In local/dev, allow pass-through if no token configured
      return next();
    }

    // In production, server misconfiguration should fail closed
    logSecurityEvent("SERVER_MISCONFIGURED", {
      reason: `EVENTS_API_INGEST_TOKEN must be >= ${MIN_TOKEN_LENGTH} characters`,
    });
    return res.status(500).json({ error: "Server authentication not properly configured" });
  }

  const providedToken = extractToken(req.headers.authorization);

  // Use constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedToken, requiredToken)) {
    logSecurityEvent("AUTH_FAILED", {
      ip: req.ip,
      userAgent: req.get("user-agent"),
      endpoint: req.path,
      method: req.method,
      tokenProvided: providedToken.length > 0,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Authentication successful
  next();
}
