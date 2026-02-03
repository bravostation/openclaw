/**
 * SleepManager: orchestrates the complete sleep cycle.
 */

import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSleepConfig, type ResolvedSleepConfig } from "./config.js";
import {
  checkSleepEligibility,
  createDefaultSchedulerDeps,
  getSleepWindowInfo,
  recordUserActivity,
  setUserActive,
  type SleepSchedulerDeps,
} from "./scheduler.js";
import {
  runShallowSleep,
  runDeepSleep,
  type ShallowSleepResult,
  type DeepSleepResult,
} from "./phases/index.js";
import {
  generateReport,
  saveReport,
  loadLatestReport,
  formatReportMarkdown,
  type SleepReport,
} from "./reports/index.js";

const log = createSubsystemLogger("sleep/manager");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SleepCycleResult = {
  status: "completed" | "aborted" | "skipped" | "failed";
  reason?: string;
  report: SleepReport | null;
  reportPath?: string;
};

export type SleepManagerOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  agentIds?: string[];
  force?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  schedulerDeps?: SleepSchedulerDeps;
  onShallowStart?: () => void;
  onShallowComplete?: (result: ShallowSleepResult) => void;
  onDeepStart?: () => void;
  onDeepComplete?: (result: DeepSleepResult) => void;
};

export type SleepStatus = {
  enabled: boolean;
  sleeping: boolean;
  lastSleepAt: number | null;
  nextSleepAt: number | null;
  windowInfo: ReturnType<typeof getSleepWindowInfo> | null;
  config: ResolvedSleepConfig | null;
  agents: string[];
  byAgent: Record<string, SleepStatusAgent>;
};

