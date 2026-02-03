/**
 * Deep sleep phase: memory consolidation and cognitive work.
 *
 * Memory hierarchy:
 *   Short-term (daily chunks) → Medium-term (reinforced) → Long-term (stable) → Core (identity)
 *
 * With LLM reflection enabled, memory operations consult the agent's identity
 * (SOUL.md, IDENTITY.md) to make smarter pruning/promotion decisions.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { ResolvedSleepConfig } from "../config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  prepareReflectionContext,
  reflectOnPromotion,
  synthesizeCoreMemories,
  saveCoreMemoriesToWorkspace,
  saveLongTermMemoriesToWorkspace,
  type IdentityContext,
  type ResolvedLlmReflectionConfig,
  type ReflectionLogEntry,
  type CoreMemoryEntry,
  type LongTermMemoryEntry,
  type MemoryCandidate,
} from "../llm/index.js";
import {
  pruneMemories,
  compactMemories,
  promoteMemories,
  extractCoreMemories,
  processMediumTermMemories,
  getCoreMemories,
  getLongTermMemories,
  getMediumTermMemories,
  resolveCoreMemoriesPath,
  resolveLongTermMemoriesPath,
  type CoreMemory,
  type CoreMemoryTheme,
  type LongTermMemory,
  type PruneResult,
  type CompactResult,
  type PromoteResult,
  type CoreMemoryResult,
  type MediumTermResult,
} from "../memory/index.js";

const log = createSubsystemLogger("sleep/deep");
const MEDIUM_TERM_CATEGORY_SET = new Set([
  "fact",
  "pattern",
  "preference",
  "context",
  "relationship",
  "event",
  "other",
]);
const CORE_THEME_FROM_LLM: Record<CoreMemoryEntry["theme"], CoreMemoryTheme> = {
  user_preference: "user_preference",
  user_values: "user_values",
  behavioral_pattern: "communication_style",
  relationship: "relationship",
  expertise: "domain_expertise",
  goal: "other",
  constraint: "risk_tolerance",
};

function normalizeMediumTermCategory(value?: string): LongTermMemory["category"] {
  if (value && MEDIUM_TERM_CATEGORY_SET.has(value)) {
    return value as LongTermMemory["category"];
  }
  return "other";
}

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
  llmReflection: LlmReflectionResult | null;
  durationMs: number;
  abortReason?: string;
  error?: string;
};

export type LlmReflectionResult = {
  enabled: boolean;
  promotionLog?: ReflectionLogEntry;
  coreSynthesisLog?: ReflectionLogEntry;
  coreMemoriesCreated: number;
  longTermMemoriesPromoted: number;
  workspaceFilesUpdated: string[];
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
      llmReflection: null,
      durationMs: 0,
    };
  }

  log.info(`Starting deep sleep for agent ${agentId}`);

  let pruneResult: PruneResult | null = null;
  let compactResult: CompactResult | null = null;
  let mediumTermResult: MediumTermResult | null = null;
  let promoteResult: PromoteResult | null = null;
  let coreMemoryResult: CoreMemoryResult | null = null;
  let llmReflectionResult: LlmReflectionResult | null = null;
  let abortReason: string | undefined;
  let error: string | undefined;

  // Prepare LLM reflection context if enabled
  let identityContext: IdentityContext | undefined;
  let llmConfig: ResolvedLlmReflectionConfig | undefined;
  const llmEnabled = sleepCfg.deep.llmReflection.enabled && workspaceDir;

  if (llmEnabled && workspaceDir) {
    try {
      log.debug("Loading identity context for LLM reflection");
      const { resolveAgentDir } = await import("../../agents/agent-scope.js");
      const agentDir = resolveAgentDir(options.cfg, agentId);
      const ctx = await prepareReflectionContext({
        workspaceDir,
        agentDir,
        cfg: options.cfg,
        signal,
      });
      identityContext = ctx.identityContext;
      llmConfig = ctx.config;
      log.debug(
        `Identity context loaded: soul=${!!identityContext.soul}, ` +
          `identity=${!!identityContext.identity}, ` +
          `core=${identityContext.coreMemories.length}, ` +
          `longTerm=${identityContext.longTermMemories.length}`,
      );
    } catch (err) {
      log.warn(`Failed to load identity context: ${String(err)}`);
    }
  }

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
        cfg: options.cfg,
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
        cfg: options.cfg,
      });

      options.onPhaseComplete?.("coreMemory", coreMemoryResult);
      log.debug(`Core memory extraction complete: ${coreMemoryResult.newMemoriesCreated} new`);
    }

    // Phase 6: LLM-based reflection (optional, uses identity context)
    if (identityContext && llmConfig && workspaceDir && !signal?.aborted) {
      log.debug("Starting LLM-based memory reflection");
      options.onPhaseStart?.("llmReflection");

      llmReflectionResult = await runLlmReflection({
        cfg: options.cfg,
        workspaceDir,
        identityContext,
        agentId,
        llmConfig,
        signal,
        dryRun,
      });

      options.onPhaseComplete?.("llmReflection", llmReflectionResult);
      log.debug(
        `LLM reflection complete: ${llmReflectionResult.coreMemoriesCreated} core memories, ` +
          `${llmReflectionResult.longTermMemoriesPromoted} long-term promoted`,
      );
    }

    // Phase 7: Sync memories to workspace markdown files
    // This ensures MEMORIES-CORE.md and MEMORIES-LONG.md are always up-to-date
    // for bootstrap loading, even when LLM reflection is disabled
    if (workspaceDir && !signal?.aborted && !dryRun) {
      const llmUpdatedWorkspace =
        llmReflectionResult?.workspaceFilesUpdated &&
        llmReflectionResult.workspaceFilesUpdated.length > 0;

      // Only sync if LLM reflection didn't already update workspace files
      if (!llmUpdatedWorkspace) {
        log.debug("Syncing memories to workspace files");
        options.onPhaseStart?.("workspaceSync");

        try {
          await syncMemoriesToWorkspace({
            agentId,
            workspaceDir,
          });
          options.onPhaseComplete?.("workspaceSync", { synced: true });
          log.debug("Workspace memory files synced");
        } catch (syncErr) {
          log.warn(`Failed to sync workspace files: ${String(syncErr)}`);
        }
      }
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
    llmReflection: llmReflectionResult,
    durationMs,
    abortReason,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Reflection Phase
// ─────────────────────────────────────────────────────────────────────────────

async function runLlmReflection(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  identityContext: IdentityContext;
  agentId: string;
  llmConfig: ResolvedLlmReflectionConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
}): Promise<LlmReflectionResult> {
  const { cfg, workspaceDir, identityContext, agentId, llmConfig, signal, dryRun } = params;

  const result: LlmReflectionResult = {
    enabled: true,
    coreMemoriesCreated: 0,
    longTermMemoriesPromoted: 0,
    workspaceFilesUpdated: [],
  };

  // Convert medium-term memories to candidates for promotion review
  const promotionCandidates: MemoryCandidate[] = identityContext.mediumTermMemories
    .filter((m) => m.reinforcementCount >= 2) // Only consider reinforced memories
    .map((m) => ({
      id: m.id,
      content: m.content,
      tier: "medium" as const,
      timestamp: m.createdAt,
      accessCount: m.accessCount,
      confidence: m.confidence,
    }));

  // Step 1: LLM-guided promotion from medium-term to long-term
  if (promotionCandidates.length > 0 && !signal?.aborted) {
    try {
      log.debug(`Evaluating ${promotionCandidates.length} memories for promotion`);

      const { results, log: promotionLog } = await reflectOnPromotion({
        memories: promotionCandidates,
        identityContext,
        config: llmConfig,
        cfg,
        signal,
      });

      result.promotionLog = promotionLog;

      // Find memories that scored high enough for promotion
      const toPromote = results.filter((r) => r.relevance >= llmConfig.promoteRelevanceThreshold);

      if (toPromote.length > 0 && !dryRun) {
        // Get existing long-term memories
        const existingLongTerm = [...identityContext.longTermMemories];

        // Add new long-term memories
        const nowMs = Date.now();
        for (const promoted of toPromote) {
          const source = identityContext.mediumTermMemories.find((m) => m.id === promoted.id);
          if (source) {
            const newLongTerm: LongTermMemoryEntry = {
              id: `lt-${nowMs}-${existingLongTerm.length}`,
              content: source.content,
              confidence: promoted.relevance,
              createdAt: nowMs,
              accessCount: source.accessCount,
              tags: source.tags,
            };
            existingLongTerm.push(newLongTerm);
            result.longTermMemoriesPromoted++;
          }
        }

        try {
          saveLongTermMemoriesToWorkspace(workspaceDir, existingLongTerm);
          result.workspaceFilesUpdated.push("MEMORIES-LONG.md");
        } catch (err) {
          log.warn(`Failed to save long-term memories to workspace: ${String(err)}`);
        }

        const longTermToPersist: LongTermMemory[] = existingLongTerm.map((m) => ({
          id: m.id,
          category: normalizeMediumTermCategory(m.tags?.[0]),
          summary: m.content,
          confidence: m.confidence,
          reinforcementCount: m.accessCount,
          createdAt: m.createdAt,
          updatedAt: m.createdAt,
          originalMediumTermId: undefined,
        }));

        try {
          await persistLongTermMemories(agentId, longTermToPersist, cfg);
        } catch (err) {
          log.warn(`Failed to persist long-term memories: ${String(err)}`);
        }

        log.debug(`Promoted ${result.longTermMemoriesPromoted} memories to long-term`);
      }
    } catch (err) {
      log.warn(`LLM promotion reflection failed: ${String(err)}`);
    }
  }

  // Step 2: LLM-guided core memory synthesis
  if (identityContext.longTermMemories.length > 0 && !signal?.aborted) {
    try {
      log.debug(
        `Synthesizing core memories from ${identityContext.longTermMemories.length} long-term memories`,
      );

      const { results, log: synthesisLog } = await synthesizeCoreMemories({
        longTermMemories: identityContext.longTermMemories,
        identityContext,
        config: llmConfig,
        cfg,
        signal,
      });

      result.coreSynthesisLog = synthesisLog;

      if (results.length > 0 && !dryRun) {
        // Get existing core memories
        const existingCore = [...identityContext.coreMemories];
        const nowMs = Date.now();

        for (const synthesis of results) {
          // Check if this reinforces an existing core memory
          if (synthesis.reinforcesExisting) {
            const existing = existingCore.find((m) => m.id === synthesis.reinforcesExisting);
            if (existing) {
              existing.reinforcedAt = nowMs;
              existing.reinforcementCount = (existing.reinforcementCount ?? 0) + 1;
              existing.confidence = Math.min(1, existing.confidence + 0.1);
              log.debug(`Reinforced existing core memory: ${existing.id}`);
            }
          } else {
            // Create new core memory
            const newCore: CoreMemoryEntry = {
              id: `cm-${nowMs}-${existingCore.length}`,
              theme: synthesis.theme,
              description: synthesis.description,
              confidence: synthesis.confidence,
              supportingMemoryIds: synthesis.supportingMemoryIds,
              createdAt: nowMs,
            };
            existingCore.push(newCore);
            result.coreMemoriesCreated++;
            log.debug(
              `Created new core memory: ${synthesis.theme} - ${synthesis.description.slice(0, 50)}...`,
            );
          }
        }

        try {
          saveCoreMemoriesToWorkspace(workspaceDir, existingCore);
          result.workspaceFilesUpdated.push("MEMORIES-CORE.md");
        } catch (err) {
          log.warn(`Failed to save core memories to workspace: ${String(err)}`);
        }

        const coreToPersist: CoreMemory[] = existingCore.map((m) => ({
          id: m.id,
          theme: CORE_THEME_FROM_LLM[m.theme] ?? "other",
          summary: m.description,
          confidence: m.confidence,
          supportingMemoryCount: m.supportingMemoryIds.length,
          createdAt: m.createdAt,
          updatedAt: m.reinforcedAt ?? m.createdAt,
          reinforcementCount: m.reinforcementCount ?? 0,
        }));

        try {
          await persistCoreMemories(agentId, coreToPersist, cfg);
        } catch (err) {
          log.warn(`Failed to persist core memories: ${String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`LLM core synthesis failed: ${String(err)}`);
    }
  }

  return result;
}

async function persistCoreMemories(
  agentId: string,
  memories: CoreMemory[],
  cfg: OpenClawConfig,
): Promise<void> {
  const filePath = resolveCoreMemoriesPath(agentId, cfg);
  await writeJson(filePath, memories);
}

async function persistLongTermMemories(
  agentId: string,
  memories: LongTermMemory[],
  cfg: OpenClawConfig,
): Promise<void> {
  const filePath = resolveLongTermMemoriesPath(agentId, cfg);
  await writeJson(filePath, memories);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
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
  llmReflectionEnabled: boolean;
  llmCoreMemoriesCreated: number;
  llmLongTermPromoted: number;
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
    llmReflectionEnabled: result.llmReflection?.enabled ?? false,
    llmCoreMemoriesCreated: result.llmReflection?.coreMemoriesCreated ?? 0,
    llmLongTermPromoted: result.llmReflection?.longTermMemoriesPromoted ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync memory tier files from agent state to workspace markdown files.
 * This ensures MEMORIES-CORE.md and MEMORIES-LONG.md are always available
 * for bootstrap loading into agent context.
 *
 * Also writes medium-term memories to memory/memories-medium.md so they
 * get indexed by the memory search system.
 */
