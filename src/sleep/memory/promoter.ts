/**
 * Memory promoter: promotes relevant short-term memories to long-term storage.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepDeepConfig } from "../config.js";
import { resolveMemoryDbPath } from "./utils.js";

const log = createSubsystemLogger("sleep/memory/promoter");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PromoteResult = {
  candidatesEvaluated: number;
  memoriesPromoted: number;
  durationMs: number;
};

export type PromoteOptions = {
  agentId: string;
  workspaceDir?: string;
  deepCfg: ResolvedSleepDeepConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Promotion Logic
// ─────────────────────────────────────────────────────────────────────────────

type MemoryCandidate = {
  text: string;
  source: string;
  score: number;
  accessCount: number;
  lastAccessedAt: number;
};

/**
 * Evaluates chunks for promotion to long-term memory.
 *
 * Promotion criteria:
 * - Frequently accessed chunks
 * - Chunks with high relevance scores in past searches
 * - Chunks containing user preferences or decisions
 * - Chunks old enough to be considered stable (minAgeMs)
 */
async function findPromotionCandidates(params: {
  dbPath: string;
  minAccessCount: number;
  minAgeMs: number;
  signal?: AbortSignal;
}): Promise<MemoryCandidate[]> {
  const { dbPath, minAccessCount: _minAccessCount, minAgeMs, signal } = params;
  const candidates: MemoryCandidate[] = [];
  const nowMs = Date.now();
  const cutoffSec = Math.floor((nowMs - minAgeMs) / 1000);

  try {
    await fs.access(dbPath);
  } catch {
    return candidates;
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      // Look for chunks that meet minimum age requirement
      // Note: This requires tracking access in the chunks table
      // For now, we use a heuristic based on chunk content patterns

      const rows = db
        .prepare(
          `SELECT text, path as source, updated_at
          FROM chunks
          WHERE length(text) > 100 AND updated_at < ?
          ORDER BY updated_at DESC
          LIMIT 100`,
        )
        .all(cutoffSec) as Array<{ text: string; source: string; updated_at: number }>;

      for (const row of rows) {
        if (signal?.aborted) {
          break;
        }

        // Score based on content patterns indicating importance
        let score = 0;

        const text = row.text.toLowerCase();

        // Patterns indicating user preferences
        if (text.includes("prefer") || text.includes("always") || text.includes("never")) {
          score += 0.3;
        }

        // Patterns indicating decisions
        if (text.includes("decided") || text.includes("choice") || text.includes("selected")) {
          score += 0.2;
        }

        // Patterns indicating important facts
        if (text.includes("important") || text.includes("remember") || text.includes("note:")) {
          score += 0.2;
        }

        // Patterns indicating user identity
        if (text.includes("my name") || text.includes("i am") || text.includes("i work")) {
          score += 0.3;
        }

        if (score > 0) {
          candidates.push({
            text: row.text,
            source: row.source,
            score,
            accessCount: 1, // Placeholder
            lastAccessedAt: row.updated_at,
          });
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`Failed to find promotion candidates: ${String(err)}`);
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Promotes a memory candidate to long-term storage (MEMORY.md or memory/*.md).
 */
async function promoteToLongTerm(params: {
  candidate: MemoryCandidate;
  workspaceDir: string;
  dryRun?: boolean;
}): Promise<boolean> {
  const { candidate, workspaceDir, dryRun } = params;

  if (dryRun) {
    return true;
  }

  try {
    // Append to a dated memory file
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const date = new Date().toISOString().split("T")[0];
    const memoryFile = path.join(memoryDir, `${date}-promoted.md`);

    // Create a formatted entry
    const entry = `
## Promoted Memory (${new Date().toISOString()})

Source: ${candidate.source}
Score: ${candidate.score.toFixed(2)}

${candidate.text.slice(0, 500)}${candidate.text.length > 500 ? "..." : ""}

---
`;

    await fs.appendFile(memoryFile, entry, "utf-8");
    return true;
  } catch (err) {
    log.warn(`Failed to promote memory: ${String(err)}`);
    return false;
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
  const offset = (Math.random() * 2 - 1) * variance;
  return Math.max(0, Math.min(1, value + offset)); // Clamp to 0-1 for confidence
}

export async function promoteMemories(options: PromoteOptions): Promise<PromoteResult> {
  const startMs = Date.now();
  const { agentId, workspaceDir, deepCfg, signal, dryRun } = options;

  // Check if promotion is enabled
  if (!deepCfg.enabled || !deepCfg.memoryPromotion.enabled) {
    return {
      candidatesEvaluated: 0,
      memoriesPromoted: 0,
      durationMs: 0,
    };
  }

  const {
    minReinforcementsForLongTerm,
    minConfidenceForLongTerm,
    minAgeHoursForPromotion,
    maxPromotePercentPerCycle,
    fuzziness,
  } = deepCfg.memoryPromotion;

  const dbPath = resolveMemoryDbPath(agentId);

  // Apply fuzziness to the confidence threshold
  const effectiveConfidence = applyFuzziness(minConfidenceForLongTerm, fuzziness);
  const minAgeMs = minAgeHoursForPromotion * 60 * 60 * 1000;

  log.info(
    `Evaluating memories for promotion (agent: ${agentId}, ` +
      `minAge: ${minAgeHoursForPromotion}h, minConf: ${effectiveConfidence.toFixed(2)}, ` +
      `maxPromote: ${maxPromotePercentPerCycle}%)`,
  );

  const candidates = await findPromotionCandidates({
    dbPath,
    minAccessCount: minReinforcementsForLongTerm,
    minAgeMs,
    signal,
  });

  if (candidates.length === 0) {
    log.debug("No promotion candidates found");
    return {
      candidatesEvaluated: 0,
      memoriesPromoted: 0,
      durationMs: Date.now() - startMs,
    };
  }

  // Filter by effective confidence and calculate max to promote
  const eligible = candidates.filter((c) => c.score >= effectiveConfidence);
  const maxToPromote = Math.max(
    1,
    Math.floor((candidates.length * maxPromotePercentPerCycle) / 100),
  );
  const toPromote = eligible.slice(0, maxToPromote);

  if (eligible.length > toPromote.length) {
    log.info(
      `Promotion limited: ${toPromote.length}/${eligible.length} eligible memories ` +
        `(max ${maxPromotePercentPerCycle}% per cycle)`,
    );
  }

  let promoted = 0;

  if (workspaceDir && toPromote.length > 0) {
    for (const candidate of toPromote) {
      if (signal?.aborted) {
        break;
      }

      const success = await promoteToLongTerm({
        candidate,
        workspaceDir,
        dryRun,
      });

      if (success) {
        promoted++;
      }
    }
  }

  const durationMs = Date.now() - startMs;

  log.info(
    `Promotion complete: ${candidates.length} evaluated, ${promoted} promoted (${durationMs}ms)`,
  );

  return {
    candidatesEvaluated: candidates.length,
    memoriesPromoted: promoted,
    durationMs,
  };
}
