import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");

export const config = {
  root: ROOT,
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 7770),
  dataDir: resolve(process.env.DATA_DIR ?? join(ROOT, "data")),
  authToken: process.env.AUTH_TOKEN ?? "",
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
  /** How much of the end of a run's log is copied into runs.output when it finishes. */
  outputTailBytes: Number(process.env.OUTPUT_TAIL_BYTES ?? 64 * 1024),
};

export const logDir = join(config.dataDir, "logs");
mkdirSync(logDir, { recursive: true });
export const dbPath = join(config.dataDir, "agent-console.sqlite");
