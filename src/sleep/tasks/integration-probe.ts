/**
 * Integration probe task: verifies channel connectivity.
 */

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { createTaskResult, okItem, warningItem, infoItem } from "./types.js";

export const integrationProbeTask: ShallowSleepTask = {
  name: "integration-probe",
  description: "Probe channel integrations for connectivity",
  critical: false,
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      const plugins = listChannelPlugins();

      if (plugins.length === 0) {
        items.push(infoItem("No channel plugins registered"));
        return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
      }

      let configured = 0;

      for (const plugin of plugins) {
        // Check abort signal
        if (ctx.signal.aborted) {
          items.push(warningItem("Probe aborted"));
          break;
        }

        // Check if channel has any configured accounts in the config
        const channelCfg = (ctx.cfg.channels as Record<string, unknown> | undefined)?.[plugin.id];
        if (!channelCfg) {
          continue;
        }

        configured++;
        // Note: Full health probing would require channel-specific implementations
        // For now, just note that the channel is configured
        const label = plugin.meta?.label ?? plugin.id;
        items.push(infoItem(`${label}`, "Configured"));
      }

      if (configured === 0) {
        items.push(infoItem("No channels configured"));
      } else {
        items.unshift(okItem(`${configured} channels configured`));
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
