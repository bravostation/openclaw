/**
 * Sleep task interface and result types.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { ResolvedSleepConfig } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task Result Types
// ─────────────────────────────────────────────────────────────────────────────

export type TaskSeverity = "ok" | "info" | "warning" | "error" | "critical";

export type TaskResultItem = {
  label: string;
  severity: TaskSeverity;
  message?: string;
  details?: Record<string, unknown>;
};

export type TaskResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  critical: boolean;
  durationMs: number;
  items: TaskResultItem[];
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Task Interface
// ─────────────────────────────────────────────────────────────────────────────

export type ShallowSleepTaskContext = {
  cfg: OpenClawConfig;
  sleepCfg: ResolvedSleepConfig;
  signal: AbortSignal;
  workspaceDir?: string;
  agentId?: string;
};

export interface ShallowSleepTask {
  /** Unique task identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** If true, failure aborts deep sleep. */
  critical: boolean;
  /** Task category for grouping in reports. */
  category: "health" | "updates" | "security" | "radar";
  /** Execute the task. */
  run(ctx: ShallowSleepTaskContext): Promise<TaskResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

export function createTaskResult(params: {
  name: string;
  critical: boolean;
  startMs: number;
  items: TaskResultItem[];
  error?: string;
}): TaskResult {
  const hasFailure = params.items.some((i) => i.severity === "error" || i.severity === "critical");

  return {
    name: params.name,
    status: params.error ? "failed" : hasFailure ? "failed" : "passed",
    critical: params.critical,
    durationMs: Date.now() - params.startMs,
    items: params.items,
    error: params.error,
  };
}

export function createSkippedResult(name: string, reason: string): TaskResult {
  return {
    name,
    status: "skipped",
    critical: false,
    durationMs: 0,
    items: [{ label: "Skipped", severity: "info", message: reason }],
  };
}

export function okItem(label: string, message?: string): TaskResultItem {
  return { label, severity: "ok", message };
}

export function infoItem(label: string, message?: string): TaskResultItem {
  return { label, severity: "info", message };
}

export function warningItem(label: string, message?: string): TaskResultItem {
  return { label, severity: "warning", message };
}

export function errorItem(label: string, message?: string): TaskResultItem {
  return { label, severity: "error", message };
}

export function criticalItem(label: string, message?: string): TaskResultItem {
  return { label, severity: "critical", message };
}
