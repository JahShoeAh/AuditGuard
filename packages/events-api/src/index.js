import express from "express";
import { configureCors } from "./middleware/cors.js";
import { eventsRouter } from "./routes/events.js";
import { bidSkipsRouter } from "./routes/bid-skips.js";
import { healthRouter } from "./routes/health.js";
import { reportsRouter } from "./routes/reports.js";
import { initDb } from "./db.js";

const PORT = parseInt(process.env.EVENTS_API_PORT || "4000", 10);

const app = express();

app.use(express.json());
app.use(configureCors());

app.use("/api", healthRouter);
app.use("/api", eventsRouter);
app.use("/api", bidSkipsRouter);
app.use("/api", reportsRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

initDb();

app.listen(PORT, () => {
  console.log(`[events-api] listening on port ${PORT}`);
});
