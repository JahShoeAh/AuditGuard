import express from "express";

const CAPABILITIES = [
  "TASK_ASSIGNMENT",
  "BID_REQUEST",
  "RESULT_SUBMISSION",
  "STATUS_QUERY",
];

export function createUcpServer(agent) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.post("/health", (req, res) => {
    if (req.body?.type !== "HEALTH_CHECK") {
      res.status(400).json({
        status: "error",
        message: "Expected body { type: 'HEALTH_CHECK' }",
      });
      return;
    }

    agent.log("Health check OK");
    res.status(200).json({
      status: "ok",
      agentId: agent.agentId,
      version: "1.0.0",
      capabilities: CAPABILITIES,
      timestamp: Date.now(),
    });
  });

  app.post("/task", (req, res) => {
    const { type, payload } = req.body ?? {};

    if (!type || payload == null) {
      res.status(400).json({
        status: "error",
        message: "Expected body { type, payload }",
      });
      return;
    }

    if (type === "AUCTION_INVITE") {
      res.status(202).json({ status: "accepted", type });
      Promise.resolve(agent.handleAuctionInvite(payload)).catch((error) => {
        agent.log(
          `Error in async AUCTION_INVITE handling: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }

    if (type === "TASK_ASSIGNED") {
      res.status(202).json({ status: "accepted", type });
      Promise.resolve(agent.handleTaskAssigned(payload)).catch((error) => {
        agent.log(
          `Error in async TASK_ASSIGNED handling: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }

    res.status(200).json({ status: "ignored", type });
  });

  app.get("/status", (_req, res) => {
    res.status(200).json(agent.getStatus());
  });

  return app;
}
