import cors from "cors";

export function configureCors() {
  const frontendOrigin = (process.env.EVENTS_API_FRONTEND_ORIGIN || "").trim();

  if (!frontendOrigin || frontendOrigin === "*") {
    return cors({
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
    });
  }

  return cors({
    origin: frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
  });
}
