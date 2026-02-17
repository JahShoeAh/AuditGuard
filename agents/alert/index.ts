import {
  HCSClient,
  createAgentLogger,
  createAgentWallet,
} from "../shared/index.js";
import type { HCSMessage } from "../shared/types.js";

// ---- Config ----
const AGENT_ID = "alert-sentinel-001";
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

const log = createAgentLogger(AGENT_ID, "alert");

// ---- Main ----

async function main() {
  log.info("Alert Agent starting...");

  const wallet = createAgentWallet("ALERT");
  const hcs = new HCSClient(wallet.hederaClient);

  log.info(`Wallet: ${wallet.evmAddress}`);

  // Subscribe to audit log for report publications
  hcs.subscribeAuditLog(async (msg: HCSMessage) => {
    if (msg.type !== "REPORT_PUBLISHED") return;

    const { jobId, criticalCount, totalFindings, reportHash } = msg.payload as any;

    log.info(
      `Report received: job ${String(jobId).slice(0, 10)}... ` +
      `findings=${totalFindings} critical=${criticalCount}`
    );

    if (criticalCount > 0) {
      log.warn(`🚨 CRITICAL FINDINGS DETECTED: ${criticalCount} critical in job ${String(jobId).slice(0, 10)}...`);

      // Fire webhook
      if (WEBHOOK_URL) {
        try {
          const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `🚨 **AuditGuard Alert** — ${criticalCount} critical findings detected for contract ${jobId}`,
              embeds: [{
                title: "Critical Security Alert",
                color: 0xFF0000,
                fields: [
                  { name: "Job ID", value: String(jobId).slice(0, 20), inline: true },
                  { name: "Critical Findings", value: String(criticalCount), inline: true },
                  { name: "Total Findings", value: String(totalFindings), inline: true },
                  { name: "Report Hash", value: reportHash?.slice(0, 16) || "N/A", inline: false },
                ],
                timestamp: new Date().toISOString(),
              }],
            }),
          });
          log.info(`Webhook fired: status ${response.status}`);
        } catch (err) {
          log.error(`Webhook failed: ${err}`);
        }
      } else {
        log.info("No ALERT_WEBHOOK_URL configured — alert logged only");
      }

      // Log alert to HCS audit trail
      await hcs.publishAuditLog({
        type: "ALERT_FIRED",
        agentId: AGENT_ID,
        timestamp: Date.now(),
        payload: {
          jobId,
          criticalCount,
          totalFindings,
          reportHash,
          webhookSent: !!WEBHOOK_URL,
        },
      });
    }
  });

  log.info("Subscribed to audit log. Watching for critical findings...");
}

if (!process.env.VITEST) {
  main().catch((err) => {
    log.error(`Fatal: ${err}`);
    process.exit(1);
  });
}

// ─── Exported Pure Functions (for testing) ─────────────────────────────────

export function shouldAlert(msg: HCSMessage): boolean {
  if (msg.type !== "REPORT_PUBLISHED") return false;
  const { criticalFindings } = msg.payload as any;
  return criticalFindings > 0;
}

export async function fireWebhook(data: Record<string, unknown>): Promise<void> {
  // No-op when no webhook URL configured
  if (!WEBHOOK_URL) return;
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
