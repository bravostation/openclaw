/**
 * OpenClaw Sleep System
 *
 * A scheduled, offline-first cognitive maintenance and memory consolidation process.
 *
 * The sleep system runs during periods of user inactivity to:
 * - Maintain system health (shallow sleep)
 * - Consolidate, compress, and prune memories (deep sleep)
 *
 * @example
 * ```typescript
 * import { runSleepCycle, getSleepStatus, wake } from "openclaw/sleep";
 *
 * // Check if sleep can run
 * const status = getSleepStatus();
 * console.log(`Sleep enabled: ${status.enabled}`);
 * console.log(`Currently sleeping: ${status.sleeping}`);
 *
 * // Trigger a sleep cycle
 * const result = await runSleepCycle({ force: true });
 * console.log(`Sleep ${result.status}: ${result.reportPath}`);
 *
 * // Wake from sleep early
 * wake();
 * ```
 */

// Configuration
export {
  resolveSleepConfig,
  isSleepEnabled,
  type ResolvedSleepConfig,
  type ResolvedSleepShallowConfig,
  type ResolvedSleepDeepConfig,
  // Defaults
  DEFAULT_SLEEP_WINDOW,
  DEFAULT_MIN_IDLE_MINUTES,
  DEFAULT_MEMORY_PRUNING_MAX_AGE_HOURS,
} from "./config.js";

// Scheduler
export {
  checkSleepEligibility,
  getSleepWindowInfo,
  recordUserActivity,
  setUserActive,
  createDefaultSchedulerDeps,
  type SleepEligibility,
  type SleepSchedulerDeps,
  type SleepWindowInfo,
} from "./scheduler.js";

// Manager
export {
  runSleepCycle,
  wake,
  notifyUserActivity,
  setUserActiveState,
  getSleepStatus,
  getLastSleepReport,
  formatSleepReport,
  type SleepCycleResult,
  type SleepManagerOptions,
  type SleepStatus,
} from "./manager.js";

// Phases
export {
  runShallowSleep,
  runDeepSleep,
  summarizeShallowSleep,
  summarizeDeepSleep,
  type ShallowSleepResult,
  type ShallowSleepOptions,
  type ShallowSleepSummary,
  type DeepSleepResult,
  type DeepSleepOptions,
  type DeepSleepSummary,
} from "./phases/index.js";

// Memory operations
export {
  pruneMemories,
  compactMemories,
  promoteMemories,
  extractCoreMemories,
  getCoreMemories,
  processMediumTermMemories,
  getMediumTermMemories,
  getLongTermMemories,
  searchMediumTermMemories,
  type PruneResult,
  type PruneOptions,
  type CompactResult,
  type CompactOptions,
  type PromoteResult,
  type PromoteOptions,
  type CoreMemory,
  type CoreMemoryTheme,
  type CoreMemoryResult,
  type CoreMemoryOptions,
  type MediumTermMemory,
  type MediumTermMemoryCategory,
  type LongTermMemory,
  type MediumTermResult,
  type MediumTermOptions,
} from "./memory/index.js";

// Reports
export {
  generateReport,
  formatReportMarkdown,
  saveReport,
  loadLatestReport,
  type SleepReport,
  type SleepReportOptions,
} from "./reports/index.js";

// Tasks (for extension/customization)
export {
  type ShallowSleepTask,
  type ShallowSleepTaskContext,
  type TaskResult,
  type TaskResultItem,
  type TaskSeverity,
  createTaskResult,
  createSkippedResult,
  okItem,
  infoItem,
  warningItem,
  errorItem,
  criticalItem,
} from "./tasks/types.js";

// LLM Reflection
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
  type ResolvedLlmReflectionConfig,
  type SleepLlmReflectionConfig,
  // Identity context
  loadIdentityContext,
  loadCoreMemoriesFromWorkspace,
  loadLongTermMemoriesFromWorkspace,
  saveCoreMemoriesToWorkspace,
  saveLongTermMemoriesToWorkspace,
  CORE_MEMORIES_FILENAME,
  LONG_TERM_MEMORIES_FILENAME,
  // Reflection
  reflectOnPruning,
  reflectOnPromotion,
  synthesizeCoreMemories,
  prepareReflectionContext,
  isLlmReflectionEnabled,
  type ReflectionContext,
} from "./llm/index.js";
