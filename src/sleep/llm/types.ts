/**
 * Types for LLM-based memory reflection during sleep.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Memory Types (aligned with existing memory tiers)
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryTier = "short" | "medium" | "long" | "core";

export type MemoryTheme =
  | "user_preference"
  | "user_values"
  | "behavioral_pattern"
  | "relationship"
  | "expertise"
  | "goal"
  | "constraint";

export type MemoryCandidate = {
  id: string;
  content: string;
  tier: MemoryTier;
  timestamp: number;
  accessCount?: number;
  confidence?: number;
  tags?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Identity Context (loaded from workspace)
// ─────────────────────────────────────────────────────────────────────────────

export type CoreMemoryEntry = {
  id: string;
  theme: MemoryTheme;
  description: string;
  /** Why this is a core memory - concise explanation of its significance. */
  reason?: string;
  confidence: number;
  supportingMemoryIds: string[];
  createdAt: number;
  reinforcedAt?: number;
  reinforcementCount?: number;
};

export type LongTermMemoryEntry = {
  id: string;
  content: string;
  /** Why this is in long-term memory - concise explanation of its importance. */
  reason?: string;
  confidence: number;
  createdAt: number;
  accessCount: number;
  tags?: string[];
};

export type MediumTermMemoryEntry = {
  id: string;
  content: string;
  confidence: number;
  createdAt: number;
  accessCount: number;
  reinforcementCount: number;
  tags?: string[];
};

export type IdentityContext = {
  /** Content of SOUL.md */
  soul?: string;
  /** Content of IDENTITY.md */
  identity?: string;
  /** Existing core memories (always loaded) */
  coreMemories: CoreMemoryEntry[];
  /** Existing long-term memories (always loaded) */
  longTermMemories: LongTermMemoryEntry[];
  /** Medium-term memories (available for search) */
  mediumTermMemories: MediumTermMemoryEntry[];
};

// ─────────────────────────────────────────────────────────────────────────────
// LLM Reflection Results
// ─────────────────────────────────────────────────────────────────────────────

export type PruneDecision = "keep" | "prune";

export type PruneReflectionResult = {
  id: string;
  decision: PruneDecision;
  reason: string;
  confidence?: number;
};

export type PromotionReflectionResult = {
  id: string;
  relevance: number; // 0-1
  reason: string;
  suggestedTier?: MemoryTier;
};

export type CoreMemorySynthesisResult = {
  theme: MemoryTheme;
  description: string;
  /** Why this is a core memory - what makes it significant. */
  reason?: string;
  confidence: number;
  supportingMemoryIds: string[];
  reinforcesExisting?: string; // ID of existing core memory this reinforces
};

export type ReflectionOperation = "prune" | "promote" | "core-extract";

export type ReflectionResult =
  | { operation: "prune"; results: PruneReflectionResult[] }
  | { operation: "promote"; results: PromotionReflectionResult[] }
  | { operation: "core-extract"; results: CoreMemorySynthesisResult[] };

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type SleepLlmReflectionConfig = {
  /** Enable LLM-based memory reflection (default: true). */
  enabled?: boolean;
  /** LLM provider (default: "anthropic"). */
  provider?: string;
  /** Model to use (default: "claude-opus-4-5"). */
  model?: string;
  /** Memories per LLM call (default: 20). */
  batchSize?: number;
  /** Timeout per LLM call in ms (default: 60000). */
  timeoutMs?: number;
  /** Confidence threshold for pruning (default: 0.7). */
  pruneConfidenceThreshold?: number;
  /** Relevance threshold for promotion (default: 0.5). */
  promoteRelevanceThreshold?: number;
};

export type ResolvedLlmReflectionConfig = {
  enabled: boolean;
  provider: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  pruneConfidenceThreshold: number;
  promoteRelevanceThreshold: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// LLM Reflection Call Parameters
// ─────────────────────────────────────────────────────────────────────────────

export type ReflectionParams = {
  memories: MemoryCandidate[];
  identityContext: IdentityContext;
  operation: ReflectionOperation;
  config: ResolvedLlmReflectionConfig;
  signal?: AbortSignal;
  /** Optional: workspace directory for loading additional context. */
  workspaceDir?: string;
};

export type ReflectionLogEntry = {
  operation: ReflectionOperation;
  memoryCount: number;
  decisions: Array<{ id: string; outcome: string; reason: string }>;
  durationMs: number;
  model: string;
  error?: string;
};
