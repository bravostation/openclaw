import type { ChannelId } from "../channels/plugins/types.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { MemorySearchConfig } from "./types.tools.js";

export type AgentModelEntryConfig = {
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
};

export type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  mode?: "off" | "cache-ttl";
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */
  command: string;
  /** Base args applied to every invocation. */
  args?: string[];
  /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl";
  /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl";
  /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin";
  /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number;
  /** Extra env vars injected for this CLI. */
  env?: Record<string, string>;
  /** Env vars to remove before launching this CLI. */
  clearEnv?: string[];
  /** Flag used to pass model id (e.g. --model). */
  modelArg?: string;
  /** Model aliases mapping (config model id → CLI model id). */
  modelAliases?: Record<string, string>;
  /** Flag used to pass session id (e.g. --session-id). */
  sessionArg?: string;
  /** Extra args used when resuming a session (use {sessionId} placeholder). */
  sessionArgs?: string[];
  /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[];
  /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none";
  /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[];
  /** Flag used to pass system prompt. */
  systemPromptArg?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
};

export type AgentDefaultsConfig = {
  /** Primary model and fallbacks (provider/model). */
  model?: AgentModelListConfig;
  /** Optional image-capable model and fallbacks (provider/model). */
  imageModel?: AgentModelListConfig;
  /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>;
  /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string;
  /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string;
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /** Max chars for injected bootstrap files before truncation (default: 20000). */
  bootstrapMaxChars?: number;
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Time format in system prompt: auto (OS preference), 12-hour, or 24-hour. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Envelope timestamp timezone: "utc" (default), "local", "user", or an IANA timezone string.
   */
  envelopeTimezone?: string;
  /**
   * Include absolute timestamps in message envelopes ("on" | "off", default: "on").
   */
  envelopeTimestamp?: "on" | "off";
  /**
   * Include elapsed time in message envelopes ("on" | "off", default: "on").
   */
  envelopeElapsed?: "on" | "off";
  /** Optional context window cap (used for runtime estimates + status %). */
  contextTokens?: number;
  /** Optional CLI backends for text-only fallback (claude-cli, etc.). */
  cliBackends?: Record<string, CliBackendConfig>;
  /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig;
  /** Compaction tuning and pre-compaction memory flush behavior. */
  compaction?: AgentCompactionConfig;
  /** Vector memory search configuration (per-agent overrides supported). */
  memorySearch?: MemorySearchConfig;
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /** Default elevated level when no /elevated directive is present. */
  elevatedDefault?: "off" | "on" | "ask" | "full";
  /** Default block streaming level when no override is present. */
  blockStreamingDefault?: "off" | "on";
  /**
   * Block streaming boundary:
   * - "text_end": end of each assistant text content block (before tool calls)
   * - "message_end": end of the whole assistant message (may include tool blocks)
   */
  blockStreamingBreak?: "text_end" | "message_end";
  /** Soft block chunking for streamed replies (min/max chars, prefer paragraph/newline). */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /**
   * Block reply coalescing (merge streamed chunks before send).
   * idleMs: wait time before flushing when idle.
   */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Human-like delay between block replies. */
  humanDelay?: HumanDelayConfig;
  timeoutSeconds?: number;
  /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
  mediaMaxMb?: number;
  typingIntervalSeconds?: number;
  /** Typing indicator start mode (never|instant|thinking|message). */
  typingMode?: TypingMode;
  /** Periodic background heartbeat runs. */
  heartbeat?: {
    /** Heartbeat interval (duration string, default unit: minutes; default: 30m). */
    every?: string;
    /** Optional active-hours window (local time); heartbeats run only inside this window. */
    activeHours?: {
      /** Start time (24h, HH:MM). Inclusive. */
      start?: string;
      /** End time (24h, HH:MM). Exclusive. Use "24:00" for end-of-day. */
      end?: string;
      /** Timezone for the window ("user", "local", or IANA TZ id). Default: "user". */
      timezone?: string;
    };
    /** Heartbeat model override (provider/model). */
    model?: string;
    /** Session key for heartbeat runs ("main" or explicit session key). */
    session?: string;
    /** Delivery target ("last", "none", or a channel id). */
    target?: "last" | "none" | ChannelId;
    /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). */
    to?: string;
    /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."). */
    prompt?: string;
    /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number;
    /**
     * When enabled, deliver the model's reasoning payload for heartbeat runs (when available)
     * as a separate message prefixed with `Reasoning:` (same as `/reasoning on`).
     *
     * Default: false (only the final heartbeat payload is delivered).
     */
    includeReasoning?: boolean;
  };
  /** Sleep system for scheduled maintenance and memory consolidation. */
  sleep?: AgentSleepConfig;
  /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: {
    /** Enable sandboxing for sessions. */
    mode?: "off" | "non-main" | "all";
    /**
     * Agent workspace access inside the sandbox.
     * - "none": do not mount the agent workspace into the container; use a sandbox workspace under workspaceRoot
     * - "ro": mount the agent workspace read-only; disables write/edit tools
     * - "rw": mount the agent workspace read/write; enables write/edit tools
     */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    /** Root directory for sandbox workspaces. */
    workspaceRoot?: string;
    /** Docker-specific sandbox settings. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser settings. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune sandbox containers. */
    prune?: SandboxPruneSettings;
  };
};

export type AgentCompactionMode = "default" | "safeguard";

