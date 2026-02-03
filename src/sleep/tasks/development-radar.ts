/**
 * Development radar task: monitors for new developments.
 */

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { createTaskResult, okItem, infoItem, createSkippedResult } from "./types.js";

// Known model providers and their status endpoints
const PROVIDER_STATUS_ENDPOINTS: Record<string, string> = {
  openai: "https://status.openai.com/api/v2/summary.json",
  anthropic: "https://status.anthropic.com/api/v2/summary.json",
  google: "https://status.cloud.google.com/incidents.json",
};

type StatusPageSummary = {
  status?: {
    indicator?: string;
    description?: string;
  };
  incidents?: Array<{
    name?: string;
    status?: string;
  }>;
};

async function fetchProviderStatus(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as StatusPageSummary;
    const indicator = data.status?.indicator ?? "unknown";
    const activeIncidents = data.incidents?.filter((i) => i.status !== "resolved") ?? [];

    if (indicator === "none" && activeIncidents.length === 0) {
      return { ok: true, status: "operational" };
    }

    if (activeIncidents.length > 0) {
      return { ok: true, status: `${activeIncidents.length} active incidents` };
    }

    return { ok: true, status: data.status?.description ?? indicator };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

export const developmentRadarTask: ShallowSleepTask = {
  name: "development-radar",
  description: "Monitor for new developments and features",
  critical: false,
  category: "radar",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.radar.enabled) {
      return createSkippedResult(this.name, "Development radar disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      // Check provider status pages
      if (ctx.sleepCfg.shallow.radar.newModels) {
        const providers = Object.entries(PROVIDER_STATUS_ENDPOINTS);

        for (const [provider, url] of providers) {
          if (ctx.signal.aborted) {
            break;
          }

          const result = await fetchProviderStatus(url, ctx.signal);
          if (result.ok) {
            items.push(okItem(`${provider} status`, result.status ?? "operational"));
          } else {
            items.push(infoItem(`${provider} status`, result.error ?? "unavailable"));
          }
        }
      }

      // Check custom sources
      const customSources = ctx.sleepCfg.shallow.radar.sources;
      if (customSources.length > 0) {
        for (const source of customSources) {
          if (ctx.signal.aborted) {
            break;
          }

          try {
            const response = await fetch(source, {
              signal: ctx.signal,
              headers: { Accept: "application/json" },
            });

            if (response.ok) {
              items.push(okItem(`Custom source`, new URL(source).hostname));
            } else {
              items.push(
                infoItem(`Custom source`, `${new URL(source).hostname}: HTTP ${response.status}`),
              );
            }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            items.push(infoItem(`Custom source`, `${source}: ${error}`));
          }
        }
      }

      // Protocol updates and breaking changes checks are placeholders
      // In a full implementation, these would query specific APIs or RSS feeds
      if (ctx.sleepCfg.shallow.radar.protocolUpdates) {
        items.push(infoItem("Protocol updates", "Check manually for MCP updates"));
      }

      if (ctx.sleepCfg.shallow.radar.breakingChanges) {
        items.push(infoItem("Breaking changes", "Check dependency changelogs"));
      }

      if (items.length === 0) {
        items.push(okItem("Development radar complete", "No alerts"));
      }

      return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return createTaskResult({
        name: this.name,
        critical: this.critical,
        startMs,
        items,
        error,
      });
    }
  },
};
