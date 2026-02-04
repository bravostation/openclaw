/**
 * LLM reflection layer for sleep memory operations.
 *
 * Uses the pi-ai completeSimple API to evaluate memories through
 * the lens of the agent's identity (SOUL.md, IDENTITY.md) and
 * existing memory hierarchy.
 */

import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  CoreMemorySynthesisResult,
  IdentityContext,
  LongTermMemoryEntry,
  MemoryCandidate,
  PromotionReflectionResult,
  PruneReflectionResult,
  ReflectionLogEntry,
  ResolvedLlmReflectionConfig,
} from "./types.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { logVerbose } from "../../globals.js";
import { loadIdentityContext, searchMediumTermMemories } from "./identity-context.js";
import { buildPrunePrompt, buildPromotePrompt, buildCoreSynthesisPrompt } from "./prompts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LLM_REFLECTION_ENABLED = true;
export const DEFAULT_LLM_PROVIDER = "anthropic";
export const DEFAULT_LLM_MODEL = "claude-opus-4-5";
export const DEFAULT_LLM_BATCH_SIZE = 20;
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_PRUNE_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_PROMOTE_RELEVANCE_THRESHOLD = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Config Resolution
// ─────────────────────────────────────────────────────────────────────────────

export function resolveLlmReflectionConfig(cfg?: OpenClawConfig): ResolvedLlmReflectionConfig {
  const raw = cfg?.agents?.defaults?.sleep?.deep?.llmReflection;
  return {
    enabled: raw?.enabled ?? DEFAULT_LLM_REFLECTION_ENABLED,
    provider: raw?.provider ?? DEFAULT_LLM_PROVIDER,
    model: raw?.model ?? DEFAULT_LLM_MODEL,
    batchSize: raw?.batchSize ?? DEFAULT_LLM_BATCH_SIZE,
    timeoutMs: raw?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    pruneConfidenceThreshold: raw?.pruneConfidenceThreshold ?? DEFAULT_PRUNE_CONFIDENCE_THRESHOLD,
    promoteRelevanceThreshold:
      raw?.promoteRelevanceThreshold ?? DEFAULT_PROMOTE_RELEVANCE_THRESHOLD,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core LLM Call
// ─────────────────────────────────────────────────────────────────────────────

async function callLlm(params: {
  prompt: string;
  config: ResolvedLlmReflectionConfig;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<string> {
  const { prompt, config, cfg, signal } = params;

  const resolved = resolveModel(config.provider, config.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown model: ${config.provider}/${config.model}`);
  }

  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg }),
    config.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  // Combine signals if provided
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const res = await completeSimple(
      resolved.model,
      {
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 4000,
        temperature: 0.3,
        signal: controller.signal,
      },
    );

    // Extract text content from response
    const textContent = res.content.find((c): c is TextContent => c.type === "text");
    return textContent?.text ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse JSON array from LLM response, handling markdown code blocks.
 */
function parseJsonResponse<T>(response: string): T[] {
  // Strip markdown code blocks if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as T[];
  } catch {
    logVerbose(`[sleep/llm] Failed to parse LLM response: ${cleaned.slice(0, 200)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pruning Reflection
// ─────────────────────────────────────────────────────────────────────────────

export async function reflectOnPruning(params: {
  memories: MemoryCandidate[];
  identityContext: IdentityContext;
  config: ResolvedLlmReflectionConfig;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<{
  results: PruneReflectionResult[];
  log: ReflectionLogEntry;
}> {
  const startTime = Date.now();
  const { memories, identityContext, config, cfg, signal } = params;

  // Batch memories
  const batches: MemoryCandidate[][] = [];
  for (let i = 0; i < memories.length; i += config.batchSize) {
    batches.push(memories.slice(i, i + config.batchSize));
  }

  const allResults: PruneReflectionResult[] = [];
  let error: string | undefined;

  for (const batch of batches) {
    try {
      const prompt = buildPrunePrompt(batch, identityContext);
      const response = await callLlm({ prompt, config, cfg, signal });
      const batchResults = parseJsonResponse<PruneReflectionResult>(response);

      // Validate and normalize results
      for (const result of batchResults) {
        if (result.id && (result.decision === "keep" || result.decision === "prune")) {
          allResults.push({
            id: result.id,
            decision: result.decision,
            reason: result.reason ?? "",
            confidence: result.confidence,
          });
        }
      }
    } catch (e) {
      error = String(e);
      logVerbose(`[sleep/llm] Pruning batch failed: ${error}`);
    }
  }

  return {
    results: allResults,
    log: {
      operation: "prune",
      memoryCount: memories.length,
      decisions: allResults.map((r) => ({
        id: r.id,
        outcome: r.decision,
        reason: r.reason,
      })),
      durationMs: Date.now() - startTime,
      model: config.model,
      error,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotion Reflection
// ─────────────────────────────────────────────────────────────────────────────

export async function reflectOnPromotion(params: {
  memories: MemoryCandidate[];
  identityContext: IdentityContext;
  config: ResolvedLlmReflectionConfig;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<{
  results: PromotionReflectionResult[];
  log: ReflectionLogEntry;
}> {
  const startTime = Date.now();
  const { memories, identityContext, config, cfg, signal } = params;

  // Batch memories
  const batches: MemoryCandidate[][] = [];
  for (let i = 0; i < memories.length; i += config.batchSize) {
    batches.push(memories.slice(i, i + config.batchSize));
  }

  const allResults: PromotionReflectionResult[] = [];
  let error: string | undefined;

  for (const batch of batches) {
    try {
      const prompt = buildPromotePrompt(batch, identityContext);
      const response = await callLlm({ prompt, config, cfg, signal });
      const batchResults = parseJsonResponse<PromotionReflectionResult>(response);

      // Validate and normalize results
      for (const result of batchResults) {
        if (result.id && typeof result.relevance === "number") {
          allResults.push({
            id: result.id,
            relevance: Math.max(0, Math.min(1, result.relevance)),
            reason: result.reason ?? "",
            suggestedTier: result.suggestedTier,
          });
        }
      }
    } catch (e) {
      error = String(e);
      logVerbose(`[sleep/llm] Promotion batch failed: ${error}`);
    }
  }

  return {
    results: allResults,
    log: {
      operation: "promote",
      memoryCount: memories.length,
      decisions: allResults.map((r) => ({
        id: r.id,
        outcome: `relevance=${r.relevance.toFixed(2)}`,
        reason: r.reason,
      })),
      durationMs: Date.now() - startTime,
      model: config.model,
      error,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Memory Synthesis
// ─────────────────────────────────────────────────────────────────────────────

export async function synthesizeCoreMemories(params: {
  longTermMemories: LongTermMemoryEntry[];
  identityContext: IdentityContext;
  config: ResolvedLlmReflectionConfig;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<{
  results: CoreMemorySynthesisResult[];
  log: ReflectionLogEntry;
}> {
  const startTime = Date.now();
  const { longTermMemories, identityContext, config, cfg, signal } = params;

  let error: string | undefined;
  let results: CoreMemorySynthesisResult[] = [];

  try {
    // Search medium-term memories for additional context
    // Extract keywords from long-term memories for relevance
    const keywords = longTermMemories
      .slice(0, 10)
      .map((m) => m.content)
      .join(" ");
    const relevantMediumTerm = searchMediumTermMemories(
      identityContext.mediumTermMemories,
      keywords,
      20,
    );

    const prompt = buildCoreSynthesisPrompt(longTermMemories, relevantMediumTerm, identityContext);
    const response = await callLlm({ prompt, config, cfg, signal });
    const rawResults = parseJsonResponse<CoreMemorySynthesisResult>(response);

    // Validate results
    const validThemes = new Set([
      "user_preference",
      "user_values",
      "behavioral_pattern",
      "relationship",
      "expertise",
      "goal",
      "constraint",
    ]);

    results = rawResults.filter(
      (r) =>
        r.theme &&
        validThemes.has(r.theme) &&
        r.description &&
        typeof r.confidence === "number" &&
        Array.isArray(r.supportingMemoryIds),
    );
  } catch (e) {
    error = String(e);
    logVerbose(`[sleep/llm] Core synthesis failed: ${error}`);
  }

  return {
    results,
    log: {
      operation: "core-extract",
      memoryCount: longTermMemories.length,
      decisions: results.map((r) => ({
        id: r.reinforcesExisting ?? `new-${r.theme}`,
        outcome: r.theme,
        reason: r.description,
      })),
      durationMs: Date.now() - startTime,
      model: config.model,
      error,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-Level API
// ─────────────────────────────────────────────────────────────────────────────

export type ReflectionContext = {
  workspaceDir: string;
  agentDir: string;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
};

/**
 * Load identity context and resolve LLM config for reflection operations.
 */
export async function prepareReflectionContext(params: ReflectionContext): Promise<{
  identityContext: IdentityContext;
  config: ResolvedLlmReflectionConfig;
}> {
  const identityContext = await loadIdentityContext({
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
  });

  const config = resolveLlmReflectionConfig(params.cfg);

  return { identityContext, config };
}

/**
 * Check if LLM reflection is enabled.
 */
export function isLlmReflectionEnabled(cfg?: OpenClawConfig): boolean {
  return resolveLlmReflectionConfig(cfg).enabled;
}
