/**
 * API key validation task: verifies API keys by making lightweight requests.
 *
 * This task validates:
 * - LLM provider API keys (Anthropic, OpenAI, Google, etc.)
 * - Tool API keys (Brave Search, Firecrawl, ElevenLabs)
 * - Skill API keys from config
 * - Rate limits and token quotas where available
 */

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import {
  createTaskResult,
  okItem,
  warningItem,
  errorItem,
  infoItem,
  createSkippedResult,
} from "./types.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";

// Timeout for API validation requests (keep low to avoid blocking sleep)
const API_VALIDATION_TIMEOUT_MS = 10_000;

// Provider validation configurations
type ProviderValidation = {
  name: string;
  providerId: string;
  category: "llm" | "tool" | "tts" | "skill";
  /** Test endpoint - use lightweight endpoints like models/list */
  testUrl: string;
  /** How to authenticate */
  authHeader: (apiKey: string) => Record<string, string>;
  /** Expected success status codes */
  successCodes: number[];
  /** Parse response to extract useful info (optional) */
  parseResponse?: (body: string) => string | undefined;
  /** Parse rate limit info from response headers (optional) */
  parseRateLimits?: (headers: Headers) => string | undefined;
};

const PROVIDER_VALIDATIONS: ProviderValidation[] = [
  {
    name: "Anthropic",
    providerId: "anthropic",
    category: "llm",
    testUrl: "https://api.anthropic.com/v1/messages",
    authHeader: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
    // OPTIONS or minimal request - we expect 400 for empty body, 401 for bad key
    successCodes: [200, 400], // 400 = key valid but bad request, 401 = invalid key
    parseRateLimits: (headers) => {
      const remaining = headers.get("x-ratelimit-limit-requests");
      const tokens = headers.get("x-ratelimit-limit-tokens");
      if (remaining || tokens) {
        const parts = [];
        if (remaining) parts.push(`${remaining} req/min`);
        if (tokens) parts.push(`${tokens} tokens/min`);
        return parts.join(", ");
      }
      return undefined;
    },
  },
  {
    name: "OpenAI",
    providerId: "openai",
    category: "llm",
    testUrl: "https://api.openai.com/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
    parseResponse: (body) => {
      try {
        const data = JSON.parse(body);
        return `${data.data?.length ?? 0} models available`;
      } catch {
        return undefined;
      }
    },
    parseRateLimits: (headers) => {
      const remaining = headers.get("x-ratelimit-remaining-requests");
      const tokens = headers.get("x-ratelimit-remaining-tokens");
      if (remaining || tokens) {
        const parts = [];
        if (remaining) parts.push(`${remaining} req`);
        if (tokens) parts.push(`${parseInt(tokens, 10).toLocaleString()} tokens`);
        return `Remaining: ${parts.join(", ")}`;
      }
      return undefined;
    },
  },
  {
    name: "Google Gemini",
    providerId: "google",
    category: "llm",
    testUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authHeader: () => ({}), // API key goes in URL
    successCodes: [200],
    parseResponse: (body) => {
      try {
        const data = JSON.parse(body);
        return `${data.models?.length ?? 0} models available`;
      } catch {
        return undefined;
      }
    },
  },
  {
    name: "OpenRouter",
    providerId: "openrouter",
    category: "llm",
    testUrl: "https://openrouter.ai/api/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Groq",
    providerId: "groq",
    category: "llm",
    testUrl: "https://api.groq.com/openai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Together AI",
    providerId: "together",
    category: "llm",
    testUrl: "https://api.together.xyz/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Mistral",
    providerId: "mistral",
    category: "llm",
    testUrl: "https://api.mistral.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Cohere",
    providerId: "cohere",
    category: "llm",
    testUrl: "https://api.cohere.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "xAI (Grok)",
    providerId: "xai",
    category: "llm",
    testUrl: "https://api.x.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "DeepSeek",
    providerId: "deepseek",
    category: "llm",
    testUrl: "https://api.deepseek.com/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
];

// Tool and service API validations
const TOOL_VALIDATIONS: ProviderValidation[] = [
  {
    name: "Brave Search",
    providerId: "brave",
    category: "tool",
    testUrl: "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
    authHeader: (key) => ({ "X-Subscription-Token": key }),
    successCodes: [200],
    parseRateLimits: (headers) => {
      const remaining = headers.get("x-ratelimit-remaining");
      const limit = headers.get("x-ratelimit-limit");
      if (remaining && limit) {
        return `${remaining}/${limit} requests remaining`;
      }
      return undefined;
    },
  },
  {
    name: "Firecrawl",
    providerId: "firecrawl",
    category: "tool",
    testUrl: "https://api.firecrawl.dev/v1/scrape",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200, 400, 402], // 402 = credit limit, 400 = missing url but key valid
    parseResponse: (body) => {
      try {
        const data = JSON.parse(body);
        if (data.error?.includes("credit")) {
          return "Valid (credits exhausted)";
        }
        return "Valid";
      } catch {
        return undefined;
      }
    },
  },
  {
    name: "ElevenLabs",
    providerId: "elevenlabs",
    category: "tts",
    testUrl: "https://api.elevenlabs.io/v1/user/subscription",
    authHeader: (key) => ({ "xi-api-key": key }),
    successCodes: [200],
    parseResponse: (body) => {
      try {
        const data = JSON.parse(body);
        const charLimit = data.character_limit;
        const charUsed = data.character_count;
        if (charLimit && charUsed !== undefined) {
          const remaining = charLimit - charUsed;
          return `${remaining.toLocaleString()} chars remaining`;
        }
        return "Valid";
      } catch {
        return undefined;
      }
    },
  },
  {
    name: "Perplexity",
    providerId: "perplexity",
    category: "tool",
    testUrl: "https://api.perplexity.ai/chat/completions",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200, 400], // 400 = missing body but key valid
  },
];

