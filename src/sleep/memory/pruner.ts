/**
 * Memory pruner: removes stale and decayed memory chunks.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepDeepConfig } from "../config.js";
import { resolveMemoryDbPath, resolveSessionsDir } from "./utils.js";

const log = createSubsystemLogger("sleep/memory/pruner");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PruneResult = {
  chunksBeforePrune: number;
  chunksAfterPrune: number;
  chunksPruned: number;
  sessionFilesPruned: number;
  cacheEntriesPruned: number;
  bytesFreed: number;
  durationMs: number;
};

export type PruneOptions = {
  agentId: string;
  deepCfg: ResolvedSleepDeepConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pruning Logic
// ─────────────────────────────────────────────────────────────────────────────

async function pruneOldSessionFiles(params: {
  sessionsDir: string;
  maxAgeMs: number;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{ pruned: number; bytesFreed: number }> {
  const { sessionsDir, maxAgeMs, signal, dryRun } = params;
  const nowMs = Date.now();
  let pruned = 0;
  let bytesFreed = 0;

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (signal?.aborted) {
        break;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(sessionsDir, entry.name);

      try {
        const stat = await fs.stat(filePath);
        const ageMs = nowMs - stat.mtimeMs;

        if (ageMs > maxAgeMs) {
          if (!dryRun) {
            await fs.unlink(filePath);
          }
          pruned++;
          bytesFreed += stat.size;
          log.debug(`Pruned session file: ${entry.name} (age: ${Math.round(ageMs / 3600000)}h)`);
        }
      } catch (err) {
        log.warn(`Failed to check/prune session file ${entry.name}: ${String(err)}`);
      }
    }
  } catch (err) {
    log.warn(`Failed to read sessions directory: ${String(err)}`);
  }

  return { pruned, bytesFreed };
}

async function pruneMemoryDatabase(params: {
  dbPath: string;
  maxAgeMs: number;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{
  chunksBefore: number;
  chunksAfter: number;
  cacheEntriesPruned: number;
}> {
  const { dbPath, maxAgeMs, signal: _signal, dryRun } = params;

  try {
    // Check if database exists
    await fs.access(dbPath);
  } catch {
    return { chunksBefore: 0, chunksAfter: 0, cacheEntriesPruned: 0 };
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: dryRun });

    try {
      // Get initial chunk count
      const beforeResult = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      };
      const chunksBefore = beforeResult?.count ?? 0;

      if (!dryRun) {
        // Delete old chunks based on updated_at timestamp
        const cutoffMs = Date.now() - maxAgeMs;
        const cutoffSec = Math.floor(cutoffMs / 1000);

        // Delete chunks older than cutoff (updated_at is likely in seconds or ms)
        db.prepare(`DELETE FROM chunks WHERE updated_at < ?`).run(cutoffSec);

        // Also clean up orphaned vector entries
        try {
          db.prepare(`DELETE FROM chunks_vec WHERE id NOT IN (SELECT id FROM chunks)`).run();
        } catch {
          // Vector table might not exist
        }

        // Clean up FTS entries
        try {
          db.prepare(`DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT rowid FROM chunks)`).run();
        } catch {
          // FTS table might not exist
        }
      }

      // Get final chunk count
      const afterResult = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      };
      const chunksAfter = afterResult?.count ?? 0;

      // Prune embedding cache
      let cacheEntriesPruned = 0;
      if (!dryRun) {
        try {
          const cacheBeforeResult = db
            .prepare("SELECT COUNT(*) as count FROM embedding_cache")
            .get() as { count: number };
          const cacheBefore = cacheBeforeResult?.count ?? 0;

          // Keep only cache entries that have corresponding chunks
          db.prepare(
            `DELETE FROM embedding_cache WHERE hash NOT IN (SELECT hash FROM chunks)`,
          ).run();

          const cacheAfterResult = db
            .prepare("SELECT COUNT(*) as count FROM embedding_cache")
            .get() as { count: number };
          const cacheAfter = cacheAfterResult?.count ?? 0;

          cacheEntriesPruned = cacheBefore - cacheAfter;
        } catch {
          // Cache table might not exist
        }

        // Vacuum to reclaim space
        try {
          db.exec("VACUUM");
        } catch (err) {
          log.warn(`VACUUM failed: ${String(err)}`);
        }
      }

      return { chunksBefore, chunksAfter, cacheEntriesPruned };
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`Failed to prune memory database: ${String(err)}`);
    return { chunksBefore: 0, chunksAfter: 0, cacheEntriesPruned: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function pruneMemories(options: PruneOptions): Promise<PruneResult> {
  const startMs = Date.now();
  const { agentId, deepCfg, signal, dryRun } = options;

  if (!deepCfg.memoryPruning.enabled) {
    return {
      chunksBeforePrune: 0,
      chunksAfterPrune: 0,
      chunksPruned: 0,
      sessionFilesPruned: 0,
      cacheEntriesPruned: 0,
      bytesFreed: 0,
      durationMs: 0,
    };
  }

  const maxAgeMs = deepCfg.memoryPruning.maxAgeHours * 60 * 60 * 1000;
  const sessionsDir = resolveSessionsDir(agentId);
  const dbPath = resolveMemoryDbPath(agentId);

  log.info(`Pruning memories for agent ${agentId} (maxAge: ${deepCfg.memoryPruning.maxAgeHours}h)`);

  // Prune session files
  const sessionResult = await pruneOldSessionFiles({
    sessionsDir,
    maxAgeMs,
    signal,
    dryRun,
  });

  // Prune memory database
  const dbResult = await pruneMemoryDatabase({
    dbPath,
    maxAgeMs,
    signal,
    dryRun,
  });

  const durationMs = Date.now() - startMs;
  const chunksPruned = dbResult.chunksBefore - dbResult.chunksAfter;

  log.info(
    `Pruning complete: ${chunksPruned} chunks, ${sessionResult.pruned} session files, ` +
      `${dbResult.cacheEntriesPruned} cache entries (${durationMs}ms)`,
  );

  return {
    chunksBeforePrune: dbResult.chunksBefore,
    chunksAfterPrune: dbResult.chunksAfter,
    chunksPruned,
    sessionFilesPruned: sessionResult.pruned,
    cacheEntriesPruned: dbResult.cacheEntriesPruned,
    bytesFreed: sessionResult.bytesFreed,
    durationMs,
  };
}
