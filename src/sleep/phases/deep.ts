/**
 * Deep sleep phase: memory consolidation and cognitive work.
 *
 * Memory hierarchy:
 *   Short-term (daily chunks) → Medium-term (reinforced) → Long-term (stable) → Core (identity)
 */

import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepConfig } from "../config.js";
import {
  pruneMemories,
  compactMemories,
  promoteMemories,
  extractCoreMemories,
  processMediumTermMemories,
  type PruneResult,
  type CompactResult,
  type PromoteResult,
  type CoreMemoryResult,
  type MediumTermResult,
} from "../memory/index.js";

const log = createSubsystemLogger("sleep/deep");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DeepSleepResult = {
  status: "completed" | "aborted" | "failed";
  prune: PruneResult | null;
  compact: CompactResult | null;
  mediumTerm: MediumTermResult | null;
  promote: PromoteResult | null;
  coreMemory: CoreMemoryResult | null;
  durationMs: number;
  abortReason?: string;
  error?: string;
};

export type DeepSleepOptions = {
  cfg: OpenClawConfig;
  sleepCfg: ResolvedSleepConfig;
  workspaceDir?: string;
  agentId: string;
  signal?: AbortSignal;
  dryRun?: boolean;
  onPhaseStart?: (phase: string) => void;
  onPhaseComplete?: (phase: string, result: unknown) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function runDeepSleep(options: DeepSleepOptions): Promise<DeepSleepResult> {
  const startMs = Date.now();
  const { sleepCfg, workspaceDir, agentId, signal, dryRun } = options;

  if (!sleepCfg.deep.enabled) {
    log.info("Deep sleep disabled");
    return {
      status: "completed",
      prune: null,
      compact: null,
      mediumTerm: null,
      promote: null,
      coreMemory: null,
      durationMs: 0,
    };
  }

  log.info(`Starting deep sleep for agent ${agentId}`);

  let pruneResult: PruneResult | null = null;
  let compactResult: CompactResult | null = null;
  let mediumTermResult: MediumTermResult | null = null;
  let promoteResult: PromoteResult | null = null;
  let coreMemoryResult: CoreMemoryResult | null = null;
  let abortReason: string | undefined;
  let error: string | undefined;

  try {
    // Phase 1: Prune old memories (removes stale short-term chunks)
    if (sleepCfg.deep.memoryPruning.enabled && !signal?.aborted) {
      log.debug("Starting memory pruning");
      options.onPhaseStart?.("prune");

      pruneResult = await pruneMemories({
        agentId,
        deepCfg: sleepCfg.deep,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("prune", pruneResult);
      log.debug(`Pruning complete: ${pruneResult.chunksPruned} chunks removed`);
    }

    // Check for abort between phases
    if (signal?.aborted) {
      abortReason = "User interrupted";
      log.info("Deep sleep aborted after prune phase");
    }

    // Phase 2: Compact remaining short-term memories
    if (sleepCfg.deep.memoryCompaction.enabled && !signal?.aborted) {
      log.debug("Starting memory compaction");
      options.onPhaseStart?.("compact");

      compactResult = await compactMemories({
        agentId,
        deepCfg: sleepCfg.deep,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("compact", compactResult);
      log.debug(`Compaction complete: ${compactResult.chunksCompacted} chunks consolidated`);
    }

    // Check for abort between phases
    if (signal?.aborted && !abortReason) {
      abortReason = "User interrupted";
      log.info("Deep sleep aborted after compact phase");
    }

    // Phase 3: Process medium-term memories (Short→Medium, Medium→Long promotion)
    if (sleepCfg.deep.memoryPromotion.enabled && !signal?.aborted) {
      log.debug("Starting medium-term memory processing");
      options.onPhaseStart?.("mediumTerm");

      mediumTermResult = await processMediumTermMemories({
        agentId,
        deepCfg: sleepCfg.deep,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("mediumTerm", mediumTermResult);
      log.debug(
        `Medium-term processing complete: ${mediumTermResult.newFromShortTerm} new, ` +
          `${mediumTermResult.promotedToLongTerm} promoted to long-term`,
      );
    }

    // Check for abort between phases
    if (signal?.aborted && !abortReason) {
      abortReason = "User interrupted";
      log.info("Deep sleep aborted after medium-term phase");
    }

    // Phase 4: Legacy promotion (for backwards compatibility with existing MEMORY.md files)
    if (!signal?.aborted) {
      log.debug("Starting legacy memory promotion");
      options.onPhaseStart?.("promote");

      promoteResult = await promoteMemories({
        agentId,
        workspaceDir,
        deepCfg: sleepCfg.deep,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("promote", promoteResult);
      log.debug(`Legacy promotion complete: ${promoteResult.memoriesPromoted} memories promoted`);
    }

    // Check for abort between phases
    if (signal?.aborted && !abortReason) {
      abortReason = "User interrupted";
      log.info("Deep sleep aborted after promote phase");
    }

    // Phase 5: Extract core memories (identity-shaping patterns)
    if (sleepCfg.deep.coreMemory.enabled && !signal?.aborted) {
      log.debug("Starting core memory extraction");
      options.onPhaseStart?.("coreMemory");

      coreMemoryResult = await extractCoreMemories({
        agentId,
        workspaceDir,
        deepCfg: sleepCfg.deep,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("coreMemory", coreMemoryResult);
      log.debug(`Core memory extraction complete: ${coreMemoryResult.newMemoriesCreated} new`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error(`Deep sleep failed: ${error}`);
  }

  const durationMs = Date.now() - startMs;
  const status = error ? "failed" : abortReason ? "aborted" : "completed";

  log.info(`Deep sleep ${status} in ${durationMs}ms`);

  return {
    status,
    prune: pruneResult,
    compact: compactResult,
    mediumTerm: mediumTermResult,
    promote: promoteResult,
    coreMemory: coreMemoryResult,
    durationMs,
    abortReason,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

export type DeepSleepSummary = {
  memoriesBefore: number;
  memoriesAfter: number;
  memoriesPruned: number;
  memoriesCompacted: number;
  mediumTermNew: number;
  mediumTermReinforced: number;
  promotedToLongTerm: number;
  memoriesPromoted: number;
  coreMemoriesCreated: number;
  coreMemoriesReinforced: number;
};

export function summarizeDeepSleep(result: DeepSleepResult): DeepSleepSummary {
  const memoriesBefore =
    (result.prune?.chunksBeforePrune ?? 0) || (result.compact?.chunksBeforeCompact ?? 0);

  const memoriesAfter = result.compact?.chunksAfterCompact ?? result.prune?.chunksAfterPrune ?? 0;

  return {
    memoriesBefore,
    memoriesAfter,
    memoriesPruned: result.prune?.chunksPruned ?? 0,
    memoriesCompacted: result.compact?.chunksCompacted ?? 0,
    mediumTermNew: result.mediumTerm?.newFromShortTerm ?? 0,
    mediumTermReinforced: result.mediumTerm?.reinforced ?? 0,
    promotedToLongTerm: result.mediumTerm?.promotedToLongTerm ?? 0,
    memoriesPromoted: result.promote?.memoriesPromoted ?? 0,
    coreMemoriesCreated: result.coreMemory?.newMemoriesCreated ?? 0,
    coreMemoriesReinforced: result.coreMemory?.memoriesReinforced ?? 0,
  };
}
