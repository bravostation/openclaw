/**
 * Sleep scheduler: determines when sleep cycles can run.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedSleepConfig } from "./config.js";
import { resolveUserTimezone } from "../agents/date-time.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sleep/scheduler");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SleepEligibility = {
  canSleep: boolean;
  reason?: string;
  nextWindowAtMs?: number;
};

export type SleepSchedulerDeps = {
  nowMs: () => number;
  getLastActivityMs: () => number | null;
  isUserActive: () => boolean;
  isSystemHealthy: () => boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Time Utilities
// ─────────────────────────────────────────────────────────────────────────────

function resolveTimezone(cfg: OpenClawConfig, sleepCfg: ResolvedSleepConfig): string {
  if (sleepCfg.timezone === "user") {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
  if (sleepCfg.timezone === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return sleepCfg.timezone;
}

function getLocalTime(
  nowMs: number,
  timezone: string,
): { hour: number; minute: number; dayOfWeek: number } {
  const date = new Date(nowMs);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return { hour, minute, dayOfWeek: dayMap[weekday] ?? 1 };
}

function isWithinWindow(
  current: { hour: number; minute: number },
  start: { hour: number; minute: number },
  end: { hour: number; minute: number },
): boolean {
  const currentMinutes = current.hour * 60 + current.minute;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  // Handle overnight windows (e.g., 23:00-06:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function minutesToNextWindow(
  current: { hour: number; minute: number },
  start: { hour: number; minute: number },
): number {
  const currentMinutes = current.hour * 60 + current.minute;
  const startMinutes = start.hour * 60 + start.minute;

  if (currentMinutes < startMinutes) {
    return startMinutes - currentMinutes;
  }

  // Next day
  return 24 * 60 - currentMinutes + startMinutes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility Check
// ─────────────────────────────────────────────────────────────────────────────

export function checkSleepEligibility(params: {
  cfg: OpenClawConfig;
  sleepCfg: ResolvedSleepConfig;
  deps: SleepSchedulerDeps;
}): SleepEligibility {
  const { cfg, sleepCfg, deps } = params;
  const nowMs = deps.nowMs();

  // Check user activity
  if (deps.isUserActive()) {
    return { canSleep: false, reason: "user_active" };
  }

  // Check idle time
  const lastActivityMs = deps.getLastActivityMs();
  if (lastActivityMs !== null) {
    const idleMs = nowMs - lastActivityMs;
    const minIdleMs = sleepCfg.minIdleMinutes * 60 * 1000;
    if (idleMs < minIdleMs) {
      const remainingMs = minIdleMs - idleMs;
      return {
        canSleep: false,
        reason: "insufficient_idle",
        nextWindowAtMs: nowMs + remainingMs,
      };
    }
  }

  // Check system health
  if (!deps.isSystemHealthy()) {
    return { canSleep: false, reason: "system_unhealthy" };
  }

  // Check sleep window
  const timezone = resolveTimezone(cfg, sleepCfg);
  const localTime = getLocalTime(nowMs, timezone);

  if (!isWithinWindow(localTime, sleepCfg.windowStart, sleepCfg.windowEnd)) {
    const minutesToWindow = minutesToNextWindow(localTime, sleepCfg.windowStart);
    return {
      canSleep: false,
      reason: "outside_window",
      nextWindowAtMs: nowMs + minutesToWindow * 60 * 1000,
    };
  }

  return { canSleep: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Tracking
// ─────────────────────────────────────────────────────────────────────────────

let lastActivityTimestamp: number | null = null;
let userActiveFlag = false;

export function recordUserActivity(timestampMs?: number): void {
  lastActivityTimestamp = timestampMs ?? Date.now();
  log.debug("User activity recorded", { ts: lastActivityTimestamp });
}

export function setUserActive(active: boolean, timestampMs?: number): void {
  userActiveFlag = active;
  if (active) {
    recordUserActivity(timestampMs);
  }
}

export function createDefaultSchedulerDeps(): SleepSchedulerDeps {
  return {
    nowMs: () => Date.now(),
    getLastActivityMs: () => lastActivityTimestamp,
    isUserActive: () => userActiveFlag,
    isSystemHealthy: () => true, // TODO: integrate with health checks
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sleep Window Info
// ─────────────────────────────────────────────────────────────────────────────

export type SleepWindowInfo = {
  isInWindow: boolean;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  currentLocalTime: string;
  minutesToNextWindow: number | null;
};

export function getSleepWindowInfo(params: {
  cfg: OpenClawConfig;
  sleepCfg: ResolvedSleepConfig;
  nowMs?: number;
}): SleepWindowInfo {
  const { cfg, sleepCfg } = params;
  const nowMs = params.nowMs ?? Date.now();
  const timezone = resolveTimezone(cfg, sleepCfg);
  const localTime = getLocalTime(nowMs, timezone);

  const isInWindow = isWithinWindow(localTime, sleepCfg.windowStart, sleepCfg.windowEnd);
  const minutesToWindow = isInWindow ? null : minutesToNextWindow(localTime, sleepCfg.windowStart);

  const formatTime = (t: { hour: number; minute: number }) =>
    `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

  return {
    isInWindow,
    windowStart: formatTime(sleepCfg.windowStart),
    windowEnd: formatTime(sleepCfg.windowEnd),
    timezone,
    currentLocalTime: formatTime(localTime),
    minutesToNextWindow: minutesToWindow,
  };
}
