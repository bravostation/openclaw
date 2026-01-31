/**
 * Shallow sleep phase: runs maintenance and validation tasks.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepConfig } from "../config.js";
import {
  type ShallowSleepTask,
  type ShallowSleepTaskContext,
  type TaskResult,
  configValidationTask,
  credentialsCheckTask,
  integrationProbeTask,
  memoryIntegrityTask,
  updateCheckTask,
  securityScanTask,
  developmentRadarTask,
  apiKeyValidationTask,
  systemDependenciesTask,
} from "../tasks/index.js";

const log = createSubsystemLogger("sleep/shallow");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ShallowSleepResult = {
  status: "completed" | "aborted" | "failed";
  hasCriticalFailure: boolean;
  results: TaskResult[];
  durationMs: number;
  abortReason?: string;
};

export type ShallowSleepOptions = {
  cfg: OpenClawConfig;
  sleepCfg: ResolvedSleepConfig;
  workspaceDir?: string;
  agentId?: string;
  signal?: AbortSignal;
  onTaskStart?: (task: ShallowSleepTask) => void;
  onTaskComplete?: (task: ShallowSleepTask, result: TaskResult) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Task Registry
// ─────────────────────────────────────────────────────────────────────────────

function getEnabledTasks(sleepCfg: ResolvedSleepConfig): ShallowSleepTask[] {
  const tasks: ShallowSleepTask[] = [];
  const shallow = sleepCfg.shallow;

  if (!shallow.enabled) {
    return tasks;
  }

  // Health tasks
  if (shallow.tasks.enabled !== false) {
    if (shallow.tasks.configValidation) {
      tasks.push(configValidationTask);
    }
    if (shallow.tasks.credentialsCheck) {
      tasks.push(credentialsCheckTask);
    }
    if (shallow.tasks.integrationProbe) {
      tasks.push(integrationProbeTask);
    }
    if (shallow.tasks.memoryIntegrity) {
      tasks.push(memoryIntegrityTask);
    }
    if (shallow.tasks.apiKeyValidation) {
      tasks.push(apiKeyValidationTask);
    }
  }

  // Update tasks
  if (shallow.updates.enabled) {
    tasks.push(updateCheckTask);
    if (shallow.updates.checkSystemDependencies) {
      tasks.push(systemDependenciesTask);
    }
  }

  // Security tasks
  if (shallow.security.enabled) {
    tasks.push(securityScanTask);
  }

  // Radar tasks
  if (shallow.radar.enabled) {
    tasks.push(developmentRadarTask);
  }

  return tasks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function runShallowSleep(options: ShallowSleepOptions): Promise<ShallowSleepResult> {
  const startMs = Date.now();
  const results: TaskResult[] = [];
  const abortController = new AbortController();

  // Link to external signal if provided
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      abortController.abort();
    });
  }

  const ctx: ShallowSleepTaskContext = {
    cfg: options.cfg,
    sleepCfg: options.sleepCfg,
    signal: abortController.signal,
    workspaceDir: options.workspaceDir,
    agentId: options.agentId,
  };

  const tasks = getEnabledTasks(options.sleepCfg);
  log.info(`Starting shallow sleep with ${tasks.length} tasks`);

  let hasCriticalFailure = false;
  let abortReason: string | undefined;

  for (const task of tasks) {
    // Check for abort
    if (abortController.signal.aborted) {
      abortReason = "User interrupted";
      log.info("Shallow sleep aborted by user");
      break;
    }

    // Check for prior critical failure
    if (hasCriticalFailure) {
      abortReason = "Critical task failed";
      log.info("Shallow sleep aborted due to critical failure");
      break;
    }

    log.debug(`Running task: ${task.name}`);
    options.onTaskStart?.(task);

    try {
      const result = await task.run(ctx);
      results.push(result);
      options.onTaskComplete?.(task, result);

      if (result.status === "failed" && result.critical) {
        hasCriticalFailure = true;
        log.warn(`Critical task failed: ${task.name}`);
      }

      log.debug(`Task ${task.name} completed: ${result.status} (${result.durationMs}ms)`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`Task ${task.name} threw: ${error}`);

      const errorResult: TaskResult = {
        name: task.name,
        status: "failed",
        critical: task.critical,
        durationMs: Date.now() - startMs,
        items: [],
        error,
      };
      results.push(errorResult);
      options.onTaskComplete?.(task, errorResult);

      if (task.critical) {
        hasCriticalFailure = true;
      }
    }
  }

  const durationMs = Date.now() - startMs;
  const status = abortReason ? "aborted" : hasCriticalFailure ? "failed" : "completed";

  log.info(`Shallow sleep ${status} in ${durationMs}ms (${results.length} tasks)`);

  return {
    status,
    hasCriticalFailure,
    results,
    durationMs,
    abortReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

export type ShallowSleepSummary = {
  passed: number;
  failed: number;
  skipped: number;
  warnings: number;
  criticalIssues: number;
};

export function summarizeShallowSleep(result: ShallowSleepResult): ShallowSleepSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let warnings = 0;
  let criticalIssues = 0;

  for (const taskResult of result.results) {
    switch (taskResult.status) {
      case "passed":
        passed++;
        break;
      case "failed":
        failed++;
        break;
      case "skipped":
        skipped++;
        break;
    }

    for (const item of taskResult.items) {
      if (item.severity === "warning") {
        warnings++;
      } else if (item.severity === "critical" || item.severity === "error") {
        criticalIssues++;
      }
    }
  }

  return { passed, failed, skipped, warnings, criticalIssues };
}