export type AgentCompactionConfig = {
  /** Compaction summarization mode. */
  mode?: AgentCompactionMode;
  /** Minimum reserve tokens enforced for Pi compaction (0 disables the floor). */
  reserveTokensFloor?: number;
  /** Max share of context window for history during safeguard pruning (0.1–0.9, default 0.5). */
  maxHistoryShare?: number;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
};

export type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */
  enabled?: boolean;
  /** Run the memory flush when context is within this many tokens of the compaction threshold. */
  softThresholdTokens?: number;
  /** User prompt used for the memory flush turn (NO_REPLY is enforced if missing). */
  prompt?: string;
  /** System prompt appended for the memory flush turn. */
  systemPrompt?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Sleep System Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type SleepShallowTasksConfig = {
  /** Validate config schema and integrity. */
  configValidation?: boolean;
  /** Check for expiring credentials/tokens. */
  credentialsCheck?: boolean;
  /** Probe channel integrations for connectivity. */
  integrationProbe?: boolean;
  /** Verify memory store integrity (SQLite checks). */
  memoryIntegrity?: boolean;
};

export type SleepUpdatesConfig = {
  /** Enable update checks during shallow sleep. */
  enabled?: boolean;
  /** Check for openclaw npm updates. */
  checkOpenclaw?: boolean;
  /** Check workspace dependencies for updates. */
  checkDependencies?: boolean;
  /** Check MCP servers and tools for updates. */
  checkTools?: boolean;
  /** Never auto-update; always advisory only. */
  autoUpdate?: boolean;
};

export type SleepSecurityConfig = {
  /** Enable security scanning during shallow sleep. */
  enabled?: boolean;
  /** Run npm audit on workspace. */
  npmAudit?: boolean;
  /** Scan for leaked credential patterns. */
  credentialScan?: boolean;
  /** Query GitHub Advisory Database for CVEs. */
  advisoryCheck?: boolean;
  /** Check TLS/certificate configurations. */
  tlsCheck?: boolean;
};

export type SleepRadarConfig = {
  /** Enable development radar during shallow sleep. */
  enabled?: boolean;
  /** Check for new AI model releases. */
  newModels?: boolean;
  /** Monitor MCP/API protocol updates. */
  protocolUpdates?: boolean;
  /** Watch for breaking changes in dependencies. */
  breakingChanges?: boolean;
  /** Custom RSS/API sources to monitor. */
  sources?: string[];
};

export type SleepShallowConfig = {
  /** Enable shallow sleep phase. */
  enabled?: boolean;
  /** Health check tasks. */
  tasks?: SleepShallowTasksConfig;
  /** Tool/dependency update checks. */
  updates?: SleepUpdatesConfig;
  /** Security scanning tasks. */
  security?: SleepSecurityConfig;
  /** Development radar tasks. */
  radar?: SleepRadarConfig;
};

export type SleepMemoryPruningConfig = {
  /** Enable memory pruning during deep sleep. */
  enabled?: boolean;
  /** Max age in hours for session chunks before pruning (default: 168 = 7 days). */
  maxAgeHours?: number;
  /** Decay factor for memory relevance (0-1, default: 0.1). */
  decayFactor?: number;
};

export type SleepMemoryCompactionConfig = {
  /** Enable memory compaction during deep sleep. */
  enabled?: boolean;
  /** Minimum chunks before compaction triggers (default: 100). */
  minChunks?: number;
};

export type SleepCoreMemoryConfig = {
  /** Enable core memory extraction during deep sleep. */
  enabled?: boolean;
  /** Minimum recurrence count for pattern detection (default: 3). */
  minRecurrence?: number;
  /** Minimum confidence threshold for core memory creation (0-1, default: 0.7). */
  minConfidence?: number;
};

export type SleepMemoryPromotionConfig = {
  /** Enable medium-term to long-term memory promotion (default: true). */
  enabled?: boolean;
  /** Minimum reinforcement count before promoting to long-term (default: 3). */
  minReinforcementsForLongTerm?: number;
  /** Minimum confidence threshold for long-term promotion (0-1, default: 0.7). */
  minConfidenceForLongTerm?: number;
};

export type SleepDeepConfig = {
  /** Enable deep sleep phase. */
  enabled?: boolean;
  /** Memory pruning settings. */
  memoryPruning?: SleepMemoryPruningConfig;
  /** Memory compaction settings. */
  memoryCompaction?: SleepMemoryCompactionConfig;
  /** Memory promotion settings (medium-term to long-term). */
  memoryPromotion?: SleepMemoryPromotionConfig;
  /** Core memory extraction settings. */
  coreMemory?: SleepCoreMemoryConfig;
};

export type AgentSleepConfig = {
  /** Enable the sleep system (default: false). */
  enabled?: boolean;
  /** Sleep window in local time (HH:MM-HH:MM, default: "03:00-06:00"). */
  window?: string;
  /** Minimum idle minutes before sleep can start (default: 45). */
  minIdleMinutes?: number;
  /** Allow user activity to interrupt sleep (default: true). */
  allowInterrupt?: boolean;
  /** Report detail level (default: "summary"). */
  reportLevel?: "summary" | "full";
  /** Timezone for sleep window ("user", "local", or IANA TZ id). */
  timezone?: string;
  /** Shallow sleep phase configuration. */
  shallow?: SleepShallowConfig;
  /** Deep sleep phase configuration. */
  deep?: SleepDeepConfig;
};
