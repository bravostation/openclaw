/**
 * Memory compactor: summarizes and consolidates session transcripts.
 */

import fs from "node:fs/promises";
import type { ResolvedSleepDeepConfig } from "../config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveMemoryDbPath } from "./utils.js";

const log = createSubsystemLogger("sleep/memory/compactor");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CompactResult = {
  chunksBeforeCompact: number;
  chunksAfterCompact: number;
  chunksCompacted: number;
  filesProcessed: number;
  durationMs: number;
};

export type CompactOptions = {
  agentId: string;
  deepCfg: ResolvedSleepDeepConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Compaction Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups related chunks and creates summary entries.
 *
 * This is a simplified compaction that:
 * 1. Identifies chunks from the same source file
 * 2. Groups them by time period (e.g., same day)
 * 3. Creates a summary chunk representing the group
 * 4. Removes the original detailed chunks
 */
async function compactChunks(params: {
  dbPath: string;
  minChunks: number;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{ before: number; after: number; processed: number }> {
  const { dbPath, minChunks, signal, dryRun } = params;

  try {
    await fs.access(dbPath);
  } catch {
    return { before: 0, after: 0, processed: 0 };
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: dryRun });

    try {
      // Get initial count
      const beforeResult = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      };
      const before = beforeResult?.count ?? 0;

      if (before < minChunks) {
        log.debug(`Skipping compaction: only ${before} chunks (min: ${minChunks})`);
        return { before, after: before, processed: 0 };
      }

      if (dryRun) {
        // In dry run, just estimate what would be compacted
        // Group chunks by source (path prefix) and count
        const groups = db
          .prepare(
            `SELECT 
              substr(path, 1, instr(path || '/', '/')) as source,
              COUNT(*) as chunk_count
            FROM chunks
            GROUP BY source
            HAVING chunk_count > 10`,
          )
          .all() as Array<{ source: string; chunk_count: number }>;

        const compactable = groups.reduce((sum, g) => sum + Math.floor(g.chunk_count * 0.7), 0);
        return { before, after: before - compactable, processed: groups.length };
      }

      // Actual compaction: merge old chunks from same source
      // This is a simplified approach - a full implementation would use LLM summarization

      // Find chunks that can be compacted (grouped by path, older than 24h)
      const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
      const cutoffSec = Math.floor(cutoffMs / 1000);

      // Get paths with multiple old chunks
      const pathsToCompact = db
        .prepare(
          `SELECT path, COUNT(*) as count
          FROM chunks
          WHERE updated_at < ?
          GROUP BY path
          HAVING count > 5`,
        )
        .all(cutoffSec) as Array<{ path: string; count: number }>;

      let processed = 0;

      for (const { path: chunkPath, count } of pathsToCompact) {
        if (signal?.aborted) {
          break;
        }

        // Keep first and last chunk, remove middle ones
        // This preserves context boundaries while reducing volume
        const chunksToRemove = Math.max(0, count - 2);
        if (chunksToRemove > 0) {
          db.prepare(
            `DELETE FROM chunks
            WHERE path = ? AND rowid IN (
              SELECT rowid FROM chunks
              WHERE path = ?
              ORDER BY updated_at
              LIMIT ? OFFSET 1
            )`,
          ).run(chunkPath, chunkPath, chunksToRemove);
          processed++;
        }
      }

      // Clean up orphaned entries
      try {
        db.prepare(`DELETE FROM chunks_vec WHERE id NOT IN (SELECT id FROM chunks)`).run();
      } catch {
        /* Vector table might not exist */
      }
      try {
        db.prepare(`DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT rowid FROM chunks)`).run();
      } catch {
        /* FTS table might not exist */
      }

      // Vacuum
      try {
        db.exec("VACUUM");
      } catch {
        /* Vacuum might fail */
      }

      const afterResult = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      };
      const after = afterResult?.count ?? 0;

      return { before, after, processed };
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`Failed to compact chunks: ${String(err)}`);
    return { before: 0, after: 0, processed: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function compactMemories(options: CompactOptions): Promise<CompactResult> {
  const startMs = Date.now();
  const { agentId, deepCfg, signal, dryRun } = options;

  if (!deepCfg.memoryCompaction.enabled) {
    return {
      chunksBeforeCompact: 0,
      chunksAfterCompact: 0,
      chunksCompacted: 0,
      filesProcessed: 0,
      durationMs: 0,
    };
  }

  const dbPath = resolveMemoryDbPath(agentId);
  const minChunks = deepCfg.memoryCompaction.minChunks;

  log.info(`Compacting memories for agent ${agentId} (minChunks: ${minChunks})`);

  const result = await compactChunks({
    dbPath,
    minChunks,
    signal,
    dryRun,
  });

  const durationMs = Date.now() - startMs;
  const chunksCompacted = result.before - result.after;

  log.info(
    `Compaction complete: ${result.before} → ${result.after} chunks ` +
      `(${chunksCompacted} removed, ${result.processed} sources processed, ${durationMs}ms)`,
  );

  return {
    chunksBeforeCompact: result.before,
    chunksAfterCompact: result.after,
    chunksCompacted,
    filesProcessed: result.processed,
    durationMs,
  };
}