async function validateApiKey(
  validation: ProviderValidation,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ valid: boolean; message: string; rateLimits?: string; statusCode?: number }> {
  try {
    // Build URL (Google uses API key in query param)
    let url = validation.testUrl;
    if (validation.providerId === "google") {
      url = `${validation.testUrl}?key=${apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_VALIDATION_TIMEOUT_MS);

    // Combine abort signals
    signal.addEventListener("abort", () => controller.abort());

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: validation.authHeader(apiKey),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Parse rate limits from headers if available
      let rateLimits: string | undefined;
      if (validation.parseRateLimits) {
        try {
          rateLimits = validation.parseRateLimits(response.headers);
        } catch {
          // Ignore rate limit parse errors
        }
      }

      if (validation.successCodes.includes(response.status)) {
        let detail = "Valid";
        if (validation.parseResponse) {
          try {
            const body = await response.text();
            const parsed = validation.parseResponse(body);
            if (parsed) detail = parsed;
          } catch {
            // Ignore parse errors
          }
        }
        return { valid: true, message: detail, rateLimits, statusCode: response.status };
      }

      // Handle specific error codes
      if (response.status === 401 || response.status === 403) {
        return { valid: false, message: "Invalid or expired API key", statusCode: response.status };
      }
      if (response.status === 429) {
        return { valid: true, message: "Rate limited (key valid)", statusCode: response.status };
      }

      return { valid: false, message: `HTTP ${response.status}`, statusCode: response.status };
    } catch (err) {
      clearTimeout(timeout);

      if (err instanceof Error) {
        if (err.name === "AbortError") {
          return { valid: false, message: "Timeout" };
        }
        return { valid: false, message: err.message };
      }
      return { valid: false, message: "Unknown error" };
    }
  } catch (err) {
    return { valid: false, message: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function getApiKeyForProvider(
  providerId: string,
  cfg: ShallowSleepTaskContext["cfg"],
): Promise<string | undefined> {
  try {
    // Check environment variables directly first
    const envVarMap: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      groq: ["GROQ_API_KEY"],
      together: ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      cohere: ["COHERE_API_KEY", "CO_API_KEY"],
      xai: ["XAI_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY"],
    };

    const envVars = envVarMap[providerId] ?? [];
    for (const envVar of envVars) {
      const value = process.env[envVar]?.trim();
      if (value) return value;
    }

    // Check config provider
    const providerConfig = cfg?.models?.providers?.[providerId];
    if (providerConfig && typeof providerConfig === "object" && "apiKey" in providerConfig) {
      const key = (providerConfig as { apiKey?: string }).apiKey?.trim();
      if (key) return key;
    }

    // Try to resolve through the standard model auth system
    // Use a well-known model for each provider
    const providerModels: Record<string, string> = {
      anthropic: "claude-sonnet-4-20250514",
      openai: "gpt-4o",
      google: "gemini-2.0-flash",
      openrouter: "anthropic/claude-sonnet-4",
      groq: "llama-3.3-70b-versatile",
      together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      mistral: "mistral-large-latest",
      cohere: "command-r-plus",
      xai: "grok-2",
      deepseek: "deepseek-chat",
    };

    const modelId = providerModels[providerId];
    if (modelId) {
      const resolved = resolveModel(providerId, modelId, undefined, cfg);
      if (resolved.model) {
        const key = await getApiKeyForModel({ model: resolved.model, cfg });
        if (key && typeof key === "string") return key;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/** Get tool API keys from config and env vars */
function getToolApiKey(
  providerId: string,
  cfg: ShallowSleepTaskContext["cfg"],
): string | undefined {
  // Tool-specific config paths
  switch (providerId) {
    case "brave":
      return cfg?.tools?.web?.search?.apiKey || process.env.BRAVE_API_KEY?.trim();
    case "perplexity":
      return (
        cfg?.tools?.web?.search?.perplexity?.apiKey ||
        process.env.PERPLEXITY_API_KEY?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim()
      );
    case "firecrawl":
      return cfg?.tools?.web?.fetch?.firecrawl?.apiKey || process.env.FIRECRAWL_API_KEY?.trim();
    case "elevenlabs":
      // Check talk config for TTS
      const talkKey =
        typeof cfg?.talk === "object" && cfg.talk !== null
          ? (cfg.talk as { apiKey?: string; elevenlabs?: { apiKey?: string } }).apiKey ||
            (cfg.talk as { elevenlabs?: { apiKey?: string } }).elevenlabs?.apiKey
          : undefined;
      return talkKey || process.env.ELEVENLABS_API_KEY?.trim();
    default:
      return undefined;
  }
}

/** Get API keys from skill configs */
function getSkillApiKeys(
  cfg: ShallowSleepTaskContext["cfg"],
): Array<{ skillName: string; apiKey: string }> {
  const results: Array<{ skillName: string; apiKey: string }> = [];
  const skillsEntries = cfg?.skills?.entries;
  if (skillsEntries && typeof skillsEntries === "object") {
    for (const [name, skill] of Object.entries(skillsEntries)) {
      if (skill && typeof skill === "object" && "apiKey" in skill) {
        const key = (skill as { apiKey?: string }).apiKey?.trim();
        if (key) {
          results.push({ skillName: name, apiKey: key });
        }
      }
    }
  }
  return results;
}

export const apiKeyValidationTask: ShallowSleepTask = {
  name: "api-key-validation",
  description: "Validate API keys for LLM providers, tools, and skills",
  critical: false,
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.tasks.apiKeyValidation) {
      return createSkippedResult(this.name, "API key validation disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    let validated = 0;
    let failed = 0;
    let skipped = 0;
    const rateLimitInfo: string[] = [];

    // Validate LLM provider keys
    items.push(infoItem("LLM Providers"));
    for (const validation of PROVIDER_VALIDATIONS) {
      if (ctx.signal.aborted) {
        items.push(warningItem("Validation aborted"));
        break;
      }

      const apiKey = await getApiKeyForProvider(validation.providerId, ctx.cfg);
      if (!apiKey) {
        skipped++;
        continue;
      }

      const result = await validateApiKey(validation, apiKey, ctx.signal);
      if (result.valid) {
        validated++;
        let msg = result.message;
        if (result.rateLimits) {
          msg += ` (${result.rateLimits})`;
          rateLimitInfo.push(`${validation.name}: ${result.rateLimits}`);
        }
        items.push(okItem(validation.name, msg));
      } else {
        failed++;
        items.push(errorItem(validation.name, result.message));
      }
    }

    // Validate tool API keys
    items.push(infoItem("Tools & Services"));
    for (const validation of TOOL_VALIDATIONS) {
      if (ctx.signal.aborted) {
        items.push(warningItem("Validation aborted"));
        break;
      }

      const apiKey = getToolApiKey(validation.providerId, ctx.cfg);
      if (!apiKey) {
        skipped++;
        continue;
      }

      const result = await validateApiKey(validation, apiKey, ctx.signal);
      if (result.valid) {
        validated++;
        let msg = result.message;
        if (result.rateLimits) {
          msg += ` (${result.rateLimits})`;
          rateLimitInfo.push(`${validation.name}: ${result.rateLimits}`);
        }
        items.push(okItem(validation.name, msg));
      } else {
        failed++;
        items.push(errorItem(validation.name, result.message));
      }
    }

    // Validate skill API keys (generic validation - just test if they look valid)
    const skillKeys = getSkillApiKeys(ctx.cfg);
    if (skillKeys.length > 0) {
      items.push(infoItem("Skills"));
      for (const { skillName, apiKey } of skillKeys) {
        // Basic validation: non-empty, reasonable length
        if (apiKey.length >= 8 && apiKey.length <= 512) {
          validated++;
          items.push(okItem(`Skill: ${skillName}`, "Key present (not validated remotely)"));
        } else {
          failed++;
          items.push(warningItem(`Skill: ${skillName}`, "Key looks invalid (bad length)"));
        }
      }
    }

    // Summary
    const totalProviders = PROVIDER_VALIDATIONS.length + TOOL_VALIDATIONS.length;
    if (validated === 0 && skipped === totalProviders) {
      items.push(infoItem("No API keys configured"));
    } else if (failed > 0) {
      items.unshift(warningItem(`${failed} API key(s) failed validation`));
    } else if (validated > 0) {
      items.unshift(okItem(`${validated} API key(s) validated successfully`));
    }

    // Include rate limit info in summary
    if (rateLimitInfo.length > 0) {
      items.push(infoItem("Rate limits", rateLimitInfo.join("; ")));
    }

    return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
  },
};
