/**
 * LLM-based memory reflection for sleep operations.
 */

export {
  // Types
  type CoreMemoryEntry,
  type CoreMemorySynthesisResult,
  type IdentityContext,
  type LongTermMemoryEntry,
  type MediumTermMemoryEntry,
  type MemoryCandidate,
  type MemoryTheme,
  type MemoryTier,
  type PromotionReflectionResult,
  type PruneReflectionResult,
  type ReflectionLogEntry,
  type ReflectionOperation,
  type ReflectionResult,
  type ResolvedLlmReflectionConfig,
  type SleepLlmReflectionConfig,
} from "./types.js";

export {
  // Identity context
  loadIdentityContext,
  loadCoreMemoriesFromWorkspace,
  loadLongTermMemoriesFromWorkspace,
  loadMediumTermMemoriesFromAgent,
  saveCoreMemoriesToWorkspace,
  saveLongTermMemoriesToWorkspace,
  saveMediumTermMemoriesToAgent,
  searchMediumTermMemories,
  parseCoreMemoriesMarkdown,
  parseLongTermMemoriesMarkdown,
  CORE_MEMORIES_FILENAME,
  LONG_TERM_MEMORIES_FILENAME,
  MEDIUM_TERM_MEMORIES_FILENAME,
} from "./identity-context.js";

export {
  // Prompts
  buildPrunePrompt,
  buildPromotePrompt,
  buildCoreSynthesisPrompt,
} from "./prompts.js";

export {
  // Reflection
  reflectOnPruning,
  reflectOnPromotion,
  synthesizeCoreMemories,
  prepareReflectionContext,
  resolveLlmReflectionConfig,
  isLlmReflectionEnabled,
  DEFAULT_LLM_REFLECTION_ENABLED,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_BATCH_SIZE,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_PRUNE_CONFIDENCE_THRESHOLD,
  DEFAULT_PROMOTE_RELEVANCE_THRESHOLD,
  type ReflectionContext,
} from "./reflection.js";
