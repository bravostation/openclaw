/**
 * Medium-term memory storage: memories that have been reinforced from short-term
 * but haven't yet been promoted to long-term.
 *
 * Medium-term memories are:
 * - Searched when potentially useful to a conversation
 * - NOT auto-loaded into all conversations (unlike long-term/core)
 * - Promoted to long-term after sufficient reinforcement
 *
 * Memory hierarchy:
 *   Short-term (daily chunks) → Medium-term (reinforced) → Long-term (stable) → Core (identity)
 */

import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/config.js";
import type { ResolvedSleepDeepConfig } from "../config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveMediumTermMemoriesPath,
  resolveLongTermMemoriesPath,
  resolveMemoryDbPath,
} from "./utils.js";

const log = createSubsystemLogger("sleep/memory/medium-term");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MediumTermMemoryCategory =
  | "fact" // User facts, preferences stated explicitly
  | "pattern" // Detected behavioral patterns
  | "preference" // User preferences inferred from interactions
  | "context" // Important contextual information
  | "relationship" // Information about relationships, people, projects
  | "event" // Significant events or milestones
  | "other";

export type MediumTermMemory = {
  id: string;
  category: MediumTermMemoryCategory;
  summary: string;
  detail?: string;
  source: string; // Original session/chunk source
  confidence: number; // 0-1 confidence score
  reinforcementCount: number; // Times this memory has been reinforced
  lastReinforcedAt: number;
  createdAt: number;
  updatedAt: number;
  // Promotion tracking
  promotedToLongTerm?: boolean;
  promotedAt?: number;
};

export type LongTermMemory = {
  id: string;
  category: MediumTermMemoryCategory;
  summary: string;
  detail?: string;
  originalMediumTermId?: string;
  confidence: number;
  reinforcementCount: number;
  createdAt: number;
  updatedAt: number;
  // Never deleted, but can be weakened
  isWeakened?: boolean;
};

export type MediumTermResult = {
  memoriesBefore: number;
  memoriesAfter: number;
  newFromShortTerm: number;
  promotedToLongTerm: number;
  reinforced: number;
  durationMs: number;
};

export type MediumTermOptions = {
  agentId: string;
  deepCfg: ResolvedSleepDeepConfig;
  cfg?: OpenClawConfig;
  signal?: AbortSignal;
  dryRun?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

async function loadMediumTermMemories(
  agentId: string,
  cfg?: OpenClawConfig,
): Promise<MediumTermMemory[]> {
  const filePath = resolveMediumTermMemoriesPath(agentId, cfg);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as MediumTermMemory[];
  } catch {
    return [];
  }
}

async function saveMediumTermMemories(
  agentId: string,
  memories: MediumTermMemory[],
  cfg?: OpenClawConfig,
): Promise<void> {
  const filePath = resolveMediumTermMemoriesPath(agentId, cfg);
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(memories, null, 2), "utf-8");
}

async function loadLongTermMemories(
  agentId: string,
  cfg?: OpenClawConfig,
): Promise<LongTermMemory[]> {
  const filePath = resolveLongTermMemoriesPath(agentId, cfg);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as LongTermMemory[];
  } catch {
    return [];
  }
}