async function syncMemoriesToWorkspace(params: {
  agentId: string;
  workspaceDir: string;
}): Promise<void> {
  const { agentId, workspaceDir } = params;

  // Load core memories from agent JSON and convert to workspace format
  const coreMemories = await getCoreMemories(agentId);
  if (coreMemories.length > 0) {
    // Map CoreMemoryTheme to MemoryTheme (they have overlapping values)
    const themeMap: Record<string, CoreMemoryEntry["theme"]> = {
      user_preference: "user_preference",
      user_identity: "user_values", // Map to closest
      user_values: "user_values",
      communication_style: "behavioral_pattern",
      risk_tolerance: "constraint",
      domain_expertise: "expertise",
      relationship: "relationship",
      other: "user_preference", // Default fallback
    };

    const coreEntries: CoreMemoryEntry[] = coreMemories.map((m) => ({
      id: m.id,
      theme: themeMap[m.theme] ?? "user_preference",
      description: m.summary,
      confidence: m.confidence,
      supportingMemoryIds: [], // Not tracked in simple format
      createdAt: m.createdAt,
      reinforcedAt: m.updatedAt !== m.createdAt ? m.updatedAt : undefined,
      reinforcementCount: m.reinforcementCount,
    }));
    saveCoreMemoriesToWorkspace(workspaceDir, coreEntries);
  }

  // Load long-term memories from agent JSON and convert to workspace format
  const longTermMemories = await getLongTermMemories(agentId);
  if (longTermMemories.length > 0) {
    const longTermEntries: LongTermMemoryEntry[] = longTermMemories.map((m) => ({
      id: m.id,
      content: m.summary || m.detail?.slice(0, 200) || "",
      confidence: m.confidence,
      createdAt: m.createdAt,
      accessCount: m.reinforcementCount,
      tags: m.category ? [m.category] : undefined,
    }));
    saveLongTermMemoriesToWorkspace(workspaceDir, longTermEntries);
  }

  // Write medium-term memories to memory/ directory
  const mediumTermMemories = await getMediumTermMemories(agentId);
  if (mediumTermMemories.length > 0) {
    const memoryDir = path.join(workspaceDir, "memory");
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Write clean markdown for search tool indexing
    const mdPath = path.join(memoryDir, "memories-medium.md");
    const mdHeader = `# Medium-Term Memories

Patterns and learnings that have appeared multiple times.
Searched when relevant but not loaded into every context.

`;
    const mdLines = mediumTermMemories.map((m) => {
      // Clean single line with category context - extract first meaningful line
      const category = m.category.charAt(0).toUpperCase() + m.category.slice(1);
      const lines = m.summary.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
      const firstLine = (lines[0] || m.summary.split("\n")[0] || m.summary).trim();
      const cleaned = firstLine.replace(/^[-*]\s*/, "").replace(/\*\*/g, "");
      const truncated = cleaned.length > 100 ? cleaned.slice(0, 97) + "..." : cleaned;
      return `- **${category}:** ${truncated}`;
    });
    writeFileSync(mdPath, mdHeader + mdLines.join("\n"), "utf-8");

    // Write JSON for full metadata (sleep processing)
    const jsonPath = path.join(memoryDir, "memories-medium.json");
    const jsonEntries = mediumTermMemories.map((m) => ({
      id: m.id,
      category: m.category,
      summary: m.summary,
      detail: m.detail,
      confidence: m.confidence,
      reinforcementCount: m.reinforcementCount,
      promotedToLongTerm: m.promotedToLongTerm,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    writeFileSync(jsonPath, JSON.stringify(jsonEntries, null, 2), "utf-8");
  }
}
