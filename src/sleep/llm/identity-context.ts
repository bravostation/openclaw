/**
 * Identity context loading for LLM-based memory reflection.
 *
 * Loads SOUL.md, IDENTITY.md, and existing memory tiers from the workspace
 * to provide full context for LLM memory operations.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { loadWorkspaceBootstrapFiles } from "../../agents/workspace.js";
import type {
  CoreMemoryEntry,
  IdentityContext,
  LongTermMemoryEntry,
  MediumTermMemoryEntry,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Memory File Names
// ─────────────────────────────────────────────────────────────────────────────

export const CORE_MEMORIES_FILENAME = "MEMORIES-CORE.md";
export const CORE_MEMORIES_JSON_FILENAME = "memory/memories-core.json";
export const LONG_TERM_MEMORIES_FILENAME = "MEMORIES-LONG.md";
export const LONG_TERM_MEMORIES_JSON_FILENAME = "memory/memories-long.json";
export const MEDIUM_TERM_MEMORIES_FILENAME = "memories-medium.json";

// ─────────────────────────────────────────────────────────────────────────────
// Parsing Memory Files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a markdown-formatted core memories file.
 * Format:
 * ```
 * ## Theme Name
 * - **ID**: cm-xxx
 * - **Theme**: user_values
 * - **Confidence**: 0.92
 * - **Description**: User prioritizes privacy
 * - **Supporting memories**: [m-123, m-456]
 * ```
 */
export function parseCoreMemoriesMarkdown(content: string): CoreMemoryEntry[] {
  const memories: CoreMemoryEntry[] = [];
  const sections = content.split(/^## /m).filter((s) => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const entry: Partial<CoreMemoryEntry> = {};

    for (const line of lines) {
      const idMatch = line.match(/\*\*ID\*\*:\s*(.+)/);
      if (idMatch) {
        entry.id = idMatch[1]?.trim();
      }
      const themeMatch = line.match(/\*\*Theme\*\*:\s*(.+)/);
      if (themeMatch) {
        entry.theme = themeMatch[1]?.trim() as CoreMemoryEntry["theme"];
      }
      const confMatch = line.match(/\*\*Confidence\*\*:\s*([\d.]+)/);
      if (confMatch) {
        entry.confidence = parseFloat(confMatch[1] ?? "0");
      }
      const descMatch = line.match(/\*\*Description\*\*:\s*(.+)/);
      if (descMatch) {
        entry.description = descMatch[1]?.trim() ?? "";
      }
      const supMatch = line.match(/\*\*Supporting memories\*\*:\s*\[(.+)\]/);
      if (supMatch) {
        entry.supportingMemoryIds = supMatch[1]?.split(",").map((s) => s.trim()) ?? [];
      }
      const createdMatch = line.match(/\*\*Created\*\*:\s*(\d+)/);
      if (createdMatch) {
        entry.createdAt = parseInt(createdMatch[1] ?? "0", 10);
      }
      const reinforcedMatch = line.match(/\*\*Reinforced\*\*:\s*(\d+)/);
      if (reinforcedMatch) {
        entry.reinforcedAt = parseInt(reinforcedMatch[1] ?? "0", 10);
      }
      const countMatch = line.match(/\*\*Reinforcement count\*\*:\s*(\d+)/);
      if (countMatch) {
        entry.reinforcementCount = parseInt(countMatch[1] ?? "0", 10);
      }
    }

    if (entry.id && entry.theme && entry.description) {
      memories.push({
        id: entry.id,
        theme: entry.theme,
        description: entry.description,
        confidence: entry.confidence ?? 0.5,
        supportingMemoryIds: entry.supportingMemoryIds ?? [],
        createdAt: entry.createdAt ?? Date.now(),
        reinforcedAt: entry.reinforcedAt,
        reinforcementCount: entry.reinforcementCount,
      });
    }
  }

  return memories;
}

/**
 * Parse a markdown-formatted long-term memories file.
 * Format:
 * ```
 * ## Memory Title
 * - **ID**: lt-xxx
 * - **Content**: The actual memory content
 * - **Confidence**: 0.85
 * - **Access count**: 5
 * ```
 */
