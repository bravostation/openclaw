import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ResolvedSleepDeepConfig } from "../config.js";
import {
  resolveAgentDirForSleep,
  resolveMemoryDbPath,
  resolveSessionsDir,
  resolveCoreMemoriesPath,
  resolveLongTermMemoriesPath,
  resolveMediumTermMemoriesPath,
} from "./utils.js";

describe("sleep/memory/utils", () => {
  describe("resolveAgentDirForSleep", () => {
    it("returns correct path for agent", () => {
      const result = resolveAgentDirForSleep("test-agent");
      expect(result).toContain("agents");
      expect(result).toContain("test-agent");
      expect(result).toContain("agent");
    });

    it("normalizes agent ID", () => {
      const result = resolveAgentDirForSleep("Test Agent!");
      expect(result).toContain("test-agent-");
    });
  });

  describe("resolveMemoryDbPath", () => {
    it("returns sqlite path in memory directory", () => {
      const result = resolveMemoryDbPath("test");
      expect(result).toContain("memory");
      expect(result).toContain("test.sqlite");
    });
  });

  describe("resolveSessionsDir", () => {
    it("returns sessions directory", () => {
      const result = resolveSessionsDir("test");
      expect(result).toContain("sessions");
    });
  });

  describe("resolveCoreMemoriesPath", () => {
    it("returns core memories JSON path", () => {
      const result = resolveCoreMemoriesPath("test");
      expect(result).toContain("core-memories.json");
    });
  });

  describe("resolveLongTermMemoriesPath", () => {
    it("returns long-term memories JSON path", () => {
      const result = resolveLongTermMemoriesPath("test");
      expect(result).toContain("long-term-memories.json");
    });
  });

  describe("resolveMediumTermMemoriesPath", () => {
    it("returns medium-term memories JSON path", () => {
      const result = resolveMediumTermMemoriesPath("test");
      expect(result).toContain("medium-term-memories.json");
    });
  });
});

describe("sleep/memory/pruner", () => {
  let tempDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sleep-test-"));
    agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("pruneMemories returns early when disabled", async () => {
    const { pruneMemories } = await import("./pruner.js");

    const deepCfg: ResolvedSleepDeepConfig = {
      enabled: true,
      memoryPruning: { enabled: false, maxAgeHours: 168, decayFactor: 0.1 },
      memoryCompaction: { enabled: false, minChunks: 100 },
      memoryPromotion: {
        enabled: false,
        minReinforcementsForLongTerm: 3,
        minConfidenceForLongTerm: 0.7,
      },
      coreMemory: { enabled: false, minRecurrence: 3, minConfidence: 0.7 },
    };

    const result = await pruneMemories({
      agentId: "test",
      deepCfg,
    });

    expect(result.chunksPruned).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});

describe("sleep/memory/compactor", () => {
  it("compactMemories returns early when disabled", async () => {
    const { compactMemories } = await import("./compactor.js");

    const deepCfg: ResolvedSleepDeepConfig = {
      enabled: true,
      memoryPruning: { enabled: false, maxAgeHours: 168, decayFactor: 0.1 },
      memoryCompaction: { enabled: false, minChunks: 100 },
      memoryPromotion: {
        enabled: false,
        minReinforcementsForLongTerm: 3,
        minConfidenceForLongTerm: 0.7,
      },
      coreMemory: { enabled: false, minRecurrence: 3, minConfidence: 0.7 },
    };

    const result = await compactMemories({
      agentId: "test",
      deepCfg,
    });

    expect(result.chunksCompacted).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});

describe("sleep/memory/medium-term", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sleep-medium-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("getMediumTermMemories returns empty array when file missing", async () => {
    const { getMediumTermMemories } = await import("./medium-term.js");
    const memories = await getMediumTermMemories("nonexistent-agent");
    expect(memories).toEqual([]);
  });

  it("getLongTermMemories returns empty array when file missing", async () => {
    const { getLongTermMemories } = await import("./medium-term.js");
    const memories = await getLongTermMemories("nonexistent-agent");
    expect(memories).toEqual([]);
  });

  it("searchMediumTermMemories returns empty for no matches", async () => {
    const { searchMediumTermMemories } = await import("./medium-term.js");
    const results = await searchMediumTermMemories("nonexistent-agent", "test query");
    expect(results).toEqual([]);
  });
});

describe("sleep/memory/core-memory", () => {
  it("getCoreMemories returns empty array when file missing", async () => {
    const { getCoreMemories } = await import("./core-memory.js");
    const memories = await getCoreMemories("nonexistent-agent");
    expect(memories).toEqual([]);
  });

  it("extractCoreMemories returns early when disabled", async () => {
    const { extractCoreMemories } = await import("./core-memory.js");

    const deepCfg: ResolvedSleepDeepConfig = {
      enabled: true,
      memoryPruning: { enabled: false, maxAgeHours: 168, decayFactor: 0.1 },
      memoryCompaction: { enabled: false, minChunks: 100 },
      memoryPromotion: {
        enabled: false,
        minReinforcementsForLongTerm: 3,
        minConfidenceForLongTerm: 0.7,
      },
      coreMemory: { enabled: false, minRecurrence: 3, minConfidence: 0.7 },
    };

    const result = await extractCoreMemories({
      agentId: "test",
      deepCfg,
    });

    expect(result.newMemoriesCreated).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});
