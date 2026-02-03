/**
 * SleepManager: orchestrates the complete sleep cycle.
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSleepConfig, type ResolvedSleepConfig } from "./config.js";
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
import {
  checkSleepEligibility,
  createDefaultSchedulerDeps,
  getSleepWindowInfo,
  recordUserActivity,
  setUserActive,
  type SleepSchedulerDeps,
} from "./scheduler.js";

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

const activeSleepCycles = new Set<string>();
let lastSleepAtMs: number | null = null;
const abortControllers = new Map<string, AbortController>();
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

  // Prevent concurrent sleep cycles for the same agent
  if (activeSleepCycles.has(agentId)) {
    log.warn(`Sleep cycle already in progress for agent ${agentId}`);
    return { status: "skipped", reason: "Already sleeping", report: null };
  }

  // Setup
  activeSleepCycles.add(agentId);
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  const startedAt = Date.now();

  // Link external signal
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      controller.abort();
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
        signal: controller.signal,
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
      !controller.signal.aborted &&
      (!shallowResult || !shallowResult.hasCriticalFailure);

    if (canRunDeep) {
      log.info("Entering deep sleep phase");
      options.onDeepStart?.();

      deepResult = await runDeepSleep({
        cfg,
        sleepCfg,
        workspaceDir,
        agentId,
        signal: controller.signal,
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
    activeSleepCycles.delete(agentId);
    abortControllers.delete(agentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wake from sleep (interrupt current sleep cycle).
 */
export function wake(agentId?: string): boolean {
  if (agentId) {
    const controller = abortControllers.get(agentId);
    if (controller) {
      log.info(`Waking agent ${agentId} from sleep`);
      controller.abort();
      return true;
    }
    return false;
  }

  // Wake all agents
  if (activeSleepCycles.size === 0) {
    return false;
  }

  log.info("Waking all agents from sleep");
  for (const controller of abortControllers.values()) {
    controller.abort();
  }
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

  if (activeSleepCycles.size > 0 && sleepCfg?.allowInterrupt) {
    wake();
  }
}

/**
 * Set user active state.
 */
export function setUserActiveState(active: boolean): void {
  setUserActive(active);

  if (active && activeSleepCycles.size > 0) {
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

  const anySleeping = activeSleepCycles.size > 0;

  if (!sleepCfg) {
    return {
      enabled: false,
      sleeping: anySleeping,
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
      sleeping: activeSleepCycles.has(agentId),
      lastSleepAt: lastAgentSleep,
      nextSleepAt: eligibility.nextWindowAtMs ?? null,
    };
  }

  return {
    enabled: true,
    sleeping: anySleeping,
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
  activeSleepCycles.clear();
  abortControllers.clear();
  lastSleepAtMs = null;
}