export type SleepStatusAgent = {
  agentId: string;
  enabled: boolean;
  sleeping: boolean;
  lastSleepAt: number | null;
  nextSleepAt: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let isSleeping = false;
let lastSleepAtMs: number | null = null;
let currentAbortController: AbortController | null = null;
const perAgentState = new Map<string, { lastSleepAtMs: number | null }>();

// ─────────────────────────────────────────────────────────────────────────────
// Main Sleep Cycle
// ─────────────────────────────────────────────────────────────────────────────

export async function runSleepCycle(options: SleepManagerOptions = {}): Promise<SleepCycleResult> {
  const cfg = options.cfg ?? loadConfig();
  const sleepCfg = resolveSleepConfig(cfg);

  if (!sleepCfg) {
    log.debug("Sleep not enabled");
    return { status: "skipped", reason: "Sleep not enabled", report: null };
  }

  const agentId = options.agentId ?? resolveDefaultAgentId(cfg);
  const schedulerDeps = options.schedulerDeps ?? createDefaultSchedulerDeps();

  // Check eligibility (unless forced)
  if (!options.force) {
    const eligibility = checkSleepEligibility({ cfg, sleepCfg, deps: schedulerDeps });
    if (!eligibility.canSleep) {
      log.debug(`Sleep not eligible: ${eligibility.reason}`);
      return {
        status: "skipped",
        reason: eligibility.reason,
        report: null,
      };
    }
  }

  // Prevent concurrent sleep cycles
  if (isSleeping) {
    log.warn("Sleep cycle already in progress");
    return { status: "skipped", reason: "Already sleeping", report: null };
  }

  // Setup
  isSleeping = true;
  currentAbortController = new AbortController();
  const startedAt = Date.now();

  // Link external signal
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      currentAbortController?.abort();
    });
  }

  log.info(`Starting sleep cycle for agent ${agentId}`);

  let shallowResult: ShallowSleepResult | null = null;
  let deepResult: DeepSleepResult | null = null;

  try {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

    // Phase 1: Shallow Sleep
    if (sleepCfg.shallow.enabled) {
      log.info("Entering shallow sleep phase");
      options.onShallowStart?.();

      shallowResult = await runShallowSleep({
        cfg,
        sleepCfg,
        workspaceDir,
        agentId,
        signal: currentAbortController.signal,
      });

      options.onShallowComplete?.(shallowResult);

      // Abort deep sleep if shallow had critical failure
      if (shallowResult.hasCriticalFailure) {
        log.warn("Shallow sleep had critical failure, skipping deep sleep");
      }
    }

    // Phase 2: Deep Sleep (if shallow passed)
    const canRunDeep =
      sleepCfg.deep.enabled &&
      !currentAbortController.signal.aborted &&
      (!shallowResult || !shallowResult.hasCriticalFailure);

    if (canRunDeep) {
      log.info("Entering deep sleep phase");
      options.onDeepStart?.();

      deepResult = await runDeepSleep({
        cfg,
        sleepCfg,
        workspaceDir,
        agentId,
        signal: currentAbortController.signal,
        dryRun: options.dryRun,
      });

      options.onDeepComplete?.(deepResult);
    }

    // Generate report
    const report = generateReport({
      sleepCfg,
      agentId,
      startedAt,
      shallowResult,
      deepResult,
    });

    // Save report
    let reportPath: string | undefined;
    try {
      reportPath = await saveReport(report, sleepCfg.reportLevel);
      log.debug(`Sleep report saved: ${reportPath}`);
    } catch (err) {
      log.warn(`Failed to save sleep report: ${String(err)}`);
    }

    const completedAt = Date.now();
    lastSleepAtMs = completedAt;
    perAgentState.set(agentId, { lastSleepAtMs: completedAt });

    return {
      status: report.status,
      report,
      reportPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Sleep cycle failed: ${error}`);

    return {
      status: "failed",
      reason: error,
      report: null,
    };
  } finally {
    isSleeping = false;
    currentAbortController = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wake from sleep (interrupt current sleep cycle).
 */
export function wake(): boolean {
  if (!isSleeping) {
    return false;
  }

  log.info("Waking from sleep");
  currentAbortController?.abort();
  return true;
}

/**
 * Record user activity (used for idle detection).
 */
export function notifyUserActivity(): void {
  recordUserActivity();

  // If sleeping and interrupts allowed, wake
  const cfg = loadConfig();
  const sleepCfg = resolveSleepConfig(cfg);

  if (isSleeping && sleepCfg?.allowInterrupt) {
    wake();
  }
}

/**
 * Set user active state.
 */
export function setUserActiveState(active: boolean): void {
  setUserActive(active);

  if (active && isSleeping) {
    const cfg = loadConfig();
    const sleepCfg = resolveSleepConfig(cfg);

    if (sleepCfg?.allowInterrupt) {
      wake();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status & Info
// ─────────────────────────────────────────────────────────────────────────────

export function getSleepStatus(cfg?: OpenClawConfig): SleepStatus {
  const config = cfg ?? loadConfig();
  const sleepCfg = resolveSleepConfig(config);

  if (!sleepCfg) {
    return {
      enabled: false,
      sleeping: isSleeping,
      lastSleepAt: lastSleepAtMs,
      nextSleepAt: null,
      windowInfo: null,
      config: null,
      agents: [],
      byAgent: {},
    };
  }

  const windowInfo = getSleepWindowInfo({ cfg: config, sleepCfg });
  const schedulerDeps = createDefaultSchedulerDeps();
  const eligibility = checkSleepEligibility({ cfg: config, sleepCfg, deps: schedulerDeps });
  const configuredAgents = sleepCfg.agents ?? [];
  const resolvedAgents = configuredAgents.length > 0 ? configuredAgents : listAgentIds(config);
  const byAgent: Record<string, SleepStatusAgent> = {};
  for (const agentId of resolvedAgents) {
    const lastAgentSleep = perAgentState.get(agentId)?.lastSleepAtMs ?? null;
    byAgent[agentId] = {
      agentId,
      enabled: true,
      sleeping: isSleeping,
      lastSleepAt: lastAgentSleep,
      nextSleepAt: eligibility.nextWindowAtMs ?? null,
    };
  }

  return {
    enabled: true,
    sleeping: isSleeping,
    lastSleepAt: lastSleepAtMs,
    nextSleepAt: eligibility.nextWindowAtMs ?? null,
    windowInfo,
    config: sleepCfg,
    agents: resolvedAgents,
    byAgent,
  };
}

export async function getLastSleepReport(): Promise<SleepReport | null> {
  return loadLatestReport();
}

export function formatSleepReport(report: SleepReport, level?: "summary" | "full"): string {
  const cfg = loadConfig();
  const sleepCfg = resolveSleepConfig(cfg);
  return formatReportMarkdown(report, level ?? sleepCfg?.reportLevel ?? "summary");
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports for testing
// ─────────────────────────────────────────────────────────────────────────────

export function _resetState(): void {
  isSleeping = false;
  lastSleepAtMs = null;
  currentAbortController = null;
}
