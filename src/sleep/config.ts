/**
 * Sleep system configuration resolution.
 */

import type { OpenClawConfig } from "../config/config.js";
import type {
  SleepDeepConfig,
  SleepLlmReflectionConfig,
  SleepShallowConfig,
} from "../config/types.agent-defaults.js";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SLEEP_WINDOW = "03:00-06:00";
export const DEFAULT_MIN_IDLE_MINUTES = 45;
export const DEFAULT_ALLOW_INTERRUPT = true;
export const DEFAULT_REPORT_LEVEL = "summary" as const;

// Shallow sleep defaults
export const DEFAULT_SHALLOW_ENABLED = true;
export const DEFAULT_TASKS_ENABLED = true;
export const DEFAULT_TASKS_CONFIG_VALIDATION = true;
export const DEFAULT_TASKS_CREDENTIALS_CHECK = true;
export const DEFAULT_TASKS_INTEGRATION_PROBE = true;
export const DEFAULT_TASKS_MEMORY_INTEGRITY = true;
export const DEFAULT_TASKS_API_KEY_VALIDATION = true;
export const DEFAULT_TASKS_DOCTOR_INTEGRATION = true;

export const DEFAULT_UPDATES_ENABLED = true;
export const DEFAULT_UPDATES_CHECK_OPENCLAW = true;
export const DEFAULT_UPDATES_CHECK_DEPENDENCIES = true;
export const DEFAULT_UPDATES_CHECK_TOOLS = true;
export const DEFAULT_UPDATES_CHECK_SYSTEM_DEPENDENCIES = true;
export const DEFAULT_UPDATES_CHECK_PACKAGE_MANAGER = true;
export const DEFAULT_UPDATES_AUTO_UPDATE = false; // Never auto-update

export const DEFAULT_SECURITY_ENABLED = true;
export const DEFAULT_SECURITY_NPM_AUDIT = true;
export const DEFAULT_SECURITY_CREDENTIAL_SCAN = true;
export const DEFAULT_SECURITY_ADVISORY_CHECK = true;
export const DEFAULT_SECURITY_TLS_CHECK = true;

export const DEFAULT_RADAR_ENABLED = true;
export const DEFAULT_RADAR_NEW_MODELS = true;
export const DEFAULT_RADAR_PROTOCOL_UPDATES = true;
export const DEFAULT_RADAR_BREAKING_CHANGES = true;

// Deep sleep defaults
export const DEFAULT_DEEP_ENABLED = true;
export const DEFAULT_MEMORY_PRUNING_ENABLED = true;
export const DEFAULT_MEMORY_PRUNING_MAX_AGE_HOURS = 168; // 7 days
export const DEFAULT_MEMORY_PRUNING_DECAY_FACTOR = 0.1;
export const DEFAULT_MEMORY_PRUNING_GRACE_PERIOD_HOURS = 24; // Min age before pruning
export const DEFAULT_MEMORY_PRUNING_MAX_PERCENT_PER_CYCLE = 20; // Max 20% pruned per cycle
export const DEFAULT_MEMORY_PRUNING_FUZZINESS = 0.1; // 10% variance

export const DEFAULT_MEMORY_COMPACTION_ENABLED = true;
export const DEFAULT_MEMORY_COMPACTION_MIN_CHUNKS = 100;

export const DEFAULT_CORE_MEMORY_ENABLED = true;
export const DEFAULT_CORE_MEMORY_MIN_RECURRENCE = 3;
export const DEFAULT_CORE_MEMORY_MIN_CONFIDENCE = 0.7;
export const DEFAULT_CORE_MEMORY_MAX_PER_CYCLE = 5;

// Medium-term memory promotion defaults
export const DEFAULT_MEMORY_PROMOTION_ENABLED = true;
export const DEFAULT_MEMORY_PROMOTION_MIN_REINFORCEMENTS = 3;
export const DEFAULT_MEMORY_PROMOTION_MIN_CONFIDENCE = 0.7;
export const DEFAULT_MEMORY_PROMOTION_MIN_AGE_HOURS = 48; // 2 days before promotion
export const DEFAULT_MEMORY_PROMOTION_MAX_PERCENT_PER_CYCLE = 30; // Max 30% promoted per cycle
export const DEFAULT_MEMORY_PROMOTION_FUZZINESS = 0.1; // 10% variance

