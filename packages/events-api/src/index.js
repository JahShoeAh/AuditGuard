// Load .env before any other module so DATABASE_URL is available to report-db.js
// and any other SDK module that reads process.env at import time.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const _dirname = dirname(fileURLToPath(import.meta.url));
try {
  const dotenv = _require("dotenv");
  dotenv.config({ path: resolve(_dirname, "../../../.env") });
} catch {
  // dotenv is optional; env vars may already be set by the shell
}

import express from "express";
import rateLimit from "express-rate-limit";
import { configureCors } from "./middleware/cors.js";
import { eventsRouter } from "./routes/events.js";
import { bidSkipsRouter } from "./routes/bid-skips.js";
import { healthRouter } from "./routes/health.js";
import { reportsRouter } from "./routes/reports.js";
import { jobsRouter } from "./routes/jobs.js";
import { schedulesRouter } from "./routes/schedules.js";
import { vaultsRouter } from "./routes/vaults.js";
import { initDb } from "./db.js";

const PORT = parseInt(process.env.EVENTS_API_PORT || "4000", 10);

const app = express();

// Rate limiter: 1000 requests per 15 minutes per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(express.json());
app.use(configureCors());

// Apply rate limiting to all /api routes
app.use("/api", apiLimiter);

app.use("/api", healthRouter);
app.use("/api", eventsRouter);
app.use("/api", bidSkipsRouter);
app.use("/api", reportsRouter);
app.use("/api", jobsRouter);
app.use("/api", schedulesRouter);
app.use("/api", vaultsRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

await initDb();

app.listen(PORT, () => {
  console.log(`[events-api] listening on port ${PORT}`);
});