async function saveLongTermMemories(
  agentId: string,
  memories: LongTermMemory[],
  cfg?: OpenClawConfig,
): Promise<void> {
  const filePath = resolveLongTermMemoriesPath(agentId, cfg);
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(memories, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Detection for Medium-term Promotion
// ─────────────────────────────────────────────────────────────────────────────

type ChunkCandidate = {
  text: string;
  source: string;
  category: MediumTermMemoryCategory;
  confidence: number;
  updatedAt: number;
};

const CATEGORY_PATTERNS: Array<{
  category: MediumTermMemoryCategory;
  patterns: RegExp[];
  minConfidence: number;
}> = [
  {
    category: "fact",
    patterns: [
      /(?:my\s+name\s+is|i\s+am|i'm)\s+([a-z][a-z\s]+)/gi,
      /(?:i\s+work\s+(?:at|for|as|in))\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+live\s+in|my\s+(?:home|house|apartment)\s+is)\s+(.+?)(?:\.|,|$)/gi,
      /(?:my\s+(?:email|phone|number)\s+is)\s+(.+?)(?:\.|,|$)/gi,
    ],
    minConfidence: 0.7,
  },
  {
    category: "preference",
    patterns: [
      /(?:i\s+)?prefer\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?like\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?don't\s+like\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?always\s+(.+?)(?:\.|,|$)/gi,
      /(?:i\s+)?never\s+(.+?)(?:\.|,|$)/gi,
    ],
    minConfidence: 0.5,
  },
  {
    category: "pattern",
    patterns: [
      /(?:usually|typically|normally)\s+(?:i|we)\s+(.+?)(?:\.|,|$)/gi,
      /(?:every\s+(?:day|week|month|morning|evening))\s+(.+?)(?:\.|,|$)/gi,
    ],
    minConfidence: 0.4,
  },
  {
    category: "relationship",
    patterns: [
      /(?:my\s+(?:wife|husband|partner|friend|colleague|boss|team))\s+(.+?)(?:\.|,|$)/gi,
      /(?:working\s+with|collaborating\s+with)\s+(.+?)(?:\.|,|$)/gi,
    ],
    minConfidence: 0.5,
  },
  {
    category: "event",
    patterns: [
      /(?:yesterday|today|this\s+(?:week|month))\s+(.+?)(?:\.|,|$)/gi,
      /(?:just|recently)\s+(?:finished|completed|started)\s+(.+?)(?:\.|,|$)/gi,
      /(?:important|big|major)\s+(?:meeting|event|deadline)\s+(.+?)(?:\.|,|$)/gi,
    ],
    minConfidence: 0.4,
  },
];

/**
 * Extract candidates from short-term chunks for medium-term promotion.
 */
async function extractCandidatesFromChunks(params: {
  dbPath: string;
  signal?: AbortSignal;
}): Promise<ChunkCandidate[]> {
  const { dbPath, signal } = params;
  const candidates: ChunkCandidate[] = [];

  try {
    await fs.access(dbPath);
  } catch {
    return candidates;
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      // Get recent chunks
      const rows = db
        .prepare(
          `SELECT text, path as source, updated_at
          FROM chunks
          WHERE length(text) > 30
          ORDER BY updated_at DESC
          LIMIT 300`,
        )
        .all() as Array<{ text: string; source: string; updated_at: number }>;

      for (const row of rows) {
        if (signal?.aborted) {
          break;
        }

        for (const { category, patterns, minConfidence } of CATEGORY_PATTERNS) {
          for (const pattern of patterns) {
            pattern.lastIndex = 0;
            if (pattern.test(row.text)) {
              candidates.push({
                text: row.text.slice(0, 500),
                source: row.source,
                category,
                confidence: minConfidence,
                updatedAt: row.updated_at,
              });
              break; // One match per category per chunk
            }
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(`Failed to extract candidates: ${String(err)}`);
  }

  return candidates;
}

/**
 * Check if an extreme/important event should skip straight to long-term.
 */
function isExtremeEvent(text: string): boolean {
  const extremePatterns = [
    /(?:extremely|critically|urgently)\s+important/gi,
    /(?:never\s+forget|always\s+remember)/gi,
    /(?:life-changing|major\s+decision|critical\s+deadline)/gi,
    /(?:emergency|urgent|asap)/gi,
  ];

  return extremePatterns.some((p) => p.test(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process short-term chunks into medium-term memories.
 * Also handles promotion from medium-term to long-term.
 */
export async function processMediumTermMemories(
  options: MediumTermOptions,
): Promise<MediumTermResult> {
  const startMs = Date.now();
  const { agentId, deepCfg, signal, dryRun, cfg } = options;

  // Get config values with defaults
  const minReinforcements = deepCfg.memoryPromotion?.minReinforcementsForLongTerm ?? 3;
  const minConfidenceForLongTerm = deepCfg.memoryPromotion?.minConfidenceForLongTerm ?? 0.7;

  const dbPath = resolveMemoryDbPath(agentId);

  // Load existing memories
  const mediumTerm = await loadMediumTermMemories(agentId, cfg);
  const longTerm = await loadLongTermMemories(agentId, cfg);
  const memoriesBefore = mediumTerm.length;

  log.info(`Processing medium-term memories for agent ${agentId}`);

  // Extract candidates from short-term chunks
  const candidates = await extractCandidatesFromChunks({ dbPath, signal });

  const nowMs = Date.now();
  let newFromShortTerm = 0;
  let promotedToLongTerm = 0;
  let reinforced = 0;

  // Create lookup map for existing medium-term memories
  const existingBySummary = new Map<string, MediumTermMemory>();
  for (const mem of mediumTerm) {
    const key = mem.summary.toLowerCase().slice(0, 100);
    existingBySummary.set(key, mem);
  }

  // Process each candidate
  for (const candidate of candidates) {
    if (signal?.aborted) {
      break;
    }

    const summaryKey = candidate.text.toLowerCase().slice(0, 100);
    const existing = existingBySummary.get(summaryKey);

    // Check if this is an extreme event that should skip to long-term
    if (isExtremeEvent(candidate.text) && !existing) {
      // Skip directly to long-term
      const longTermMem: LongTermMemory = {
        id: `lt-${nowMs}-${longTerm.length}`,
        category: candidate.category,
        summary: candidate.text.slice(0, 200),
        detail: candidate.text,
        confidence: Math.min(1, candidate.confidence + 0.2),
        reinforcementCount: 1,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      longTerm.push(longTermMem);
      promotedToLongTerm++;
      log.debug(`Extreme event promoted directly to long-term: ${candidate.text.slice(0, 50)}...`);
      continue;
    }

    if (existing) {
      // Reinforce existing medium-term memory
      existing.reinforcementCount++;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.lastReinforcedAt = nowMs;
      existing.updatedAt = nowMs;
      reinforced++;

      // Check if ready for long-term promotion
      if (
        existing.reinforcementCount >= minReinforcements &&
        existing.confidence >= minConfidenceForLongTerm &&
        !existing.promotedToLongTerm
      ) {
        const longTermMem: LongTermMemory = {
          id: `lt-${nowMs}-${longTerm.length}`,
          category: existing.category,
          summary: existing.summary,
          detail: existing.detail,
          originalMediumTermId: existing.id,
          confidence: existing.confidence,
          reinforcementCount: existing.reinforcementCount,
          createdAt: nowMs,
          updatedAt: nowMs,
        };
        longTerm.push(longTermMem);
        existing.promotedToLongTerm = true;
        existing.promotedAt = nowMs;
        promotedToLongTerm++;
        log.debug(`Promoted to long-term: ${existing.summary.slice(0, 50)}...`);
      }
    } else {
      // Create new medium-term memory
      const newMem: MediumTermMemory = {
        id: `mt-${nowMs}-${mediumTerm.length}`,
        category: candidate.category,
        summary: candidate.text.slice(0, 200),
        detail: candidate.text.length > 200 ? candidate.text : undefined,
        source: candidate.source,
        confidence: candidate.confidence,
        reinforcementCount: 1,
        lastReinforcedAt: nowMs,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      mediumTerm.push(newMem);
      existingBySummary.set(summaryKey, newMem);
      newFromShortTerm++;
    }
  }

  // Save updated memories
  if (!dryRun) {
    await saveMediumTermMemories(agentId, mediumTerm, cfg);
    if (promotedToLongTerm > 0) {
      await saveLongTermMemories(agentId, longTerm, cfg);
    }
  }

  const durationMs = Date.now() - startMs;

  log.info(
    `Medium-term processing complete: ${mediumTerm.length} total, ` +
      `${newFromShortTerm} new, ${reinforced} reinforced, ${promotedToLongTerm} promoted (${durationMs}ms)`,
  );

  return {
    memoriesBefore,
    memoriesAfter: mediumTerm.length,
    newFromShortTerm,
    promotedToLongTerm,
    reinforced,
    durationMs,
  };
}

/**
 * Get all medium-term memories for an agent.
 */
export async function getMediumTermMemories(
  agentId: string,
  cfg?: OpenClawConfig,
): Promise<MediumTermMemory[]> {
  return loadMediumTermMemories(agentId, cfg);
}

/**
 * Get all long-term memories for an agent.
 */
export async function getLongTermMemories(
  agentId: string,
  cfg?: OpenClawConfig,
): Promise<LongTermMemory[]> {
  return loadLongTermMemories(agentId, cfg);
}

/**
 * Search medium-term memories (for use during conversations).
 */
export async function searchMediumTermMemories(
  agentId: string,
  query: string,
  limit = 5,
  cfg?: OpenClawConfig,
): Promise<MediumTermMemory[]> {
  const memories = await loadMediumTermMemories(agentId, cfg);
  const queryLower = query.toLowerCase();

  // Simple keyword matching (could be enhanced with embeddings)
  const scored = memories
    .filter((m) => !m.promotedToLongTerm) // Don't include already-promoted
    .map((m) => {
      const text = `${m.summary} ${m.detail ?? ""}`.toLowerCase();
      const words = queryLower.split(/\s+/);
      const matchCount = words.filter((w) => text.includes(w)).length;
      return { memory: m, score: matchCount / words.length };
    })
    .filter((s) => s.score > 0.3)
    .toSorted((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.memory);
}