export function parseLongTermMemoriesMarkdown(content: string): LongTermMemoryEntry[] {
  const memories: LongTermMemoryEntry[] = [];
  const sections = content.split(/^## /m).filter((s) => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const entry: Partial<LongTermMemoryEntry> = {};

    for (const line of lines) {
      const idMatch = line.match(/\*\*ID\*\*:\s*(.+)/);
      if (idMatch) {
        entry.id = idMatch[1]?.trim();
      }
      const contentMatch = line.match(/\*\*Content\*\*:\s*(.+)/);
      if (contentMatch) {
        entry.content = contentMatch[1]?.trim() ?? "";
      }
      const confMatch = line.match(/\*\*Confidence\*\*:\s*([\d.]+)/);
      if (confMatch) {
        entry.confidence = parseFloat(confMatch[1] ?? "0");
      }
      const accessMatch = line.match(/\*\*Access count\*\*:\s*(\d+)/);
      if (accessMatch) {
        entry.accessCount = parseInt(accessMatch[1] ?? "0", 10);
      }
      const createdMatch = line.match(/\*\*Created\*\*:\s*(\d+)/);
      if (createdMatch) {
        entry.createdAt = parseInt(createdMatch[1] ?? "0", 10);
      }
      const tagsMatch = line.match(/\*\*Tags\*\*:\s*\[(.+)\]/);
      if (tagsMatch) {
        entry.tags = tagsMatch[1]?.split(",").map((s) => s.trim()) ?? [];
      }
    }

    if (entry.id && entry.content) {
      memories.push({
        id: entry.id,
        content: entry.content,
        confidence: entry.confidence ?? 0.5,
        createdAt: entry.createdAt ?? Date.now(),
        accessCount: entry.accessCount ?? 0,
        tags: entry.tags,
      });
    }
  }

  return memories;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading Identity Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the full identity context from the workspace.
 * Includes SOUL.md, IDENTITY.md, and all memory tiers.
 */
export async function loadIdentityContext(params: {
  workspaceDir: string;
  agentDir: string;
}): Promise<IdentityContext> {
  // Load SOUL.md and IDENTITY.md via standard bootstrap loader
  const bootstrapFiles = await loadWorkspaceBootstrapFiles(params.workspaceDir);

  const soul = bootstrapFiles.find((f) => f.name === "SOUL.md")?.content;
  const identity = bootstrapFiles.find((f) => f.name === "IDENTITY.md")?.content;

  // Load workspace memory files
  const coreMemories = loadCoreMemoriesFromWorkspace(params.workspaceDir);
  const longTermMemories = loadLongTermMemoriesFromWorkspace(params.workspaceDir);
  const mediumTermMemories = loadMediumTermMemoriesFromAgent(params.agentDir);

  return {
    soul,
    identity,
    coreMemories,
    longTermMemories,
    mediumTermMemories,
  };
}

/**
 * Load core memories from workspace - prefer JSON, fallback to markdown parsing.
 */
export function loadCoreMemoriesFromWorkspace(workspaceDir: string): CoreMemoryEntry[] {
  // Prefer JSON for full metadata
  const jsonPath = path.join(workspaceDir, CORE_MEMORIES_JSON_FILENAME);
  if (existsSync(jsonPath)) {
    try {
      const content = readFileSync(jsonPath, "utf-8");
      return JSON.parse(content) as CoreMemoryEntry[];
    } catch {
      // Fall through to markdown parsing
    }
  }

  // Fallback to markdown (for backwards compatibility)
  const mdPath = path.join(workspaceDir, CORE_MEMORIES_FILENAME);
  if (!existsSync(mdPath)) {
    return [];
  }

  try {
    const content = readFileSync(mdPath, "utf-8");
    return parseCoreMemoriesMarkdown(content);
  } catch {
    return [];
  }
}

/**
 * Load long-term memories from workspace - prefer JSON, fallback to markdown parsing.
 */
export function loadLongTermMemoriesFromWorkspace(workspaceDir: string): LongTermMemoryEntry[] {
  // Prefer JSON for full metadata
  const jsonPath = path.join(workspaceDir, LONG_TERM_MEMORIES_JSON_FILENAME);
  if (existsSync(jsonPath)) {
    try {
      const content = readFileSync(jsonPath, "utf-8");
      return JSON.parse(content) as LongTermMemoryEntry[];
    } catch {
      // Fall through to markdown parsing
    }
  }

  // Fallback to markdown (for backwards compatibility)
  const mdPath = path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME);
  if (!existsSync(mdPath)) {
    return [];
  }

  try {
    const content = readFileSync(mdPath, "utf-8");
    return parseLongTermMemoriesMarkdown(content);
  } catch {
    return [];
  }
}

/**
 * Load medium-term memories from agent state directory.
 */
