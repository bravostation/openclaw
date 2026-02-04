import { describe, expect, it, vi, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSleepConfig } from "./config.js";
import {
  checkSleepEligibility,
  getSleepWindowInfo,
  recordUserActivity,
  setUserActive,
  createDefaultSchedulerDeps,
} from "./scheduler.js";

describe("sleep/scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const createMockConfig = (overrides?: Partial<OpenClawConfig>): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
        ...overrides?.agents?.defaults,
      },
    },
    ...overrides,
  });

  describe("getSleepWindowInfo", () => {
    it("returns window info for a valid config", () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg);
      expect(sleepCfg).not.toBeNull();
      if (!sleepCfg) {
        return;
      }

      const info = getSleepWindowInfo({ cfg, sleepCfg });

      expect(info.windowStart).toBe("03:00");
      expect(info.windowEnd).toBe("06:00");
      expect(info.timezone).toBeTruthy();
    });
  });

  describe("checkSleepEligibility", () => {
    it("returns eligible when within window and idle", () => {
      // Set fake timers first, then set time
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-31T04:00:00Z"));

      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg);
      expect(sleepCfg).not.toBeNull();
      if (!sleepCfg) {
        return;
      }

      // Create deps with idle state
      const deps = createDefaultSchedulerDeps();
      deps.getLastActivityMs = () => Date.now() - 60 * 60 * 1000; // 1 hour ago
      deps.isUserActive = () => false;

      const result = checkSleepEligibility({ cfg, sleepCfg, deps });

      expect(result.canSleep).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("returns ineligible when user is active", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-31T04:00:00Z"));

      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg);
      expect(sleepCfg).not.toBeNull();
      if (!sleepCfg) {
        return;
      }

      const deps = createDefaultSchedulerDeps();
      deps.isUserActive = () => true;

      const result = checkSleepEligibility({ cfg, sleepCfg, deps });

      expect(result.canSleep).toBe(false);
      expect(result.reason).toBe("user_active");
    });

    it("returns ineligible when outside sleep window", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-31T10:00:00Z"));

      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg);
      expect(sleepCfg).not.toBeNull();
      if (!sleepCfg) {
        return;
      }

      const deps = createDefaultSchedulerDeps();
      deps.getLastActivityMs = () => Date.now() - 60 * 60 * 1000;
      deps.isUserActive = () => false;

      const result = checkSleepEligibility({ cfg, sleepCfg, deps });

      expect(result.canSleep).toBe(false);
      expect(result.reason).toBe("outside_window");
    });

    it("returns ineligible when not idle long enough", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-31T04:00:00Z"));

      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg);
      expect(sleepCfg).not.toBeNull();
      if (!sleepCfg) {
        return;
      }

      const deps = createDefaultSchedulerDeps();
      deps.getLastActivityMs = () => Date.now() - 10 * 60 * 1000; // Only 10 minutes ago
      deps.isUserActive = () => false;

      const result = checkSleepEligibility({ cfg, sleepCfg, deps });

      expect(result.canSleep).toBe(false);
      expect(result.reason).toBe("insufficient_idle");
    });
  });

  describe("activity tracking", () => {
    it("recordUserActivity updates last activity timestamp", () => {
      const testTimestamp = 1735689600000; // A fixed timestamp
      recordUserActivity(testTimestamp);
      const deps = createDefaultSchedulerDeps();
      const lastActivity = deps.getLastActivityMs();
      expect(lastActivity).toBe(testTimestamp);
    });

    it("setUserActive sets active state", () => {
      // Use explicit timestamp to avoid Date.now() issues
      setUserActive(true, 1735689600000);
      const deps = createDefaultSchedulerDeps();
      expect(deps.isUserActive()).toBe(true);

      setUserActive(false, 1735689600000);
      expect(deps.isUserActive()).toBe(false);
    });
  });
});