// LLM reflection defaults
export const DEFAULT_LLM_REFLECTION_ENABLED = true;
export const DEFAULT_LLM_REFLECTION_PROVIDER = "anthropic";
export const DEFAULT_LLM_REFLECTION_MODEL = "claude-opus-4-5";
export const DEFAULT_LLM_REFLECTION_BATCH_SIZE = 20;
export const DEFAULT_LLM_REFLECTION_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_REFLECTION_PRUNE_THRESHOLD = 0.7;
export const DEFAULT_LLM_REFLECTION_PROMOTE_THRESHOLD = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Resolved Types
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedSleepShallowConfig = {
  enabled: boolean;
  tasks: {
    enabled: boolean;
    configValidation: boolean;
    credentialsCheck: boolean;
    integrationProbe: boolean;
    memoryIntegrity: boolean;
    apiKeyValidation: boolean;
    doctorIntegration: boolean;
  };
  updates: {
    enabled: boolean;
    checkOpenclaw: boolean;
    checkDependencies: boolean;
    checkTools: boolean;
    checkSystemDependencies: boolean;
    checkPackageManager: boolean;
    autoUpdate: boolean;
  };
  security: {
    enabled: boolean;
    npmAudit: boolean;
    credentialScan: boolean;
    credentialLeakScan: boolean;
    advisoryCheck: boolean;
    tlsCheck: boolean;
  };
  radar: {
    enabled: boolean;
    newModels: boolean;
    protocolUpdates: boolean;
    breakingChanges: boolean;
    sources: string[];
  };
};

export type ResolvedSleepDeepConfig = {
  enabled: boolean;
  memoryPruning: {
    enabled: boolean;
    maxAgeHours: number;
    decayFactor: number;
    gracePeriodHours: number;
    maxPrunePercentPerCycle: number;
    fuzziness: number;
  };
  memoryCompaction: {
    enabled: boolean;
    minChunks: number;
  };
  memoryPromotion: {
    enabled: boolean;
    minReinforcementsForLongTerm: number;
    minConfidenceForLongTerm: number;
    minAgeHoursForPromotion: number;
    maxPromotePercentPerCycle: number;
    fuzziness: number;
  };
  coreMemory: {
    enabled: boolean;
    minRecurrence: number;
    minConfidence: number;
    maxPerCycle: number;
  };
  llmReflection: {
    enabled: boolean;
    provider: string;
    model: string;
    batchSize: number;
    timeoutMs: number;
    pruneConfidenceThreshold: number;
    promoteRelevanceThreshold: number;
  };
};

export type ResolvedSleepConfig = {
  enabled: boolean;
  window: string;
  windowStart: { hour: number; minute: number };
  windowEnd: { hour: number; minute: number };
  minIdleMinutes: number;
  allowInterrupt: boolean;
  reportLevel: "summary" | "full";
  timezone: string;
  shallow: ResolvedSleepShallowConfig;
  deep: ResolvedSleepDeepConfig;
};

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;

