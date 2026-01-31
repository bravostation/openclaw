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
export const LONG_TERM_MEMORIES_FILENAME = "MEMORIES-LONG.md";
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
 * Load core memories from workspace MEMORIES-CORE.md file.
 */
export function loadCoreMemoriesFromWorkspace(workspaceDir: string): CoreMemoryEntry[] {
  const filePath = path.join(workspaceDir, CORE_MEMORIES_FILENAME);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return parseCoreMemoriesMarkdown(content);
  } catch {
    return [];
  }
}

/**
 * Load long-term memories from workspace MEMORIES-LONG.md file.
 */
export function loadLongTermMemoriesFromWorkspace(workspaceDir: string): LongTermMemoryEntry[] {
  const filePath = path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
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
 * Format a core memory entry as markdown section.
 */
function formatCoreMemorySection(memory: CoreMemoryEntry): string {
  const lines = [
    `## ${memory.description.slice(0, 50)}${memory.description.length > 50 ? "..." : ""}`,
    `- **ID**: ${memory.id}`,
    `- **Theme**: ${memory.theme}`,
    `- **Confidence**: ${memory.confidence.toFixed(2)}`,
    `- **Description**: ${memory.description}`,
    `- **Supporting memories**: [${memory.supportingMemoryIds.join(", ")}]`,
    `- **Created**: ${memory.createdAt}`,
  ];
  if (memory.reinforcedAt) {
    lines.push(`- **Reinforced**: ${memory.reinforcedAt}`);
  }
  if (memory.reinforcementCount !== undefined) {
    lines.push(`- **Reinforcement count**: ${memory.reinforcementCount}`);
  }
  return lines.join("\n");
}

/**
 * Format a long-term memory entry as markdown section.
 */
function formatLongTermMemorySection(memory: LongTermMemoryEntry): string {
  const lines = [
    `## ${memory.content.slice(0, 50)}${memory.content.length > 50 ? "..." : ""}`,
    `- **ID**: ${memory.id}`,
    `- **Content**: ${memory.content}`,
    `- **Confidence**: ${memory.confidence.toFixed(2)}`,
    `- **Access count**: ${memory.accessCount}`,
    `- **Created**: ${memory.createdAt}`,
  ];
  if (memory.tags?.length) {
    lines.push(`- **Tags**: [${memory.tags.join(", ")}]`);
  }
  return lines.join("\n");
}

/**
 * Save core memories to workspace MEMORIES-CORE.md file.
 */
export function saveCoreMemoriesToWorkspace(
  workspaceDir: string,
  memories: CoreMemoryEntry[],
): void {
  const filePath = path.join(workspaceDir, CORE_MEMORIES_FILENAME);

  const header = `# Core Memories

These are identity-shaping patterns that define this agent's character.
They are loaded into every conversation and influence behavior.

---

`;

  const content = header + memories.map((m) => formatCoreMemorySection(m)).join("\n\n");
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Save long-term memories to workspace MEMORIES-LONG.md file.
 */
export function saveLongTermMemoriesToWorkspace(
  workspaceDir: string,
  memories: LongTermMemoryEntry[],
): void {
  const filePath = path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME);

  const header = `# Long-Term Memories

Stable facts, preferences, and knowledge about the user.
These are loaded into every conversation alongside core memories.

---

`;

  const content = header + memories.map((m) => formatLongTermMemorySection(m)).join("\n\n");
  writeFileSync(filePath, content, "utf-8");
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
