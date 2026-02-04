/**
 * Prompt templates for LLM-based memory reflection.
 *
 * Each prompt includes the agent's identity context (SOUL.md, IDENTITY.md)
 * plus existing core and long-term memories for full awareness.
 */

import type {
  CoreMemoryEntry,
  IdentityContext,
  LongTermMemoryEntry,
  MediumTermMemoryEntry,
  MemoryCandidate,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatCoreMemories(memories: CoreMemoryEntry[]): string {
  if (memories.length === 0) {
    return "(none yet)";
  }
  return memories
    .map((m) => `- [${m.id}] ${m.theme}: ${m.description} (confidence: ${m.confidence.toFixed(2)})`)
    .join("\n");
}

function formatLongTermMemories(memories: LongTermMemoryEntry[]): string {
  if (memories.length === 0) {
    return "(none yet)";
  }
  return memories
    .map((m) => `- [${m.id}] ${m.content} (confidence: ${m.confidence.toFixed(2)})`)
    .join("\n");
}

function formatMediumTermMemories(memories: MediumTermMemoryEntry[]): string {
  if (memories.length === 0) {
    return "(none available)";
  }
  return memories.map((m) => `- [${m.id}] ${m.content}`).join("\n");
}

function formatMemoryCandidates(memories: MemoryCandidate[]): string {
  return memories
    .map(
      (m) =>
        `- [${m.id}] ${m.content}${m.accessCount !== undefined ? ` (accessed ${m.accessCount}x)` : ""}`,
    )
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pruning Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildPrunePrompt(memories: MemoryCandidate[], ctx: IdentityContext): string {
  return `You are evaluating memories for an AI agent. Use the agent's identity and existing memories to decide what to keep.

<soul>
${ctx.soul ?? "(No SOUL.md defined)"}
</soul>

<identity>
${ctx.identity ?? "(No IDENTITY.md defined)"}
</identity>

<core_memories>
${formatCoreMemories(ctx.coreMemories)}
</core_memories>

<long_term_memories>
${formatLongTermMemories(ctx.longTermMemories)}
</long_term_memories>

These short-term memories are candidates for pruning (deletion). For each memory, decide:
- KEEP: This memory aligns with the agent's identity, reinforces existing memories, or adds new value
- PRUNE: This memory is redundant, contradicts identity, or is not relevant to who this agent is

Be conservative - when in doubt, KEEP the memory. Only prune memories that are clearly:
- Redundant with existing long-term or core memories
- Contradictory to the agent's stated values
- Trivial or ephemeral with no lasting significance

<memories_to_evaluate>
${formatMemoryCandidates(memories)}
</memories_to_evaluate>

Respond with a JSON array only, no additional text:
[{ "id": "...", "decision": "keep" | "prune", "reason": "brief explanation" }]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotion Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildPromotePrompt(memories: MemoryCandidate[], ctx: IdentityContext): string {
  return `You are evaluating memories for promotion to long-term storage.

<soul>
${ctx.soul ?? "(No SOUL.md defined)"}
</soul>

<identity>
${ctx.identity ?? "(No IDENTITY.md defined)"}
</identity>

<core_memories>
${formatCoreMemories(ctx.coreMemories)}
</core_memories>

<long_term_memories>
${formatLongTermMemories(ctx.longTermMemories)}
</long_term_memories>

Rate each memory's relevance to this agent's core identity on a scale of 0-1:
- 0.0-0.3: Not relevant, or redundant with existing long-term memories
- 0.4-0.6: Somewhat relevant, adds nuance to existing knowledge
- 0.7-1.0: Highly relevant, defines this agent's character, fills a gap

Memories that reinforce or expand upon existing core/long-term memories should score higher.
Memories that are redundant (already captured) should score lower.

<memories_to_evaluate>
${formatMemoryCandidates(memories)}
</memories_to_evaluate>

Respond with a JSON array only, no additional text:
[{ "id": "...", "relevance": 0.0-1.0, "reason": "brief explanation" }]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Memory Synthesis Prompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildCoreSynthesisPrompt(
  longTermMemories: LongTermMemoryEntry[],
  mediumTermContext: MediumTermMemoryEntry[],
  ctx: IdentityContext,
): string {
  return `You are synthesizing core memories - identity-shaping patterns that define this agent.

<soul>
${ctx.soul ?? "(No SOUL.md defined)"}
</soul>

<identity>
${ctx.identity ?? "(No IDENTITY.md defined)"}
</identity>

<existing_core_memories>
${formatCoreMemories(ctx.coreMemories)}
</existing_core_memories>

<long_term_memories>
${formatLongTermMemories(longTermMemories)}
</long_term_memories>

<relevant_medium_term>
${formatMediumTermMemories(mediumTermContext)}
</relevant_medium_term>

Identify 0-3 NEW or REINFORCED core patterns that:
1. Align with the agent's stated identity and values in SOUL.md
2. Are reinforced across multiple memories (long-term and medium-term)
3. Should influence this agent's future behavior
4. Are NOT redundant with existing core memories (unless explicitly reinforcing them)

Valid themes: "user_preference", "user_values", "behavioral_pattern", "relationship", "expertise", "goal", "constraint"

If no new patterns emerge, return an empty array.
If a pattern reinforces an existing core memory, include "reinforcesExisting" with that memory's ID.

Respond with a JSON array only, no additional text:
[{
  "theme": "user_preference" | "user_values" | "behavioral_pattern" | "relationship" | "expertise" | "goal" | "constraint",
  "description": "concise description of the pattern",
  "reason": "why this matters - what makes it core to identity (1 sentence)",
  "confidence": 0.0-1.0,
  "supportingMemoryIds": ["id1", "id2", ...],
  "reinforcesExisting": "existing_core_id" | null
}]`;
}
