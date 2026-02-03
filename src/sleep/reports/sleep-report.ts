/**
 * Sleep report generator: creates sleep cycle reports.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { STATE_DIR } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedSleepConfig } from "../config.js";
import type { ShallowSleepResult, ShallowSleepSummary } from "../phases/shallow.js";
import type { DeepSleepResult, DeepSleepSummary } from "../phases/deep.js";
import { summarizeShallowSleep } from "../phases/shallow.js";
import { summarizeDeepSleep } from "../phases/deep.js";
import type { TaskResult, TaskResultItem } from "../tasks/types.js";

const log = createSubsystemLogger("sleep/report");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SleepReport = {
  id: string;
  agentId: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "aborted" | "failed";
  shallow: {
    result: ShallowSleepResult;
    summary: ShallowSleepSummary;
  } | null;
  deep: {
    result: DeepSleepResult;
    summary: DeepSleepSummary;
  } | null;
  totalDurationMs: number;
};

export type SleepReportOptions = {
  sleepCfg: ResolvedSleepConfig;
  agentId: string;
  startedAt: number;
  shallowResult: ShallowSleepResult | null;
  deepResult: DeepSleepResult | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Report Generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateReport(options: SleepReportOptions): SleepReport {
  const { agentId, startedAt, shallowResult, deepResult } = options;
  const completedAt = Date.now();

  // Determine overall status
  let status: SleepReport["status"] = "completed";
  if (shallowResult?.status === "failed" || deepResult?.status === "failed") {
    status = "failed";
  } else if (shallowResult?.status === "aborted" || deepResult?.status === "aborted") {
    status = "aborted";
  }

  return {
    id: `sleep-${startedAt}`,
    agentId,
    startedAt,
    completedAt,
    status,
    shallow: shallowResult
      ? {
          result: shallowResult,
          summary: summarizeShallowSleep(shallowResult),
        }
      : null,
    deep: deepResult
      ? {
          result: deepResult,
          summary: summarizeDeepSleep(deepResult),
        }
      : null,
    totalDurationMs: completedAt - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Formatting
// ─────────────────────────────────────────────────────────────────────────────

function severityIcon(severity: TaskResultItem["severity"]): string {
  switch (severity) {
    case "ok":
      return "✔";
    case "info":
      return "ℹ";
    case "warning":
      return "⚠";
    case "error":
      return "✖";
    case "critical":
      return "🚨";
    default:
      return "•";
  }
}

function formatTaskResult(result: TaskResult): string {
  const lines: string[] = [];
  const statusIcon = result.status === "passed" ? "✔" : result.status === "skipped" ? "⊘" : "✖";

  lines.push(`### ${statusIcon} ${result.name}`);

  if (result.error) {
    lines.push(`\n**Error:** ${result.error}`);
  }

  for (const item of result.items) {
    const icon = severityIcon(item.severity);
    const msg = item.message ? `: ${item.message}` : "";
    lines.push(`- ${icon} ${item.label}${msg}`);
  }

  return lines.join("\n");
}

export function formatReportMarkdown(report: SleepReport, level: "summary" | "full"): string {
  const lines: string[] = [];
  const date = new Date(report.startedAt).toISOString().split("T")[0];
  const statusEmoji =
    report.status === "completed" ? "✅" : report.status === "aborted" ? "⚠️" : "❌";

  lines.push(`# Sleep Cycle Report – ${date} ${statusEmoji}`);
  lines.push("");
  lines.push(`**Agent:** ${report.agentId}`);
  lines.push(`**Status:** ${report.status}`);
  lines.push(`**Duration:** ${formatDuration(report.totalDurationMs)}`);
  lines.push("");

  // Shallow Sleep Section
  if (report.shallow) {
    lines.push("## Shallow Sleep");
    lines.push("");

    const summary = report.shallow.summary;
    lines.push(
      `- **Tasks:** ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
    );
    if (summary.warnings > 0) {
      lines.push(`- **Warnings:** ${summary.warnings}`);
    }
    if (summary.criticalIssues > 0) {
      lines.push(`- **Critical Issues:** ${summary.criticalIssues}`);
    }
    lines.push(`- **Duration:** ${formatDuration(report.shallow.result.durationMs)}`);
    lines.push("");

    if (level === "full") {
      // Group results by category
      const byCategory = new Map<string, TaskResult[]>();
      for (const result of report.shallow.result.results) {
        // Infer category from task name
        let category = "other";
        if (
          [
            "config-validation",
            "credentials-check",
            "integration-probe",
            "memory-integrity",
          ].includes(result.name)
        ) {
          category = "health";
        } else if (result.name === "update-check") {
          category = "updates";
        } else if (result.name === "security-scan") {
          category = "security";
        } else if (result.name === "development-radar") {
          category = "radar";
        }

        const existing = byCategory.get(category) ?? [];
        existing.push(result);
        byCategory.set(category, existing);
      }

      const categoryLabels: Record<string, string> = {
        health: "Health Checks",
        updates: "Updates",
        security: "Security",
        radar: "Development Radar",
        other: "Other",
      };

      for (const [category, results] of byCategory) {
        lines.push(`### ${categoryLabels[category] ?? category}`);
        lines.push("");
        for (const result of results) {
          lines.push(formatTaskResult(result));
          lines.push("");
        }
      }
    }
  }

  // Deep Sleep Section
  if (report.deep) {
    lines.push("## Deep Sleep");
    lines.push("");

    const summary = report.deep.summary;
    lines.push(`- **Short-term memories before:** ${summary.memoriesBefore.toLocaleString()}`);
    lines.push(`- **Short-term memories after:** ${summary.memoriesAfter.toLocaleString()}`);

    if (summary.memoriesPruned > 0) {
      lines.push(`- **Pruned:** ${summary.memoriesPruned.toLocaleString()} chunks`);
    }
    if (summary.memoriesCompacted > 0) {
      lines.push(`- **Compacted:** ${summary.memoriesCompacted.toLocaleString()} chunks`);
    }

    // Medium-term memory stats
    if (summary.mediumTermNew > 0 || summary.mediumTermReinforced > 0) {
      lines.push(
        `- **Medium-term memories:** ${summary.mediumTermNew} new, ${summary.mediumTermReinforced} reinforced`,
      );
    }
    if (summary.promotedToLongTerm > 0) {
      lines.push(`- **Promoted to long-term:** ${summary.promotedToLongTerm}`);
    }

    if (summary.memoriesPromoted > 0) {
      lines.push(`- **Legacy promoted:** ${summary.memoriesPromoted} memories`);
    }
    if (summary.coreMemoriesCreated > 0 || summary.coreMemoriesReinforced > 0) {
      lines.push(
        `- **Core memories:** ${summary.coreMemoriesCreated} created, ${summary.coreMemoriesReinforced} reinforced`,
      );
    }
    lines.push(`- **Duration:** ${formatDuration(report.deep.result.durationMs)}`);
    lines.push("");

    if (level === "full" && report.deep.result.error) {
      lines.push(`### Errors`);
      lines.push("");
      lines.push(`- ${report.deep.result.error}`);
      lines.push("");
    }
  }

  // Timing Summary
  lines.push("## Timing");
  lines.push("");
  if (report.shallow) {
    lines.push(`- **Shallow:** ${formatDuration(report.shallow.result.durationMs)}`);
  }
  if (report.deep) {
    lines.push(`- **Deep:** ${formatDuration(report.deep.result.durationMs)}`);
  }
  lines.push(`- **Total:** ${formatDuration(report.totalDurationMs)}`);
  lines.push("");

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

const REPORTS_DIR = "sleep-reports";
const MAX_REPORTS = 30;

export async function saveReport(report: SleepReport, level: "summary" | "full"): Promise<string> {
  const reportsDir = path.join(STATE_DIR, REPORTS_DIR);

  await fs.mkdir(reportsDir, { recursive: true });

  // Save JSON
  const jsonPath = path.join(reportsDir, `${report.id}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  // Save Markdown
  const mdPath = path.join(reportsDir, `${report.id}.md`);
  const markdown = formatReportMarkdown(report, level);
  await fs.writeFile(mdPath, markdown, "utf-8");

  // Cleanup old reports
  try {
    const entries = await fs.readdir(reportsDir);
    const jsonFiles = entries
      .filter((e) => e.endsWith(".json"))
      .toSorted()
      .toReversed();

    if (jsonFiles.length > MAX_REPORTS) {
      const toDelete = jsonFiles.slice(MAX_REPORTS);
      for (const file of toDelete) {
        const baseName = file.replace(".json", "");
        await fs.unlink(path.join(reportsDir, file)).catch(() => {});
        await fs.unlink(path.join(reportsDir, `${baseName}.md`)).catch(() => {});
      }
    }
  } catch (err) {
    log.warn(`Failed to cleanup old reports: ${String(err)}`);
  }

  return mdPath;
}

export async function loadLatestReport(): Promise<SleepReport | null> {
  const reportsDir = path.join(STATE_DIR, REPORTS_DIR);

  try {
    const entries = await fs.readdir(reportsDir);
    const jsonFiles = entries
      .filter((e) => e.endsWith(".json"))
      .toSorted()
      .toReversed();

    if (jsonFiles.length === 0) {
      return null;
    }

    const firstFile = jsonFiles[0];
    if (!firstFile) {
      return null;
    }
    const content = await fs.readFile(path.join(reportsDir, firstFile), "utf-8");
    return JSON.parse(content) as SleepReport;
  } catch {
    return null;
  }
}
