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
  gracePeriodMs: number;
  maxPrunePercent: number;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{ pruned: number; bytesFreed: number }> {
  const { sessionsDir, maxAgeMs, gracePeriodMs, maxPrunePercent, signal, dryRun } = params;
  const nowMs = Date.now();
  let pruned = 0;
  let bytesFreed = 0;

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

    // First pass: collect candidates for pruning
    const candidates: Array<{ name: string; path: string; ageMs: number; size: number }> = [];

    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      const filePath = path.join(sessionsDir, entry.name);

      try {
        const stat = await fs.stat(filePath);
        const ageMs = nowMs - stat.mtimeMs;

        // Skip files within grace period (never prune recent files)
        if (ageMs < gracePeriodMs) continue;

        // Only consider files older than maxAge
        if (ageMs > maxAgeMs) {
          candidates.push({ name: entry.name, path: filePath, ageMs, size: stat.size });
        }
      } catch (err) {
        log.warn(`Failed to check session file ${entry.name}: ${String(err)}`);
      }
    }

    // Calculate max files to prune this cycle
    const totalFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).length;
    const maxToPrune = Math.max(1, Math.floor((totalFiles * maxPrunePercent) / 100));

    // Sort by age (oldest first) and limit
    candidates.sort((a, b) => b.ageMs - a.ageMs);
    const toPrune = candidates.slice(0, maxToPrune);

    // Prune selected files
    for (const candidate of toPrune) {
      if (signal?.aborted) break;

      try {
        if (!dryRun) {
          await fs.unlink(candidate.path);
        }
        pruned++;
        bytesFreed += candidate.size;
        log.debug(
          `Pruned session file: ${candidate.name} (age: ${Math.round(candidate.ageMs / 3600000)}h)`,
        );
      } catch (err) {
        log.warn(`Failed to prune session file ${candidate.name}: ${String(err)}`);
      }
    }

    if (candidates.length > toPrune.length) {
      log.info(
        `Pruning limited: ${toPrune.length}/${candidates.length} eligible files ` +
          `(max ${maxPrunePercent}% per cycle)`,
      );
    }
  } catch (err) {
    log.warn(`Failed to read sessions directory: ${String(err)}`);
  }

  return { pruned, bytesFreed };
}

async function pruneMemoryDatabase(params: {
  dbPath: string;
  maxAgeMs: number;
  gracePeriodMs: number;
  maxPrunePercent: number;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<{
  chunksBefore: number;
  chunksAfter: number;
  cacheEntriesPruned: number;
}> {
  const { dbPath, maxAgeMs, gracePeriodMs, maxPrunePercent, signal: _signal, dryRun } = params;

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

      if (!dryRun && chunksBefore > 0) {
        const nowMs = Date.now();
        const cutoffMs = nowMs - maxAgeMs;
        const graceCutoffMs = nowMs - gracePeriodMs;
        const cutoffSec = Math.floor(cutoffMs / 1000);
        const graceCutoffSec = Math.floor(graceCutoffMs / 1000);

        // Count how many chunks are eligible for pruning (older than maxAge AND older than grace)
        const eligibleResult = db
          .prepare("SELECT COUNT(*) as count FROM chunks WHERE updated_at < ? AND updated_at < ?")
          .get(cutoffSec, graceCutoffSec) as { count: number };
        const eligibleCount = eligibleResult?.count ?? 0;

        // Calculate max to prune this cycle
        const maxToPrune = Math.max(1, Math.floor((chunksBefore * maxPrunePercent) / 100));
        const actualToPrune = Math.min(eligibleCount, maxToPrune);

        if (actualToPrune > 0) {
          // Delete oldest chunks up to the limit
          // Use a subquery to select the oldest N chunks to delete
          db.prepare(
            `DELETE FROM chunks WHERE rowid IN (
              SELECT rowid FROM chunks 
              WHERE updated_at < ? AND updated_at < ?
              ORDER BY updated_at ASC
              LIMIT ?
            )`,
          ).run(cutoffSec, graceCutoffSec, actualToPrune);

          if (eligibleCount > actualToPrune) {
            log.info(
              `Chunk pruning limited: ${actualToPrune}/${eligibleCount} eligible chunks ` +
                `(max ${maxPrunePercent}% per cycle)`,
            );
          }
        }

        // Clean up orphaned vector entries
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

/**
 * Apply fuzziness to a threshold value.
 * Returns value +/- (fuzziness * value) randomly.
 */
function applyFuzziness(value: number, fuzziness: number): number {
  if (fuzziness <= 0) return value;
  const variance = value * fuzziness;
  const offset = (Math.random() * 2 - 1) * variance; // -variance to +variance
  return value + offset;
}

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

  const { maxAgeHours, gracePeriodHours, maxPrunePercentPerCycle, fuzziness } =
    deepCfg.memoryPruning;

  // Apply fuzziness to max age (allow some variance)
  const effectiveMaxAgeHours = applyFuzziness(maxAgeHours, fuzziness);
  const maxAgeMs = effectiveMaxAgeHours * 60 * 60 * 1000;

  // Grace period is a hard minimum - memories younger than this are never pruned
  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;

  const sessionsDir = resolveSessionsDir(agentId);
  const dbPath = resolveMemoryDbPath(agentId);

  log.info(
    `Pruning memories for agent ${agentId} (maxAge: ${Math.round(effectiveMaxAgeHours)}h, ` +
      `grace: ${gracePeriodHours}h, maxPrune: ${maxPrunePercentPerCycle}%)`,
  );

  // Prune session files (respects grace period and max percent)
  const sessionResult = await pruneOldSessionFiles({
    sessionsDir,
    maxAgeMs,
    gracePeriodMs,
    maxPrunePercent: maxPrunePercentPerCycle,
    signal,
    dryRun,
  });

  // Prune memory database (respects grace period and max percent)
  const dbResult = await pruneMemoryDatabase({
    dbPath,
    maxAgeMs,
    gracePeriodMs,
    maxPrunePercent: maxPrunePercentPerCycle,
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
