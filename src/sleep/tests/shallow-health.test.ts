/**
 * Tests for shallow sleep credential and version checks.
 * Verifies that expired credentials and outdated binaries are detected.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { resolveSleepConfig } from "../config.js";
import type { ShallowSleepTaskContext } from "../tasks/types.js";

describe("sleep/tasks/credentials-check", () => {
  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
      },
    },
  });

  const createContext = (cfg: OpenClawConfig): ShallowSleepTaskContext => {
    const sleepCfg = resolveSleepConfig(cfg)!;
    return {
      cfg,
      sleepCfg,
      agentId: "test-agent",
      signal: new AbortController().signal,
    };
  };

  describe("expired API keys detection", () => {
    it("runs without crashing when no credentials exist", async () => {
      const { credentialsCheckTask } = await import("../tasks/credentials-check.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await credentialsCheckTask.run(ctx);

      expect(result.name).toBe("credentials-check");
      expect(["passed", "failed"]).toContain(result.status);
    });

    it("detects expired auth profiles in config", async () => {
      const { credentialsCheckTask } = await import("../tasks/credentials-check.js");

      const expiredTime = Math.floor((Date.now() - 1000) / 1000); // 1 second ago
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true, window: "03:00-06:00" },
            userTimezone: "UTC",
          },
        },
        auth: {
          profiles: {
            "expired-profile": {
              expiresAt: expiredTime,
            },
          },
        },
      };

      const ctx = createContext(cfg);
      const result = await credentialsCheckTask.run(ctx);

      // Should find the expired profile
      const expiredItem = result.items.find(
        (item) => item.label?.includes("expired-profile") && item.message === "Expired",
      );

      expect(result.name).toBe("credentials-check");
      expect(expiredItem).toBeDefined();
      expect(expiredItem?.severity).toBe("error");
    });

    it("warns about profiles expiring within 14 days", async () => {
      const { credentialsCheckTask } = await import("../tasks/credentials-check.js");

      const expiresIn10Days = Math.floor((Date.now() + 10 * 24 * 60 * 60 * 1000) / 1000);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true, window: "03:00-06:00" },
            userTimezone: "UTC",
          },
        },
        auth: {
          profiles: {
            "expiring-profile": {
              expiresAt: expiresIn10Days,
            },
          },
        },
      };

      const ctx = createContext(cfg);
      const result = await credentialsCheckTask.run(ctx);

      const warningItem = result.items.find(
        (item) => item.label?.includes("expiring-profile") && item.message?.includes("Expires in"),
      );

      expect(warningItem).toBeDefined();
      expect(warningItem?.severity).toBe("warning");
    });

    it("reports critical expiry (< 7 days) as error", async () => {
      const { credentialsCheckTask } = await import("../tasks/credentials-check.js");

      const expiresIn3Days = Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true, window: "03:00-06:00" },
            userTimezone: "UTC",
          },
        },
        auth: {
          profiles: {
            "critical-profile": {
              expiresAt: expiresIn3Days,
            },
          },
        },
      };

      const ctx = createContext(cfg);
      const result = await credentialsCheckTask.run(ctx);

      const criticalItem = result.items.find(
        (item) => item.label?.includes("critical-profile") && item.message?.includes("Expires in"),
      );

      expect(criticalItem).toBeDefined();
      expect(criticalItem?.severity).toBe("error"); // Critical expiry is error level
    });
  });
});

describe("sleep/tasks/update-check", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "update-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
      },
    },
  });

  const createContext = (
    cfg: OpenClawConfig,
    workspaceDir?: string,
  ): ShallowSleepTaskContext & { workspaceDir?: string } => {
    const sleepCfg = resolveSleepConfig(cfg)!;
    return {
      cfg,
      sleepCfg,
      agentId: "test-agent",
      signal: new AbortController().signal,
      workspaceDir,
    };
  };

  describe("binary version detection", () => {
    it("checks git and node versions when checkTools enabled", async () => {
      const { updateCheckTask } = await import("../tasks/update-check.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      // Enable tool checks only
      sleepCfg.shallow.updates.checkOpenclaw = false;
      sleepCfg.shallow.updates.checkDependencies = false;
      sleepCfg.shallow.updates.checkTools = true;

      const ctx = { ...createContext(cfg), sleepCfg };
      const result = await updateCheckTask.run(ctx);

      expect(result.name).toBe("update-check");

      // Should have git and node items
      const gitItem = result.items.find((item) => item.label === "Git");
      const nodeItem = result.items.find((item) => item.label === "Node.js");

      // These should be present if the tools exist on system
      expect(result.status).toBe("passed");
      if (gitItem) {
        expect(gitItem.severity).toBe("ok");
        expect(gitItem.message).toMatch(/\d+\.\d+/); // Version number pattern
      }
      if (nodeItem) {
        expect(nodeItem.severity).toBe("ok");
        expect(nodeItem.message).toMatch(/v?\d+\.\d+/);
      }
    });

    it("skips when updates check is disabled", async () => {
      const { updateCheckTask } = await import("../tasks/update-check.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      // Disable all update checks
      sleepCfg.shallow.updates.enabled = false;

      const ctx = { ...createContext(cfg), sleepCfg };
      const result = await updateCheckTask.run(ctx);

      expect(result.name).toBe("update-check");
      expect(result.status).toBe("skipped");
    });

    it("reports no package.json when workspace has none", async () => {
      const { updateCheckTask } = await import("../tasks/update-check.js");

      const emptyDir = path.join(tempDir, "empty-workspace");
      await fs.mkdir(emptyDir, { recursive: true });

      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      sleepCfg.shallow.updates.checkOpenclaw = false;
      sleepCfg.shallow.updates.checkDependencies = true;
      sleepCfg.shallow.updates.checkTools = false;

      const ctx = { ...createContext(cfg, emptyDir), sleepCfg };
      const result = await updateCheckTask.run(ctx);

      expect(result.name).toBe("update-check");

      // Should have info about missing package.json
      const noPackageItem = result.items.find(
        (item) => item.severity === "info" && item.label?.includes("package.json"),
      );
      expect(noPackageItem).toBeDefined();
    });
  });
});

describe("sleep/shallow-health-report", () => {
  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
      },
    },
  });

  it("aggregates all task results into health report", async () => {
    const { runShallowSleep } = await import("../phases/shallow.js");
    const cfg = createMockConfig();
    const sleepCfg = resolveSleepConfig(cfg)!;

    // Disable network-heavy tasks
    sleepCfg.shallow.tasks.integrationProbe = false;
    sleepCfg.shallow.updates.checkOpenclaw = false;
    sleepCfg.shallow.updates.checkDependencies = false;
    sleepCfg.shallow.security.npmAudit = false;
    sleepCfg.shallow.security.advisoryCheck = false;
    sleepCfg.shallow.radar.enabled = false;

    const result = await runShallowSleep({
      agentId: "health-test",
      workspaceDir: "/tmp/nonexistent",
      cfg,
      sleepCfg,
    });

    // Should have results array with task outcomes
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Each result should have required fields
    for (const taskResult of result.results) {
      expect(taskResult).toHaveProperty("name");
      expect(taskResult).toHaveProperty("status");
      expect(taskResult).toHaveProperty("items");
      expect(["passed", "failed", "skipped"]).toContain(taskResult.status);
    }
  });

  it("completes when all tasks are disabled", async () => {
    const { runShallowSleep } = await import("../phases/shallow.js");
    const cfg = createMockConfig();
    const sleepCfg = resolveSleepConfig(cfg)!;

    // Disable everything
    sleepCfg.shallow.tasks.configValidation = false;
    sleepCfg.shallow.tasks.credentialsCheck = false;
    sleepCfg.shallow.tasks.integrationProbe = false;
    sleepCfg.shallow.tasks.memoryIntegrity = false;
    sleepCfg.shallow.updates.enabled = false;
    sleepCfg.shallow.security.enabled = false;
    sleepCfg.shallow.radar.enabled = false;

    const result = await runShallowSleep({
      agentId: "disabled-test",
      workspaceDir: "/tmp/nonexistent",
      cfg,
      sleepCfg,
    });

    // With all tasks disabled, should complete (no failures)
    expect(["completed", "aborted"]).toContain(result.status);
    expect(result.hasCriticalFailure).toBeFalsy();
  });
});
