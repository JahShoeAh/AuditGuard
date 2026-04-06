import { Router } from "express";
import { getDb } from "../db.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    const db = getDb();
    const isHealthy = await db.healthCheck();

    return res.status(isHealthy ? 200 : 500).json({
      data: {
        status: "ok",
        db: isHealthy ? "connected" : "error",
      },
    });
  } catch (error) {
    return res.status(500).json({
      data: {
        status: "error",
        db: "error",
      },
      error: String(error),
    });
  }
});