function parseTimeWindow(window: string): {
  start: { hour: number; minute: number };
  end: { hour: number; minute: number };
} | null {
  const parts = window.split("-");
  if (parts.length !== 2) {
    return null;
  }

  const startMatch = parts[0]?.trim().match(TIME_PATTERN);
  const endMatch = parts[1]?.trim().match(TIME_PATTERN);

  if (!startMatch || !endMatch) {
    return null;
  }

  return {
    start: { hour: parseInt(startMatch[1] ?? "0", 10), minute: parseInt(startMatch[2] ?? "0", 10) },
    end: { hour: parseInt(endMatch[1] ?? "0", 10), minute: parseInt(endMatch[2] ?? "0", 10) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Functions
// ─────────────────────────────────────────────────────────────────────────────

function resolveShallowConfig(cfg?: SleepShallowConfig): ResolvedSleepShallowConfig {
  return {
    enabled: cfg?.enabled ?? DEFAULT_SHALLOW_ENABLED,
    tasks: {
      enabled: cfg?.tasks?.enabled ?? DEFAULT_TASKS_ENABLED,
      configValidation: cfg?.tasks?.configValidation ?? DEFAULT_TASKS_CONFIG_VALIDATION,
      credentialsCheck: cfg?.tasks?.credentialsCheck ?? DEFAULT_TASKS_CREDENTIALS_CHECK,
      integrationProbe: cfg?.tasks?.integrationProbe ?? DEFAULT_TASKS_INTEGRATION_PROBE,
      memoryIntegrity: cfg?.tasks?.memoryIntegrity ?? DEFAULT_TASKS_MEMORY_INTEGRITY,
      apiKeyValidation: cfg?.tasks?.apiKeyValidation ?? DEFAULT_TASKS_API_KEY_VALIDATION,
      doctorIntegration: cfg?.tasks?.doctorIntegration ?? DEFAULT_TASKS_DOCTOR_INTEGRATION,
    },
    updates: {
      enabled: cfg?.updates?.enabled ?? DEFAULT_UPDATES_ENABLED,
      checkOpenclaw: cfg?.updates?.checkOpenclaw ?? DEFAULT_UPDATES_CHECK_OPENCLAW,
      checkDependencies: cfg?.updates?.checkDependencies ?? DEFAULT_UPDATES_CHECK_DEPENDENCIES,
      checkTools: cfg?.updates?.checkTools ?? DEFAULT_UPDATES_CHECK_TOOLS,
      checkSystemDependencies:
        cfg?.updates?.checkSystemDependencies ?? DEFAULT_UPDATES_CHECK_SYSTEM_DEPENDENCIES,
      checkPackageManager:
        cfg?.updates?.checkPackageManager ?? DEFAULT_UPDATES_CHECK_PACKAGE_MANAGER,
      autoUpdate: cfg?.updates?.autoUpdate ?? DEFAULT_UPDATES_AUTO_UPDATE,
    },
    security: {
      enabled: cfg?.security?.enabled ?? DEFAULT_SECURITY_ENABLED,
      npmAudit: cfg?.security?.npmAudit ?? DEFAULT_SECURITY_NPM_AUDIT,
      credentialScan: cfg?.security?.credentialScan ?? DEFAULT_SECURITY_CREDENTIAL_SCAN,
      credentialLeakScan: cfg?.security?.credentialLeakScan ?? DEFAULT_SECURITY_CREDENTIAL_SCAN,
      advisoryCheck: cfg?.security?.advisoryCheck ?? DEFAULT_SECURITY_ADVISORY_CHECK,
      tlsCheck: cfg?.security?.tlsCheck ?? DEFAULT_SECURITY_TLS_CHECK,
    },
    radar: {
      enabled: cfg?.radar?.enabled ?? DEFAULT_RADAR_ENABLED,
      newModels: cfg?.radar?.newModels ?? DEFAULT_RADAR_NEW_MODELS,
      protocolUpdates: cfg?.radar?.protocolUpdates ?? DEFAULT_RADAR_PROTOCOL_UPDATES,
      breakingChanges: cfg?.radar?.breakingChanges ?? DEFAULT_RADAR_BREAKING_CHANGES,
      sources: cfg?.radar?.sources ?? [],
    },
  };
}

function resolveLlmReflectionConfig(
  cfg?: SleepLlmReflectionConfig,
): ResolvedSleepDeepConfig["llmReflection"] {
  return {
    enabled: cfg?.enabled ?? DEFAULT_LLM_REFLECTION_ENABLED,
    provider: cfg?.provider ?? DEFAULT_LLM_REFLECTION_PROVIDER,
    model: cfg?.model ?? DEFAULT_LLM_REFLECTION_MODEL,
    batchSize: cfg?.batchSize ?? DEFAULT_LLM_REFLECTION_BATCH_SIZE,
    timeoutMs: cfg?.timeoutMs ?? DEFAULT_LLM_REFLECTION_TIMEOUT_MS,
    pruneConfidenceThreshold:
      cfg?.pruneConfidenceThreshold ?? DEFAULT_LLM_REFLECTION_PRUNE_THRESHOLD,
    promoteRelevanceThreshold:
      cfg?.promoteRelevanceThreshold ?? DEFAULT_LLM_REFLECTION_PROMOTE_THRESHOLD,
  };
}

function resolveDeepConfig(cfg?: SleepDeepConfig): ResolvedSleepDeepConfig {
  return {
    enabled: cfg?.enabled ?? DEFAULT_DEEP_ENABLED,
    memoryPruning: {
      enabled: cfg?.memoryPruning?.enabled ?? DEFAULT_MEMORY_PRUNING_ENABLED,
      maxAgeHours: cfg?.memoryPruning?.maxAgeHours ?? DEFAULT_MEMORY_PRUNING_MAX_AGE_HOURS,
      decayFactor: cfg?.memoryPruning?.decayFactor ?? DEFAULT_MEMORY_PRUNING_DECAY_FACTOR,
      gracePeriodHours:
        cfg?.memoryPruning?.gracePeriodHours ?? DEFAULT_MEMORY_PRUNING_GRACE_PERIOD_HOURS,
      maxPrunePercentPerCycle:
        cfg?.memoryPruning?.maxPrunePercentPerCycle ?? DEFAULT_MEMORY_PRUNING_MAX_PERCENT_PER_CYCLE,
      fuzziness: cfg?.memoryPruning?.fuzziness ?? DEFAULT_MEMORY_PRUNING_FUZZINESS,
    },
    memoryCompaction: {
      enabled: cfg?.memoryCompaction?.enabled ?? DEFAULT_MEMORY_COMPACTION_ENABLED,
      minChunks: cfg?.memoryCompaction?.minChunks ?? DEFAULT_MEMORY_COMPACTION_MIN_CHUNKS,
    },
    memoryPromotion: {
      enabled: cfg?.memoryPromotion?.enabled ?? DEFAULT_MEMORY_PROMOTION_ENABLED,
      minReinforcementsForLongTerm:
        cfg?.memoryPromotion?.minReinforcementsForLongTerm ??
        DEFAULT_MEMORY_PROMOTION_MIN_REINFORCEMENTS,
      minConfidenceForLongTerm:
        cfg?.memoryPromotion?.minConfidenceForLongTerm ?? DEFAULT_MEMORY_PROMOTION_MIN_CONFIDENCE,
      minAgeHoursForPromotion:
        cfg?.memoryPromotion?.minAgeHoursForPromotion ?? DEFAULT_MEMORY_PROMOTION_MIN_AGE_HOURS,
      maxPromotePercentPerCycle:
        cfg?.memoryPromotion?.maxPromotePercentPerCycle ??
        DEFAULT_MEMORY_PROMOTION_MAX_PERCENT_PER_CYCLE,
      fuzziness: cfg?.memoryPromotion?.fuzziness ?? DEFAULT_MEMORY_PROMOTION_FUZZINESS,
    },
    coreMemory: {
      enabled: cfg?.coreMemory?.enabled ?? DEFAULT_CORE_MEMORY_ENABLED,
      minRecurrence: cfg?.coreMemory?.minRecurrence ?? DEFAULT_CORE_MEMORY_MIN_RECURRENCE,
      minConfidence: cfg?.coreMemory?.minConfidence ?? DEFAULT_CORE_MEMORY_MIN_CONFIDENCE,
      maxPerCycle: cfg?.coreMemory?.maxPerCycle ?? DEFAULT_CORE_MEMORY_MAX_PER_CYCLE,
    },
    llmReflection: resolveLlmReflectionConfig(cfg?.llmReflection),
  };
}

export function resolveSleepConfig(cfg?: OpenClawConfig): ResolvedSleepConfig | null {
  const sleepCfg = cfg?.agents?.defaults?.sleep;
  if (!sleepCfg?.enabled) {
    return null;
  }

  const window = sleepCfg.window ?? DEFAULT_SLEEP_WINDOW;
  const parsed = parseTimeWindow(window);
  if (!parsed) {
    return null;
  }

  return {
    enabled: true,
    window,
    windowStart: parsed.start,
    windowEnd: parsed.end,
    minIdleMinutes: sleepCfg.minIdleMinutes ?? DEFAULT_MIN_IDLE_MINUTES,
    allowInterrupt: sleepCfg.allowInterrupt ?? DEFAULT_ALLOW_INTERRUPT,
    reportLevel: sleepCfg.reportLevel ?? DEFAULT_REPORT_LEVEL,
    timezone: sleepCfg.timezone ?? "user",
    shallow: resolveShallowConfig(sleepCfg.shallow),
    deep: resolveDeepConfig(sleepCfg.deep),
  };
}

export function isSleepEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.sleep?.enabled === true;
}
