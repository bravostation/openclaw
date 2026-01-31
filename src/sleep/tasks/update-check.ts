/**
 * Update check task: checks for available updates.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

import { fetchNpmLatestVersion } from "../../infra/update-check.js";
import { VERSION } from "../../version.js";
import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { createTaskResult, okItem, warningItem, infoItem, createSkippedResult } from "./types.js";

const execAsync = promisify(exec);
const NPM_OUTDATED_TIMEOUT_MS = 30_000;

type NpmOutdatedEntry = {
  current: string;
  wanted: string;
  latest: string;
  location: string;
};

export const updateCheckTask: ShallowSleepTask = {
  name: "update-check",
  description: "Check for available updates",
  critical: false,
  category: "updates",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.updates.enabled) {
      return createSkippedResult(this.name, "Updates check disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      // Check openclaw version
      if (ctx.sleepCfg.shallow.updates.checkOpenclaw) {
        try {
          const registryStatus = await fetchNpmLatestVersion({ timeoutMs: 5000 });
          const currentVersion = VERSION;
          const latestVersion = registryStatus.latestVersion;

          if (latestVersion && currentVersion !== latestVersion) {
            items.push(
              warningItem("OpenClaw update available", `${currentVersion} → ${latestVersion}`),
            );
          } else if (latestVersion) {
            items.push(okItem("OpenClaw up to date", currentVersion));
          } else {
            items.push(
              infoItem(
                "OpenClaw version check",
                registryStatus.error ?? "Could not determine version",
              ),
            );
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          items.push(infoItem("OpenClaw version check failed", error));
        }
      }

      // Check workspace dependencies
      if (ctx.sleepCfg.shallow.updates.checkDependencies && ctx.workspaceDir) {
        const packageJsonPath = path.join(ctx.workspaceDir, "package.json");
        try {
          await fs.access(packageJsonPath);

          // Run npm outdated
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), NPM_OUTDATED_TIMEOUT_MS);

            try {
              const { stdout } = await execAsync("npm outdated --json 2>/dev/null || true", {
                cwd: ctx.workspaceDir,
                signal: controller.signal,
              });

              clearTimeout(timeout);

              if (stdout.trim()) {
                const outdated = JSON.parse(stdout) as Record<string, NpmOutdatedEntry>;
                const entries = Object.entries(outdated);

                if (entries.length === 0) {
                  items.push(okItem("Workspace dependencies up to date"));
                } else {
                  // Show first 5 outdated packages
                  const shown = entries.slice(0, 5);
                  for (const [pkg, info] of shown) {
                    items.push(infoItem(`${pkg}`, `${info.current} → ${info.latest}`));
                  }
                  if (entries.length > 5) {
                    items.push(infoItem(`...and ${entries.length - 5} more outdated packages`));
                  }
                }
              } else {
                items.push(okItem("Workspace dependencies up to date"));
              }
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") {
                items.push(infoItem("Dependency check timed out"));
              } else {
                throw err;
              }
            }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            items.push(infoItem("Dependency check failed", error));
          }
        } catch {
          items.push(infoItem("No package.json in workspace"));
        }
      }

      // Check tools (placeholder for MCP servers, etc.)
      if (ctx.sleepCfg.shallow.updates.checkTools) {
        // Check git version
        try {
          const { stdout } = await execAsync("git --version", { timeout: 5000 });
          const version = stdout.trim().replace("git version ", "");
          items.push(okItem("Git", version));
        } catch {
          items.push(infoItem("Git version check failed"));
        }

        // Check node version
        try {
          const { stdout } = await execAsync("node --version", { timeout: 5000 });
          items.push(okItem("Node.js", stdout.trim()));
        } catch {
          items.push(infoItem("Node.js version check failed"));
        }
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
