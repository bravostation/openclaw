import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { resolveSleepConfig } from "../config.js";
import type { ShallowSleepTaskContext } from "./types.js";
import {
  createTaskResult,
  createSkippedResult,
  okItem,
  warningItem,
  errorItem,
  infoItem,
  criticalItem,
} from "./types.js";

describe("sleep/tasks/types", () => {
  describe("createTaskResult", () => {
    it("creates a passed result when no errors", () => {
      const result = createTaskResult({
        name: "test-task",
        critical: false,
        startMs: Date.now() - 100,
        items: [okItem("Check passed")],
      });

      expect(result.name).toBe("test-task");
      expect(result.status).toBe("passed");
      expect(result.critical).toBe(false);
      expect(result.items).toHaveLength(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("creates a failed result when error is provided", () => {
      const result = createTaskResult({
        name: "test-task",
        critical: true,
        startMs: Date.now(),
        items: [],
        error: "Something went wrong",
      });

      expect(result.status).toBe("failed");
      expect(result.critical).toBe(true);
      expect(result.error).toBe("Something went wrong");
    });

    it("creates a failed result when items contain errors", () => {
      const result = createTaskResult({
        name: "test-task",
        critical: false,
        startMs: Date.now(),
        items: [okItem("First check"), errorItem("Second check failed")],
      });

      expect(result.status).toBe("failed");
    });

    it("creates a failed result when items contain critical issues", () => {
      const result = createTaskResult({
        name: "test-task",
        critical: false,
        startMs: Date.now(),
        items: [okItem("First check"), criticalItem("Critical issue!")],
      });

      expect(result.status).toBe("failed");
    });
  });

  describe("createSkippedResult", () => {
    it("creates a skipped result", () => {
      const result = createSkippedResult("disabled-task", "Task is disabled");

      expect(result.name).toBe("disabled-task");
      expect(result.status).toBe("skipped");
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item?.label).toBe("Skipped");
      expect(item?.message).toBe("Task is disabled");
      expect(result.durationMs).toBe(0);
    });
  });

  describe("item helpers", () => {
    it("okItem creates ok severity", () => {
      const item = okItem("Test label", "Test message");
      expect(item.severity).toBe("ok");
      expect(item.label).toBe("Test label");
      expect(item.message).toBe("Test message");
    });

    it("infoItem creates info severity", () => {
      const item = infoItem("Info label");
      expect(item.severity).toBe("info");
      expect(item.label).toBe("Info label");
    });

    it("warningItem creates warning severity", () => {
      const item = warningItem("Warning label", "Warning message");
      expect(item.severity).toBe("warning");
      expect(item.label).toBe("Warning label");
    });

    it("errorItem creates error severity", () => {
      const item = errorItem("Error label");
      expect(item.severity).toBe("error");
    });

    it("criticalItem creates critical severity", () => {
      const item = criticalItem("Critical label");
      expect(item.severity).toBe("critical");
    });
  });
});

describe("sleep/tasks", () => {
  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: { enabled: true, window: "03:00-06:00" },
        userTimezone: "UTC",
      },
    },
  });

  const createMockContext = (): ShallowSleepTaskContext => {
    const cfg = createMockConfig();
    const sleepCfg = resolveSleepConfig(cfg)!;
    return {
      cfg,
      sleepCfg,
      agentId: "test-agent",
      signal: new AbortController().signal,
    };
  };

  describe("configValidationTask", () => {
    it("runs without crashing", async () => {
      const { configValidationTask } = await import("./config-validation.js");
      const ctx = createMockContext();

      // This will fail because config file doesn't exist in test, but shouldn't crash
      const result = await configValidationTask.run(ctx);

      expect(result.name).toBe("config-validation");
      expect(["passed", "failed"]).toContain(result.status);
    });
  });

  describe("credentialsCheckTask", () => {
    it("runs without crashing", async () => {
      const { credentialsCheckTask } = await import("./credentials-check.js");
      const ctx = createMockContext();

      const result = await credentialsCheckTask.run(ctx);

      expect(result.name).toBe("credentials-check");
      // May pass or fail depending on environment
      expect(["passed", "failed"]).toContain(result.status);
    });
  });

  describe("integrationProbeTask", () => {
    it("runs without crashing", async () => {
      const { integrationProbeTask } = await import("./integration-probe.js");
      const ctx = createMockContext();

      const result = await integrationProbeTask.run(ctx);

      expect(result.name).toBe("integration-probe");
      expect(["passed", "failed"]).toContain(result.status);
    });
  });

  describe("memoryIntegrityTask", () => {
    it("runs without crashing", async () => {
      const { memoryIntegrityTask } = await import("./memory-integrity.js");
      const ctx = createMockContext();

      const result = await memoryIntegrityTask.run(ctx);

      expect(result.name).toBe("memory-integrity");
      expect(["passed", "failed"]).toContain(result.status);
    });
  });

  describe("updateCheckTask", () => {
    it("runs without crashing", async () => {
      const { updateCheckTask } = await import("./update-check.js");
      const ctx = createMockContext();

      const result = await updateCheckTask.run(ctx);

      expect(result.name).toBe("update-check");
      expect(["passed", "failed", "skipped"]).toContain(result.status);
    });
  });

  describe("securityScanTask", () => {
    it("runs without crashing", async () => {
      const { securityScanTask } = await import("./security-scan.js");
      const ctx = createMockContext();

      const result = await securityScanTask.run(ctx);

      expect(result.name).toBe("security-scan");
      expect(["passed", "failed", "skipped"]).toContain(result.status);
    });
  });

  describe("developmentRadarTask", () => {
    it("runs without crashing", async () => {
      const { developmentRadarTask } = await import("./development-radar.js");
      const ctx = createMockContext();

      const result = await developmentRadarTask.run(ctx);

      expect(result.name).toBe("development-radar");
      expect(["passed", "failed", "skipped"]).toContain(result.status);
    });
  });
});
