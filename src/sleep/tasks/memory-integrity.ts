/**
 * Memory integrity task: verifies memory store health.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { STATE_DIR } from "../../config/paths.js";
import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { createTaskResult, okItem, warningItem, errorItem, infoItem } from "./types.js";

function resolveAgentDirSimple(agentId: string): string {
  return path.join(STATE_DIR, "agents", agentId, "agent");
}

/**
 * Resolve memory database path for an agent.
 * Uses the same path as the main memory manager: ~/.openclaw/memory/{agentId}.sqlite
 */
function resolveMemoryDbPathSimple(agentId: string): string {
  return path.join(STATE_DIR, "memory", `${agentId}.sqlite`);
}

export const memoryIntegrityTask: ShallowSleepTask = {
  name: "memory-integrity",
  description: "Verify memory store integrity",
  critical: false,
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      const agentId = ctx.agentId ?? "default";
      const agentDir = resolveAgentDirSimple(agentId);

      // Check for memory index database (uses same path as memory manager)
      const memoryDbPath = resolveMemoryDbPathSimple(agentId);

      try {
        const stat = await fs.stat(memoryDbPath);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        items.push(okItem("Memory database exists", `${sizeMb} MB`));

        // Try to perform integrity check using SQLite
        // We use dynamic import to avoid requiring sqlite at module load
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(memoryDbPath, { readOnly: true });

          try {
            // Run SQLite integrity check
            const integrityResult = db.prepare("PRAGMA integrity_check").get() as {
              integrity_check: string;
            };

            if (integrityResult?.integrity_check === "ok") {
              items.push(okItem("SQLite integrity check passed"));
            } else {
              items.push(
                errorItem("SQLite integrity check failed", integrityResult?.integrity_check),
              );
            }

            // Get table stats
            const tables = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all() as {
              name: string;
            }[];

            for (const table of tables) {
              if (table.name.startsWith("sqlite_")) {
                continue;
              }
              try {
                const countResult = db
                  .prepare(`SELECT COUNT(*) as count FROM "${table.name}"`)
                  .get() as { count: number };
                items.push(infoItem(`Table: ${table.name}`, `${countResult?.count ?? 0} rows`));
              } catch {
                items.push(warningItem(`Table: ${table.name}`, "Could not read"));
              }
            }
          } finally {
            db.close();
          }
        } catch (err) {
          // SQLite not available or other error
          const error = err instanceof Error ? err.message : String(err);
          if (error.includes("Cannot find module") || error.includes("sqlite")) {
            items.push(infoItem("SQLite module not available for deep inspection"));
          } else {
            items.push(warningItem("Could not inspect database", error));
          }
        }
      } catch {
        items.push(infoItem("No memory database found", memoryDbPath));
      }

      // Check session transcripts directory
      const sessionsDir = path.join(agentDir, "sessions");
      try {
        const entries = await fs.readdir(sessionsDir);
        const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
        items.push(infoItem("Session transcripts", `${jsonlFiles.length} files`));
      } catch {
        items.push(infoItem("No session transcripts directory"));
      }

      // Check memory files in workspace
      if (ctx.workspaceDir) {
        const memoryDir = path.join(ctx.workspaceDir, "memory");
        try {
          const entries = await fs.readdir(memoryDir);
          const mdFiles = entries.filter((e) => e.endsWith(".md"));
          items.push(infoItem("Memory files in workspace", `${mdFiles.length} files`));
        } catch {
          // Memory directory doesn't exist, which is fine
        }

        // Check MEMORY.md
        const memoryMdPath = path.join(ctx.workspaceDir, "MEMORY.md");
        try {
          const stat = await fs.stat(memoryMdPath);
          const sizeKb = (stat.size / 1024).toFixed(1);
          items.push(okItem("MEMORY.md exists", `${sizeKb} KB`));
        } catch {
          // MEMORY.md doesn't exist, which is fine
        }
      }

      return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return createTaskResult({
        name: this.name,
        critical: this.critical,
        startMs,
        items,
        error,
      });
    }
  },
};
