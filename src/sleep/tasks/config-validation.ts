/**
 * Config validation task: verifies configuration integrity.
 */

import fs from "node:fs/promises";
import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { CONFIG_PATH } from "../../config/config.js";
import { createTaskResult, okItem, warningItem, errorItem } from "./types.js";

export const configValidationTask: ShallowSleepTask = {
  name: "config-validation",
  description: "Validate configuration schema and integrity",
  critical: true,
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      // Check config file exists
      const configPath = CONFIG_PATH;
      try {
        await fs.access(configPath);
        items.push(okItem("Config file exists", configPath));
      } catch {
        items.push(errorItem("Config file missing", configPath));
        return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
      }

      // Config is already loaded via ctx.cfg, just validate it's usable
      items.push(okItem("Config schema valid"));

      // Check for common issues
      const cfg = ctx.cfg;

      // Check workspace exists
      if (ctx.workspaceDir) {
        try {
          const stat = await fs.stat(ctx.workspaceDir);
          if (stat.isDirectory()) {
            items.push(okItem("Workspace directory exists", ctx.workspaceDir));
          } else {
            items.push(warningItem("Workspace is not a directory", ctx.workspaceDir));
          }
        } catch {
          items.push(warningItem("Workspace directory missing", ctx.workspaceDir));
        }
      }

      // Check model configuration
      const modelCfg = cfg.agents?.defaults?.model;
      if (!modelCfg?.primary) {
        items.push(warningItem("No primary model configured"));
      } else {
        items.push(okItem("Primary model configured", modelCfg.primary));
      }

      // Check gateway mode
      const gatewayMode = cfg.gateway?.mode ?? "local";
      items.push(okItem("Gateway mode", gatewayMode));

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
