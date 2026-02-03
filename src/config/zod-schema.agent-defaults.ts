import { z } from "zod";
import {
  HeartbeatSchema,
  MemorySearchSchema,
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
} from "./zod-schema.core.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sleep System Schemas
// ─────────────────────────────────────────────────────────────────────────────

const SleepShallowTasksSchema = z
  .object({
    configValidation: z.boolean().optional(),
    credentialsCheck: z.boolean().optional(),
    integrationProbe: z.boolean().optional(),
    memoryIntegrity: z.boolean().optional(),
  })
  .strict()
  .optional();

const SleepUpdatesSchema = z
  .object({
    enabled: z.boolean().optional(),
    checkOpenclaw: z.boolean().optional(),
    checkDependencies: z.boolean().optional(),
    checkTools: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
  })
  .strict()
  .optional();

const SleepSecuritySchema = z
  .object({
    enabled: z.boolean().optional(),
    npmAudit: z.boolean().optional(),
    credentialScan: z.boolean().optional(),
    advisoryCheck: z.boolean().optional(),
    tlsCheck: z.boolean().optional(),
  })
  .strict()
  .optional();

const SleepRadarSchema = z
  .object({
    enabled: z.boolean().optional(),
    newModels: z.boolean().optional(),
    protocolUpdates: z.boolean().optional(),
    breakingChanges: z.boolean().optional(),
    sources: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const SleepShallowSchema = z
  .object({
    enabled: z.boolean().optional(),
    tasks: SleepShallowTasksSchema,
    updates: SleepUpdatesSchema,
    security: SleepSecuritySchema,
    radar: SleepRadarSchema,
  })
  .strict()
  .optional();

const SleepMemoryPruningSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAgeHours: z.number().int().positive().optional(),
    decayFactor: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

const SleepMemoryCompactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    minChunks: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const SleepCoreMemorySchema = z
  .object({
    enabled: z.boolean().optional(),
    minRecurrence: z.number().int().positive().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

const SleepMemoryPromotionSchema = z
  .object({
    enabled: z.boolean().optional(),
    minReinforcementsForLongTerm: z.number().int().positive().optional(),
    minConfidenceForLongTerm: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

const SleepLlmReflectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    batchSize: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    pruneConfidenceThreshold: z.number().min(0).max(1).optional(),
    promoteRelevanceThreshold: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

const SleepDeepSchema = z
  .object({
    enabled: z.boolean().optional(),
    memoryPruning: SleepMemoryPruningSchema,
    memoryCompaction: SleepMemoryCompactionSchema,
    memoryPromotion: SleepMemoryPromotionSchema,
    coreMemory: SleepCoreMemorySchema,
    llmReflection: SleepLlmReflectionSchema,
  })
  .strict()
  .optional();

export const SleepSchema = z
  .object({
    enabled: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
    window: z.string().optional(),
    minIdleMinutes: z.number().int().positive().optional(),
    allowInterrupt: z.boolean().optional(),
    reportLevel: z.union([z.literal("summary"), z.literal("full")]).optional(),
    timezone: z.string().optional(),
    shallow: SleepShallowSchema,
    deep: SleepDeepSchema,
  })
  .strict()
  .optional();

// ─────────────────────────────────────────────────────────────────────────────
// Agent Defaults Schema
// ─────────────────────────────────────────────────────────────────────────────

export const AgentDefaultsSchema = z
  .object({
    model: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    imageModel: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
            params: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .optional(),
    workspace: z.string().optional(),
    repoRoot: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    userTimezone: z.string().optional(),
    timeFormat: z.union([z.literal("auto"), z.literal("12"), z.literal("24")]).optional(),
    envelopeTimezone: z.string().optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    contextPruning: z
      .object({
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        ttl: z.string().optional(),
        keepLastAssistants: z.number().int().nonnegative().optional(),
        softTrimRatio: z.number().min(0).max(1).optional(),
        hardClearRatio: z.number().min(0).max(1).optional(),
        minPrunableToolChars: z.number().int().nonnegative().optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        softTrim: z
          .object({
            maxChars: z.number().int().nonnegative().optional(),
            headChars: z.number().int().nonnegative().optional(),
            tailChars: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional(),
        maxHistoryShare: z.number().min(0.1).max(0.9).optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            prompt: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    heartbeat: HeartbeatSchema,
    sleep: SleepSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
        workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
        sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
        scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
        perSession: z.boolean().optional(),
        workspaceRoot: z.string().optional(),
        docker: SandboxDockerSchema,
        browser: SandboxBrowserSchema,
        prune: SandboxPruneSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
