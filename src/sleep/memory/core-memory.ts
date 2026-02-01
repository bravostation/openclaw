/**
 * Core memory extractor: identifies and persists identity-shaping memories.
 */

import fs from "node:fs/promises";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepDeepConfig } from "../config.js";
import { resolveMemoryDbPath, resolveCoreMemoriesPath } from "./utils.js";

const log = createSubsystemLogger("sleep/memory/core");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CoreMemoryTheme =
  | "user_preference"
  | "user_identity"
  | "user_values"
  | "communication_style"
  | "risk_tolerance"
  | "domain_expertise"
  | "relationship"
  | "other";

export type CoreMemory = {
  id: string;
  theme: CoreMemoryTheme;
  summary: string;
  confidence: number;
  supportingMemoryCount: number;
  createdAt: number;
  updatedAt: number;
  reinforcementCount: number;
};

export type CoreMemoryResult = {
  existingCount: number;
  newMemoriesCreated: number;
  memoriesReinforced: number;
  durationMs: number;
};

export type CoreMemoryOptions = {
  agentId: string;
  workspaceDir?: string;
  deepCfg: ResolvedSleepDeepConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Core Memory Storage
// ─────────────────────────────────────────────────────────────────────────────

async function loadCoreMemories(agentId: string): Promise<CoreMemory[]> {
  const filePath = resolveCoreMemoriesPath(agentId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as CoreMemory[];
  } catch {
    return [];
  }
}

async function saveCoreMemories(agentId: string, memories: CoreMemory[]): Promise<void> {
  const filePath = resolveCoreMemoriesPath(agentId);
  await fs.writeFile(filePath, JSON.stringify(memories, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Detection
// ─────────────────────────────────────────────────────────────────────────────

type PatternMatch = {
  theme: CoreMemoryTheme;
  summary: string;
  confidence: number;
  count: number;
};

const THEME_PATTERNS: Array<{
  theme: CoreMemoryTheme;
  patterns: RegExp[];
  extractSummary: (match: string) => string;
}> = [
  {
    theme: "user_preference",
    patterns: [
      /(?:i\s+)?prefer\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?like\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?always\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?never\s+(.+?)(?:\.|,|$)/gi,
    ],
    extractSummary: (match) => `User prefers: ${match.slice(0, 100)}`,
  },
  {
    theme: "user_identity",
    patterns: [
      /(?:my\s+name\s+is|i\s+am|i'm)\s+([a-z][a-z\s]+?)(?:\.|,|$)/gi,
      /(?:i\s+work\s+(?:at|for|as))\s+(.+?)(?:\.|,|$)/gi,
      /(?:i'm\s+a|i\s+am\s+a)\s+([a-z][a-z\s]+?)(?:\.|,|$)/gi,
    ],
    extractSummary: (match) => `User identity: ${match.slice(0, 100)}`,
  },
  {
    theme: "communication_style",
    patterns: [
      /(?:please\s+)?(?:be\s+)?(?:more\s+)?(?:concise|brief|detailed|verbose)/gi,
      /(?:don't|do\s+not)\s+(?:use|include)\s+(.+?)(?:\.|,|$)/gi,
    ],
    extractSummary: (match) => `Communication preference: ${match.slice(0, 100)}`,
  },
  {
    theme: "risk_tolerance",
    patterns: [
      /(?:be\s+)?(?:careful|cautious|conservative)\s+(?:with|about)\s+(.+?)(?:\.|,|$)/gi,
      /(?:don't|do\s+not)\s+(?:take\s+)?risks?\s+(?:with|on)\s+(.+?)(?:\.|,|$)/gi,
    ],
    extractSummary: (match) => `Risk preference: ${match.slice(0, 100)}`,
  },
];

async function detectPatterns(params: {
  dbPath: string;
  minRecurrence: number;
  signal?: AbortSignal;
}): Promise<PatternMatch[]> {
  const { dbPath, minRecurrence, signal } = params;
  const matches: Map<string, PatternMatch> = new Map();

  try {
    await fs.access(dbPath);
  } catch {
    return [];
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const rows = db
        .prepare(
          `SELECT text FROM chunks
          WHERE length(text) > 50
          ORDER BY updated_at DESC
          LIMIT 500`,
        )
        .all() as Array<{ text: string }>;

      for (const row of rows) {
        if (signal?.aborted) {
          break;
        }

        for (const { theme, patterns, extractSummary } of THEME_PATTERNS) {
          for (const pattern of patterns) {
            pattern.lastIndex = 0;
            const match = pattern.exec(row.text);
            if (match && match[1]) {
              const key = `${theme}:${match[1].toLowerCase().trim().slice(0, 50)}`;
              const existing = matches.get(key);
              if (existing) {
                existing.count++;
                existing.confidence = Math.min(1, existing.confidence + 0.1);
              } else {
                matches.set(key, {
                  theme,
                  summary: extractSummary(match[1]),
                  confidence: 0.5,
                  count: 1,
                });
              }
            }
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`Failed to detect patterns: ${String(err)}`);
  }

  // Filter by minimum recurrence
  return Array.from(matches.values()).filter((m) => m.count >= minRecurrence);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function extractCoreMemories(options: CoreMemoryOptions): Promise<CoreMemoryResult> {
  const startMs = Date.now();
  const { agentId, deepCfg, signal, dryRun } = options;

  if (!deepCfg.coreMemory.enabled) {
    return {
      existingCount: 0,
      newMemoriesCreated: 0,
      memoriesReinforced: 0,
      durationMs: 0,
    };
  }

  const dbPath = resolveMemoryDbPath(agentId);

  log.info(`Extracting core memories for agent ${agentId}`);

  // Load existing core memories
  const existing = await loadCoreMemories(agentId);
  const existingByKey = new Map(
    existing.map((m) => [`${m.theme}:${m.summary.toLowerCase().slice(0, 50)}`, m]),
  );

  // Detect patterns
  const patterns = await detectPatterns({
    dbPath,
    minRecurrence: deepCfg.coreMemory.minRecurrence,
    signal,
  });

  const minConfidence = deepCfg.coreMemory.minConfidence;
  let newMemoriesCreated = 0;
  let memoriesReinforced = 0;
  const nowMs = Date.now();

  for (const pattern of patterns) {
    if (signal?.aborted) {
      break;
    }
    if (pattern.confidence < minConfidence) {
      continue;
    }

    const key = `${pattern.theme}:${pattern.summary.toLowerCase().slice(0, 50)}`;
    const existingMemory = existingByKey.get(key);

    if (existingMemory) {
      // Reinforce existing memory
      existingMemory.confidence = Math.min(1, existingMemory.confidence + 0.1);
      existingMemory.reinforcementCount++;
      existingMemory.updatedAt = nowMs;
      memoriesReinforced++;
    } else {
      // Check maxPerCycle limit
      const maxPerCycle = deepCfg.coreMemory.maxPerCycle;
      if (newMemoriesCreated >= maxPerCycle) {
        log.debug(`Reached maxPerCycle (${maxPerCycle}) for core memory creation`);
        continue;
      }

      // Create new core memory
      const newMemory: CoreMemory = {
        id: `core-${nowMs}-${newMemoriesCreated}`,
        theme: pattern.theme,
        summary: pattern.summary,
        confidence: pattern.confidence,
        supportingMemoryCount: pattern.count,
        createdAt: nowMs,
        updatedAt: nowMs,
        reinforcementCount: 0,
      };
      existing.push(newMemory);
      existingByKey.set(key, newMemory);
      newMemoriesCreated++;
    }
  }

  // Save updated core memories
  if (!dryRun && (newMemoriesCreated > 0 || memoriesReinforced > 0)) {
    await saveCoreMemories(agentId, existing);
  }

  const durationMs = Date.now() - startMs;
  const maxPerCycle = deepCfg.coreMemory.maxPerCycle;

  log.info(
    `Core memory extraction complete: ${existing.length} total, ` +
      `${newMemoriesCreated} new${newMemoriesCreated >= maxPerCycle ? ` (capped at ${maxPerCycle}/cycle)` : ""}, ` +
      `${memoriesReinforced} reinforced (${durationMs}ms)`,
  );

  return {
    existingCount: existing.length - newMemoriesCreated,
    newMemoriesCreated,
    memoriesReinforced,
    durationMs,
  };
}

/**
 * Get all core memories for an agent.
 */
export async function getCoreMemories(agentId: string): Promise<CoreMemory[]> {
  return loadCoreMemories(agentId);
}
