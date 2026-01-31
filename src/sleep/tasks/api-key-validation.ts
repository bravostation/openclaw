/**
 * API key validation task: verifies API keys by making lightweight requests.
 *
 * This task goes beyond just checking expiry dates - it actually validates
 * that API keys work by making minimal requests to each provider's API.
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
  /** Test endpoint - use lightweight endpoints like models/list */
  testUrl: string;
  /** How to authenticate */
  authHeader: (apiKey: string) => Record<string, string>;
  /** Expected success status codes */
  successCodes: number[];
  /** Parse response to extract useful info (optional) */
  parseResponse?: (body: string) => string | undefined;
};

const PROVIDER_VALIDATIONS: ProviderValidation[] = [
  {
    name: "Anthropic",
    providerId: "anthropic",
    testUrl: "https://api.anthropic.com/v1/messages",
    authHeader: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
    // OPTIONS or minimal request - we expect 400 for empty body, 401 for bad key
    successCodes: [200, 400], // 400 = key valid but bad request, 401 = invalid key
  },
  {
    name: "OpenAI",
    providerId: "openai",
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
  },
  {
    name: "Google Gemini",
    providerId: "google",
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
    testUrl: "https://openrouter.ai/api/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Groq",
    providerId: "groq",
    testUrl: "https://api.groq.com/openai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Together AI",
    providerId: "together",
    testUrl: "https://api.together.xyz/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Mistral",
    providerId: "mistral",
    testUrl: "https://api.mistral.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "Cohere",
    providerId: "cohere",
    testUrl: "https://api.cohere.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "xAI (Grok)",
    providerId: "xai",
    testUrl: "https://api.x.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
  {
    name: "DeepSeek",
    providerId: "deepseek",
    testUrl: "https://api.deepseek.com/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    successCodes: [200],
  },
];

async function validateApiKey(
  validation: ProviderValidation,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ valid: boolean; message: string; statusCode?: number }> {
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
        return { valid: true, message: detail, statusCode: response.status };
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
    // Try to resolve through the standard model auth system
    const resolved = resolveModel(providerId, undefined, undefined, cfg);
    if (resolved.model) {
      const key = await getApiKeyForModel({ model: resolved.model, cfg });
      if (key) return key;
    }

    // Check environment variables directly
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

    // Check config
    const providerConfig = cfg?.models?.providers?.[providerId];
    if (providerConfig && typeof providerConfig === "object" && "apiKey" in providerConfig) {
      const key = (providerConfig as { apiKey?: string }).apiKey?.trim();
      if (key) return key;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export const apiKeyValidationTask: ShallowSleepTask = {
  name: "api-key-validation",
  description: "Validate API keys by testing connectivity to provider endpoints",
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

    for (const validation of PROVIDER_VALIDATIONS) {
      // Check abort
      if (ctx.signal.aborted) {
        items.push(warningItem("Validation aborted"));
        break;
      }

      // Get API key for this provider
      const apiKey = await getApiKeyForProvider(validation.providerId, ctx.cfg);

      if (!apiKey) {
        skipped++;
        continue; // Skip providers without configured keys
      }

      // Validate the key
      const result = await validateApiKey(validation, apiKey, ctx.signal);

      if (result.valid) {
        validated++;
        items.push(okItem(validation.name, result.message));
      } else {
        failed++;
        items.push(errorItem(validation.name, result.message));
      }
    }

    // Summary
    if (validated === 0 && skipped === PROVIDER_VALIDATIONS.length) {
      items.push(infoItem("No API keys configured"));
    } else if (failed > 0) {
      items.unshift(warningItem(`${failed} API key(s) failed validation`));
    } else if (validated > 0) {
      items.unshift(okItem(`${validated} API key(s) validated successfully`));
    }

    return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
  },
};
