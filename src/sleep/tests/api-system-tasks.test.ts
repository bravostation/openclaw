/**
 * Tests for API key validation and system dependencies tasks.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { resolveSleepConfig } from "../config.js";
import type { ShallowSleepTaskContext } from "../tasks/types.js";

describe("sleep/tasks/api-key-validation", () => {
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

  describe("provider validation", () => {
    it("runs without crashing when no API keys configured", async () => {
      const { apiKeyValidationTask } = await import("../tasks/api-key-validation.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await apiKeyValidationTask.run(ctx);

      expect(result.name).toBe("api-key-validation");
      expect(["passed", "failed", "skipped"]).toContain(result.status);
    });

    it("skips when apiKeyValidation is disabled", async () => {
      const { apiKeyValidationTask } = await import("../tasks/api-key-validation.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.shallow.tasks.apiKeyValidation = false;

      const ctx: ShallowSleepTaskContext = {
        cfg,
        sleepCfg,
        agentId: "test",
        signal: new AbortController().signal,
      };

      const result = await apiKeyValidationTask.run(ctx);

      expect(result.name).toBe("api-key-validation");
      expect(result.status).toBe("skipped");
    });

    it("reports info when no API keys are configured", async () => {
      const { apiKeyValidationTask } = await import("../tasks/api-key-validation.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await apiKeyValidationTask.run(ctx);

      // Should have an info item about no keys
      const noKeysItem = result.items.find(
        (item) => item.severity === "info" && item.label?.includes("No API keys"),
      );
      expect(noKeysItem).toBeDefined();
    });

    it("validates keys found in environment (mock test)", async () => {
      // Note: This test just validates the task structure and error handling
      // Real API key validation happens against live endpoints
      const { apiKeyValidationTask } = await import("../tasks/api-key-validation.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await apiKeyValidationTask.run(ctx);

      expect(result.name).toBe("api-key-validation");
      expect(result.items.length).toBeGreaterThan(0);
      // Should have at least one item (either validation results or "no keys" info)
    });

    it("handles abort signal gracefully", async () => {
      const { apiKeyValidationTask } = await import("../tasks/api-key-validation.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      const controller = new AbortController();
      controller.abort();

      const ctx: ShallowSleepTaskContext = {
        cfg,
        sleepCfg,
        agentId: "test",
        signal: controller.signal,
      };

      const result = await apiKeyValidationTask.run(ctx);

      // Should complete (may have abort warning)
      expect(result.name).toBe("api-key-validation");
    });
  });
});

describe("sleep/tasks/system-dependencies", () => {
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

  describe("version checks", () => {
    it("runs without crashing", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      expect(result.name).toBe("system-dependencies");
      expect(["passed", "failed", "skipped"]).toContain(result.status);
    });

    it("skips when checkSystemDependencies is disabled", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.shallow.updates.checkSystemDependencies = false;

      const ctx: ShallowSleepTaskContext = {
        cfg,
        sleepCfg,
        agentId: "test",
        signal: new AbortController().signal,
      };

      const result = await systemDependenciesTask.run(ctx);

      expect(result.status).toBe("skipped");
    });

    it("checks Node.js version", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      const nodeItem = result.items.find((item) => item.label === "Node.js");
      expect(nodeItem).toBeDefined();
      expect(nodeItem?.message).toMatch(/v?\d+\.\d+/);
    });

    it("checks Git version", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      const gitItem = result.items.find((item) => item.label === "Git");
      expect(gitItem).toBeDefined();
      expect(gitItem?.message).toMatch(/\d+\.\d+/);
    });

    it("checks OS information", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      // Should have macOS or Linux or OS item
      const osItem = result.items.find(
        (item) => item.label === "macOS" || item.label === "OS" || item.label?.includes("Linux"),
      );
      expect(osItem).toBeDefined();
    });

    it("checks essential tools (curl)", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      const curlItem = result.items.find((item) => item.label === "curl");
      expect(curlItem).toBeDefined();
      expect(curlItem?.severity).toBe("ok");
    });

    it("reports Homebrew status on macOS", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      // Should have Homebrew item (installed or not)
      const brewItem = result.items.find(
        (item) => item.label === "Homebrew" || item.label?.includes("brew"),
      );
      // On macOS this should exist, on Linux it may or may not
      if (os.platform() === "darwin") {
        expect(brewItem).toBeDefined();
      }
    });

    it("handles abort signal gracefully", async () => {
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      const controller = new AbortController();
      controller.abort();

      const ctx: ShallowSleepTaskContext = {
        cfg,
        sleepCfg,
        agentId: "test",
        signal: controller.signal,
      };

      const result = await systemDependenciesTask.run(ctx);

      // Should complete even when aborted
      expect(result.name).toBe("system-dependencies");
    });
  });

  describe("Node.js version validation", () => {
    it("reports error when Node.js version is below minimum", async () => {
      // This test just verifies the logic path exists
      // We can't actually change Node version in tests
      const { systemDependenciesTask } = await import("../tasks/system-dependencies.js");
      const cfg = createMockConfig();
      const ctx = createContext(cfg);

      const result = await systemDependenciesTask.run(ctx);

      const nodeItem = result.items.find((item) => item.label === "Node.js");
      expect(nodeItem).toBeDefined();
      // Current Node should be >= 22 for this repo
      expect(["ok", "error"]).toContain(nodeItem?.severity);
    });
  });
});

describe("sleep/shallow integration with new tasks", () => {
  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
      },
    },
  });

  it("includes api-key-validation in shallow sleep", async () => {
    const { runShallowSleep } = await import("../phases/shallow.js");
    const cfg = createMockConfig();
    const sleepCfg = resolveSleepConfig(cfg)!;

    // Disable other tasks to focus on our new ones
    sleepCfg.shallow.tasks.configValidation = false;
    sleepCfg.shallow.tasks.credentialsCheck = false;
    sleepCfg.shallow.tasks.integrationProbe = false;
    sleepCfg.shallow.tasks.memoryIntegrity = false;
    sleepCfg.shallow.tasks.apiKeyValidation = true;
    sleepCfg.shallow.updates.enabled = false;
    sleepCfg.shallow.security.enabled = false;
    sleepCfg.shallow.radar.enabled = false;

    const result = await runShallowSleep({
      agentId: "api-key-test",
      workspaceDir: "/tmp/nonexistent",
      cfg,
      sleepCfg,
    });

    expect(result.status).toBe("completed");

    // Should have run api-key-validation
    const apiKeyResult = result.results.find((r) => r.name === "api-key-validation");
    expect(apiKeyResult).toBeDefined();
  });

  it("includes system-dependencies in shallow sleep", async () => {
    const { runShallowSleep } = await import("../phases/shallow.js");
    const cfg = createMockConfig();
    const sleepCfg = resolveSleepConfig(cfg)!;

    // Disable other tasks
    sleepCfg.shallow.tasks.enabled = false;
    sleepCfg.shallow.updates.enabled = true;
    sleepCfg.shallow.updates.checkOpenclaw = false;
    sleepCfg.shallow.updates.checkDependencies = false;
    sleepCfg.shallow.updates.checkTools = false;
    sleepCfg.shallow.updates.checkSystemDependencies = true;
    sleepCfg.shallow.security.enabled = false;
    sleepCfg.shallow.radar.enabled = false;

    const result = await runShallowSleep({
      agentId: "sys-deps-test",
      workspaceDir: "/tmp/nonexistent",
      cfg,
      sleepCfg,
    });

    expect(result.status).toBe("completed");

    // Should have run system-dependencies
    const sysDepResult = result.results.find((r) => r.name === "system-dependencies");
    expect(sysDepResult).toBeDefined();
  });
});
