import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export const vaultsRouter = Router();

function parseLimit(raw, defaultVal = 100, max = 500) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(n, max);
}

const mapVaultRow = (row) => ({
  contractAddress: row.contract_address,
  vaultAddress: row.vault_address,
  creator: row.creator,
  contractChain: row.contract_chain,
  active: row.active,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

// ── GET /api/vaults ────────────────────────────────────────────────────

vaultsRouter.get("/vaults", async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const activeRaw = req.query.active;
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;

  try {
    const db = getDb();
    const rows = await db.queryVaults({ active, limit });
    return res.json({ data: { vaults: rows.map(mapVaultRow) } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load vaults: ${String(error)}` });
  }
});

// ── POST /api/vaults — upsert vault state ──────────────────────────────
// Called by the orchestrator when VaultCreated events arrive.

vaultsRouter.post("/vaults", requireAuth, async (req, res) => {
  const { contractAddress, vaultAddress, creator, contractChain, active } = req.body ?? {};

  if (!contractAddress || typeof contractAddress !== "string") {
    return res.status(400).json({ error: "contractAddress (string) is required" });
  }
  if (!vaultAddress || typeof vaultAddress !== "string") {
    return res.status(400).json({ error: "vaultAddress (string) is required" });
  }

  try {
    const db = getDb();
    await db.upsertVault({ contractAddress, vaultAddress, creator, contractChain, active });
    return res.status(201).json({ data: { contractAddress: contractAddress.toLowerCase() } });
  } catch (error) {
    return res.status(500).json({ error: `Failed to upsert vault: ${String(error)}` });
  }
});