export function loadMediumTermMemoriesFromAgent(agentDir: string): MediumTermMemoryEntry[] {
  const filePath = path.join(agentDir, "memories", MEDIUM_TERM_MEMORIES_FILENAME);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as MediumTermMemoryEntry[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing Memory Files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a core memory as a clean, single-line entry for context.
 * Includes the memory and WHY it matters, but no metadata.
 */
function formatCoreMemoryLine(memory: CoreMemoryEntry): string {
  // Theme provides the "why" context
  const themeLabel: Record<CoreMemoryEntry["theme"], string> = {
    user_preference: "Preference",
    user_values: "Value",
    behavioral_pattern: "Pattern",
    constraint: "Constraint",
    expertise: "Expertise",
    relationship: "Relationship",
    goal: "Goal",
  };
  const why = themeLabel[memory.theme] || "Memory";
  return `- **${why}:** ${memory.description}`;
}

/**
 * Format a long-term memory as a clean, single-line entry for context.
 * Includes the memory content with tag-based context.
 */
function formatLongTermMemoryLine(memory: LongTermMemoryEntry): string {
  // Extract first meaningful line, skipping headers and empty content
  const lines = memory.content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const firstLine = lines[0]?.trim() || memory.content.split("\n")[0]?.trim() || memory.content;

  // Clean up the line - remove markdown cruft
  const cleaned = firstLine
    .replace(/^[-*]\s*/, "") // Remove list markers
    .replace(/\*\*/g, "") // Remove bold
    .slice(0, 150);
  const truncated = cleaned.length >= 150 ? cleaned.slice(0, 147) + "..." : cleaned;

  // Use tags to provide context if available
  const tag = memory.tags?.[0];
  if (tag && tag !== "fact") {
    const tagLabel = tag.charAt(0).toUpperCase() + tag.slice(1);
    return `- **${tagLabel}:** ${truncated}`;
  }
  return `- ${truncated}`;
}

/**
 * Save core memories to workspace - both clean MD for context and JSON for working data.
 */
export function saveCoreMemoriesToWorkspace(
  workspaceDir: string,
  memories: CoreMemoryEntry[],
): void {
  // Ensure memory directory exists
  const memoryDir = path.join(workspaceDir, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Write clean markdown for context loading (no metadata)
  const mdPath = path.join(workspaceDir, CORE_MEMORIES_FILENAME);
  const mdHeader = `# Core Memories

Identity-shaping experiences and patterns that define who I am.

`;
  const mdContent = mdHeader + memories.map((m) => formatCoreMemoryLine(m)).join("\n");
  writeFileSync(mdPath, mdContent, "utf-8");

  // Write JSON for working data (full metadata for sleep processing)
  const jsonPath = path.join(workspaceDir, CORE_MEMORIES_JSON_FILENAME);
  writeFileSync(jsonPath, JSON.stringify(memories, null, 2), "utf-8");
}

/**
 * Save long-term memories to workspace - both clean MD for context and JSON for working data.
 */
export function saveLongTermMemoriesToWorkspace(
  workspaceDir: string,
  memories: LongTermMemoryEntry[],
): void {
  // Ensure memory directory exists
  const memoryDir = path.join(workspaceDir, "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Write clean markdown for context loading (no metadata)
  const mdPath = path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME);
  const mdHeader = `# Long-Term Memories

Stable facts, preferences, and knowledge I've learned over time.

`;
  const mdContent = mdHeader + memories.map((m) => formatLongTermMemoryLine(m)).join("\n");
  writeFileSync(mdPath, mdContent, "utf-8");

  // Write JSON for working data (full metadata for sleep processing)
  const jsonPath = path.join(workspaceDir, LONG_TERM_MEMORIES_JSON_FILENAME);
  writeFileSync(jsonPath, JSON.stringify(memories, null, 2), "utf-8");
}

/**
 * Save medium-term memories to agent state directory.
 */
export function saveMediumTermMemoriesToAgent(
  agentDir: string,
  memories: MediumTermMemoryEntry[],
): void {
  const memoriesDir = path.join(agentDir, "memories");
  if (!existsSync(memoriesDir)) {
    mkdirSync(memoriesDir, { recursive: true });
  }

  const filePath = path.join(memoriesDir, MEDIUM_TERM_MEMORIES_FILENAME);
  writeFileSync(filePath, JSON.stringify(memories, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Medium-Term Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search medium-term memories by keyword relevance.
 * Used during core memory synthesis to find supporting context.
 */
export function searchMediumTermMemories(
  memories: MediumTermMemoryEntry[],
  query: string,
  limit: number = 10,
): MediumTermMemoryEntry[] {
  const queryWords = query.toLowerCase().split(/\s+/);

  const scored = memories.map((m) => {
    const contentLower = m.content.toLowerCase();
    const matchCount = queryWords.filter((w) => contentLower.includes(w)).length;
    const score = matchCount / queryWords.length;
    return { memory: m, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.memory);
}
