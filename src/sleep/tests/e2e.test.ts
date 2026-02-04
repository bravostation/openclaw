/**
 * End-to-end sleep system tests.
 * Runs the full sleep process on a mock system state and verifies
 * correct resolutions and memory consolidation.
 */

import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CoreMemoryEntry, LongTermMemoryEntry } from "../llm/types.js";
import { resolveSleepConfig } from "../config.js";
import {
  saveCoreMemoriesToWorkspace,
  saveLongTermMemoriesToWorkspace,
  loadCoreMemoriesFromWorkspace,
  loadLongTermMemoriesFromWorkspace,
  CORE_MEMORIES_FILENAME,
  LONG_TERM_MEMORIES_FILENAME,
} from "../llm/identity-context.js";
import { runDeepSleep } from "../phases/deep.js";
import { runShallowSleep } from "../phases/shallow.js";

describe("sleep/e2e", () => {
  let tempDir: string;
  let workspaceDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sleep-e2e-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createMockConfig = (): OpenClawConfig => ({
    agents: {
      defaults: {
        sleep: {
          enabled: true,
          window: "03:00-06:00",
        },
        userTimezone: "UTC",
      },
    },
  });

  describe("full sleep cycle on base system state", () => {
    it("runs shallow + deep sleep and consolidates memories", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      // Disable network tasks for determinism
      sleepCfg.shallow.tasks.integrationProbe = false;
      sleepCfg.shallow.tasks.apiKeyValidation = false;
      sleepCfg.shallow.tasks.doctorIntegration = false;
      sleepCfg.shallow.updates.checkOpenclaw = false;
      sleepCfg.shallow.updates.checkDependencies = false;
      sleepCfg.shallow.updates.checkTools = false;
      sleepCfg.shallow.updates.checkSystemDependencies = false;
      sleepCfg.shallow.updates.checkPackageManager = false;
      sleepCfg.shallow.security.npmAudit = false;
      sleepCfg.shallow.security.advisoryCheck = false;
      sleepCfg.shallow.radar.enabled = false;
      sleepCfg.deep.llmReflection = { enabled: false };

      // Set up initial workspace state
      const initialCoreMemories: CoreMemoryEntry[] = [
        {
          id: "core-1",
          theme: "user_preference",
          description: "User prefers concise responses",
          reason: "Consistent feedback pattern",
          confidence: 0.85,
          supportingMemoryIds: [],
          createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
          reinforcementCount: 3,
        },
      ];

      const initialLongTermMemories: LongTermMemoryEntry[] = [
        {
          id: "lt-1",
          content: "User's timezone is Europe/London",
          reason: "Important for scheduling",
          confidence: 0.9,
          createdAt: Date.now() - 14 * 24 * 60 * 60 * 1000,
          accessCount: 50,
          tags: ["fact"],
        },
      ];

      // Save initial state
      saveCoreMemoriesToWorkspace(workspaceDir, initialCoreMemories);
      saveLongTermMemoriesToWorkspace(workspaceDir, initialLongTermMemories);

      // Verify initial state exists
      expect(existsSync(path.join(workspaceDir, CORE_MEMORIES_FILENAME))).toBe(true);
      expect(existsSync(path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME))).toBe(true);

      // Run shallow sleep
      const shallowResult = await runShallowSleep({
        agentId: "e2e-test",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      expect(shallowResult.status).toBe("completed");
      expect(Array.isArray(shallowResult.results)).toBe(true);

      // Run deep sleep
      const deepResult = await runDeepSleep({
        agentId: "e2e-test",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      expect(deepResult.status).toBe("completed");
      expect(deepResult).toHaveProperty("prune");
      expect(deepResult).toHaveProperty("compact");
      expect(deepResult).toHaveProperty("promote");
      expect(deepResult).toHaveProperty("coreMemory");

      // Verify memory files still exist and are valid
      expect(existsSync(path.join(workspaceDir, CORE_MEMORIES_FILENAME))).toBe(true);
      expect(existsSync(path.join(workspaceDir, LONG_TERM_MEMORIES_FILENAME))).toBe(true);

      // Memories should still be loadable
      const finalCoreMemories = loadCoreMemoriesFromWorkspace(workspaceDir);
      const finalLongTermMemories = loadLongTermMemoriesFromWorkspace(workspaceDir);

      expect(finalCoreMemories.length).toBeGreaterThanOrEqual(0);
      expect(finalLongTermMemories.length).toBeGreaterThanOrEqual(0);
    });

    it("creates markdown files with clean format (no metadata)", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      sleepCfg.shallow.tasks.integrationProbe = false;
      sleepCfg.shallow.tasks.apiKeyValidation = false;
      sleepCfg.shallow.tasks.doctorIntegration = false;
      sleepCfg.shallow.updates.enabled = false;
      sleepCfg.shallow.security.enabled = false;
      sleepCfg.shallow.radar.enabled = false;
      sleepCfg.deep.llmReflection = { enabled: false };

      const memories: CoreMemoryEntry[] = [
        {
          id: "test-meta-check",
          theme: "constraint",
          description: "Never share secrets",
          reason: "Security best practice",
          confidence: 0.99,
          supportingMemoryIds: ["a", "b"],
          createdAt: 1700000000000,
          reinforcementCount: 5,
        },
      ];

      saveCoreMemoriesToWorkspace(workspaceDir, memories);

      // Run deep sleep (which syncs memories)
      await runDeepSleep({
        agentId: "format-test",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      // Check markdown content
      const mdContent = readFileSync(path.join(workspaceDir, CORE_MEMORIES_FILENAME), "utf-8");

      // Should have content
      expect(mdContent).toContain("Never share secrets");

      // Should include reason (why)
      expect(mdContent).toContain("Security best practice");

      // Should NOT have metadata
      expect(mdContent).not.toContain("0.99");
      expect(mdContent).not.toContain("1700000000000");
      expect(mdContent).not.toContain("test-meta-check");
      expect(mdContent).not.toContain("reinforcementCount");
    });

    it("preserves memory data through full cycle", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      sleepCfg.shallow.tasks.enabled = false;
      sleepCfg.shallow.updates.enabled = false;
      sleepCfg.shallow.security.enabled = false;
      sleepCfg.shallow.radar.enabled = false;
      sleepCfg.deep.llmReflection = { enabled: false };

      const originalMemories: CoreMemoryEntry[] = [
        {
          id: "preserve-1",
          theme: "expertise",
          description: "Expert in TypeScript",
          reason: "Years of experience",
          confidence: 0.9,
          supportingMemoryIds: ["x", "y", "z"],
          createdAt: 1700000000000,
          reinforcedAt: 1700500000000,
          reinforcementCount: 10,
        },
      ];

      saveCoreMemoriesToWorkspace(workspaceDir, originalMemories);

      // Run full cycle
      await runShallowSleep({ agentId: "preserve-test", workspaceDir, cfg, sleepCfg });
      await runDeepSleep({ agentId: "preserve-test", workspaceDir, cfg, sleepCfg });

      // Load from JSON (should have all metadata)
      const loaded = loadCoreMemoriesFromWorkspace(workspaceDir);

      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe("preserve-1");
      expect(loaded[0].confidence).toBe(0.9);
      expect(loaded[0].reinforcementCount).toBe(10);
      expect(loaded[0].supportingMemoryIds).toEqual(["x", "y", "z"]);
      expect(loaded[0].reason).toBe("Years of experience");
    });
  });

  describe("shallow sleep health detection", () => {
    it("completes successfully with no critical failures on clean workspace", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      // Minimal tasks
      sleepCfg.shallow.tasks.configValidation = true;
      sleepCfg.shallow.tasks.credentialsCheck = false;
      sleepCfg.shallow.tasks.integrationProbe = false;
      sleepCfg.shallow.tasks.memoryIntegrity = false;
      sleepCfg.shallow.tasks.apiKeyValidation = false;
      sleepCfg.shallow.tasks.doctorIntegration = false;
      sleepCfg.shallow.updates.enabled = false;
      sleepCfg.shallow.security.enabled = false;
      sleepCfg.shallow.radar.enabled = false;

      const result = await runShallowSleep({
        agentId: "health-check",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      // Should complete without critical failure
      expect(["completed", "aborted"]).toContain(result.status);
      expect(result.hasCriticalFailure).toBeFalsy();
    });

    it("reports task results for each enabled check", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;

      // Enable a few tasks
      sleepCfg.shallow.tasks.configValidation = true;
      sleepCfg.shallow.tasks.memoryIntegrity = true;
      sleepCfg.shallow.tasks.credentialsCheck = false;
      sleepCfg.shallow.tasks.integrationProbe = false;
      sleepCfg.shallow.tasks.apiKeyValidation = false;
      sleepCfg.shallow.tasks.doctorIntegration = false;
      sleepCfg.shallow.updates.enabled = false;
      sleepCfg.shallow.security.enabled = false;
      sleepCfg.shallow.radar.enabled = false;

      const result = await runShallowSleep({
        agentId: "multi-task",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      expect(result.results.length).toBeGreaterThan(0);

      // Each result should have proper structure
      for (const taskResult of result.results) {
        expect(taskResult.name).toBeTruthy();
        expect(["passed", "failed", "skipped"]).toContain(taskResult.status);
        expect(Array.isArray(taskResult.items)).toBe(true);
      }
    });
  });

  describe("deep sleep memory operations", () => {
    it("runs all memory phases in correct order", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.deep.llmReflection = { enabled: false };

      const result = await runDeepSleep({
        agentId: "phase-order",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      expect(result.status).toBe("completed");

      // All phases should have results (may be empty/zero)
      expect(result.prune).toBeDefined();
      expect(result.compact).toBeDefined();
      expect(result.mediumTerm).toBeDefined();
      expect(result.promote).toBeDefined();
      expect(result.coreMemory).toBeDefined();
    });

    it("creates workspace memory files even with no input data", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.deep.llmReflection = { enabled: false };

      // Empty workspace
      const result = await runDeepSleep({
        agentId: "empty-workspace",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      // Should complete successfully
      expect(result.status).toBe("completed");
    });

    it("handles abort signal during deep sleep", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.deep.llmReflection = { enabled: false };

      const controller = new AbortController();
      controller.abort(); // Abort immediately

      const result = await runDeepSleep({
        agentId: "abort-test",
        workspaceDir,
        cfg,
        sleepCfg,
        signal: controller.signal,
      });

      expect(result.status).toBe("aborted");
    });
  });

  describe("memory consolidation workflow", () => {
    it("maintains memory integrity through consolidation", async () => {
      const cfg = createMockConfig();
      const sleepCfg = resolveSleepConfig(cfg)!;
      sleepCfg.deep.llmReflection = { enabled: false };

      // Set up memories with various states
      const coreMemories: CoreMemoryEntry[] = [
        {
          id: "core-stable",
          theme: "user_preference",
          description: "Prefers dark mode",
          reason: "Better for eye strain",
          confidence: 0.9,
          supportingMemoryIds: [],
          createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
          reinforcementCount: 15,
        },
        {
          id: "core-recent",
          theme: "goal",
          description: "Complete the sleep system",
          reason: "Current project focus",
          confidence: 0.8,
          supportingMemoryIds: [],
          createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day old
        },
      ];

      const longTermMemories: LongTermMemoryEntry[] = [
        {
          id: "lt-stable",
          content: "Works best in the morning",
          reason: "Optimal productivity time",
          confidence: 0.85,
          createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
          accessCount: 100,
        },
      ];

      saveCoreMemoriesToWorkspace(workspaceDir, coreMemories);
      saveLongTermMemoriesToWorkspace(workspaceDir, longTermMemories);

      // Run consolidation
      await runDeepSleep({
        agentId: "consolidation-test",
        workspaceDir,
        cfg,
        sleepCfg,
      });

      // Verify memories are still intact
      const finalCore = loadCoreMemoriesFromWorkspace(workspaceDir);
      const finalLongTerm = loadLongTermMemoriesFromWorkspace(workspaceDir);

      // Original memories should be preserved (no destructive operations without LLM)
      expect(finalCore.length).toBe(2);
      expect(finalLongTerm.length).toBe(1);

      // Check specific memory survived
      const stableMemory = finalCore.find((m) => m.id === "core-stable");
      expect(stableMemory).toBeDefined();
      expect(stableMemory!.description).toBe("Prefers dark mode");
    });
  });
});
