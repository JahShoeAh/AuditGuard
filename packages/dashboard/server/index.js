import { createRequire } from 'module';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

// Load .env from repo root before anything else reads process.env
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: resolve(__dirname, '../../../.env') });
} catch {
  // dotenv optional — env vars may be injected by the host (ECS, etc.)
}

import express from 'express';
import reportsRouter from './api/reports.js';

const app  = express();
const PORT = process.env.API_PORT ?? 3002;
const CORS = process.env.CORS_ORIGIN ?? '*';

// CORS — allow only the configured Vercel origin in production
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use('/api/reports', reportsRouter);

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`[API] listening on :${PORT}`));
