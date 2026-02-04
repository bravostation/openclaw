/**
 * Tests for workspace memory file synchronization.
 * Verifies that memory tiers are correctly written to both
 * clean markdown (for context) and JSON (for processing).
 */

import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { CoreMemoryEntry, LongTermMemoryEntry } from "../llm/types.js";
import {
  saveCoreMemoriesToWorkspace,
  saveLongTermMemoriesToWorkspace,
  loadCoreMemoriesFromWorkspace,
  loadLongTermMemoriesFromWorkspace,
  CORE_MEMORIES_FILENAME,
  CORE_MEMORIES_JSON_FILENAME,
  LONG_TERM_MEMORIES_FILENAME,
  LONG_TERM_MEMORIES_JSON_FILENAME,
} from "../llm/identity-context.js";

describe("sleep/workspace-sync", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sleep-workspace-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("saveCoreMemoriesToWorkspace", () => {
    const sampleCoreMemories: CoreMemoryEntry[] = [
      {
        id: "core-1",
        theme: "user_preference",
        description: "User prefers concise responses",
        confidence: 0.95,
        supportingMemoryIds: ["mem-1", "mem-2"],
        createdAt: 1700000000000,
        reinforcedAt: 1700100000000,
        reinforcementCount: 5,
      },
      {
        id: "core-2",
        theme: "user_values",
        description: "User values privacy and security",
        confidence: 0.88,
        supportingMemoryIds: [],
        createdAt: 1700000000000,
      },
      {
        id: "core-3",
        theme: "constraint",
        description: "Never share credentials in logs",
        confidence: 1.0,
        supportingMemoryIds: ["mem-3"],
        createdAt: 1700000000000,
        reinforcementCount: 10,
      },
    ];

    it("creates clean markdown file with single-line entries", () => {
      saveCoreMemoriesToWorkspace(tempDir, sampleCoreMemories);

      const mdPath = path.join(tempDir, CORE_MEMORIES_FILENAME);
      expect(existsSync(mdPath)).toBe(true);

      const content = readFileSync(mdPath, "utf-8");

      // Check header
      expect(content).toContain("# Core Memories");
      expect(content).toContain("Identity-shaping");

      // Check entries are single-line with theme labels
      expect(content).toContain("- **Preference:** User prefers concise responses");
      expect(content).toContain("- **Value:** User values privacy and security");
      expect(content).toContain("- **Constraint:** Never share credentials in logs");

      // Verify NO metadata in markdown
      expect(content).not.toContain("confidence");
      expect(content).not.toContain("0.95");
      expect(content).not.toContain("createdAt");
      expect(content).not.toContain("reinforcement");
      expect(content).not.toContain("core-1");
    });

    it("creates JSON file with full metadata", () => {
      saveCoreMemoriesToWorkspace(tempDir, sampleCoreMemories);

      const jsonPath = path.join(tempDir, CORE_MEMORIES_JSON_FILENAME);
      expect(existsSync(jsonPath)).toBe(true);

      const content = JSON.parse(readFileSync(jsonPath, "utf-8"));
      expect(content).toHaveLength(3);

      // Check first entry has all metadata
      expect(content[0].id).toBe("core-1");
      expect(content[0].theme).toBe("user_preference");
      expect(content[0].confidence).toBe(0.95);
      expect(content[0].reinforcementCount).toBe(5);
      expect(content[0].supportingMemoryIds).toEqual(["mem-1", "mem-2"]);
    });

    it("creates memory directory if it does not exist", () => {
      const nestedDir = path.join(tempDir, "nested", "workspace");
      saveCoreMemoriesToWorkspace(nestedDir, sampleCoreMemories);

      expect(existsSync(path.join(nestedDir, CORE_MEMORIES_FILENAME))).toBe(true);
      expect(existsSync(path.join(nestedDir, CORE_MEMORIES_JSON_FILENAME))).toBe(true);
    });
  });

  describe("saveLongTermMemoriesToWorkspace", () => {
    const sampleLongTermMemories: LongTermMemoryEntry[] = [
      {
        id: "lt-1",
        content: "User's timezone is Europe/London",
        confidence: 0.9,
        createdAt: 1700000000000,
        accessCount: 10,
        tags: ["fact"],
      },
      {
        id: "lt-2",
        content: "# Project Setup\n\nThe main repo is at github.com/example/project",
        confidence: 0.85,
        createdAt: 1700000000000,
        accessCount: 5,
        tags: ["preference"],
      },
      {
        id: "lt-3",
        content: "User prefers vim keybindings",
        confidence: 0.75,
        createdAt: 1700000000000,
        accessCount: 3,
      },
    ];

    it("creates clean markdown file with single-line entries", () => {
      saveLongTermMemoriesToWorkspace(tempDir, sampleLongTermMemories);

      const mdPath = path.join(tempDir, LONG_TERM_MEMORIES_FILENAME);
      expect(existsSync(mdPath)).toBe(true);

      const content = readFileSync(mdPath, "utf-8");

      // Check header
      expect(content).toContain("# Long-Term Memories");
      expect(content).toContain("Stable facts");

      // Check entries - first meaningful line extracted
      expect(content).toContain("- User's timezone is Europe/London");
      expect(content).toContain("- **Preference:**"); // Has tag
      expect(content).toContain("- User prefers vim keybindings"); // No tag

      // Verify NO metadata in markdown
      expect(content).not.toContain("confidence");
      expect(content).not.toContain("0.9");
      expect(content).not.toContain("accessCount");
      expect(content).not.toContain("lt-1");
    });

    it("creates JSON file with full metadata", () => {
      saveLongTermMemoriesToWorkspace(tempDir, sampleLongTermMemories);

      const jsonPath = path.join(tempDir, LONG_TERM_MEMORIES_JSON_FILENAME);
      expect(existsSync(jsonPath)).toBe(true);

      const content = JSON.parse(readFileSync(jsonPath, "utf-8"));
      expect(content).toHaveLength(3);

      expect(content[0].id).toBe("lt-1");
      expect(content[0].confidence).toBe(0.9);
      expect(content[0].accessCount).toBe(10);
      expect(content[0].tags).toEqual(["fact"]);
    });

    it("extracts first meaningful line from multi-line content", () => {
      saveLongTermMemoriesToWorkspace(tempDir, sampleLongTermMemories);

      const mdPath = path.join(tempDir, LONG_TERM_MEMORIES_FILENAME);
      const content = readFileSync(mdPath, "utf-8");

      // Should extract "The main repo..." not "# Project Setup"
      expect(content).toContain("The main repo is at github.com/example/project");
      expect(content).not.toContain("# Project Setup");
    });
  });

  describe("loadCoreMemoriesFromWorkspace", () => {
    it("loads from JSON when available", async () => {
      const memories: CoreMemoryEntry[] = [
        {
          id: "core-test",
          theme: "user_preference",
          description: "Test memory",
          confidence: 0.9,
          supportingMemoryIds: [],
          createdAt: Date.now(),
        },
      ];
      saveCoreMemoriesToWorkspace(tempDir, memories);

      const loaded = loadCoreMemoriesFromWorkspace(tempDir);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("core-test");
      expect(loaded[0].confidence).toBe(0.9);
    });

    it("returns empty array when no files exist", () => {
      const loaded = loadCoreMemoriesFromWorkspace(tempDir);
      expect(loaded).toEqual([]);
    });
  });

  describe("loadLongTermMemoriesFromWorkspace", () => {
    it("loads from JSON when available", async () => {
      const memories: LongTermMemoryEntry[] = [
        {
          id: "lt-test",
          content: "Test long-term memory",
          confidence: 0.85,
          createdAt: Date.now(),
          accessCount: 3,
        },
      ];
      saveLongTermMemoriesToWorkspace(tempDir, memories);

      const loaded = loadLongTermMemoriesFromWorkspace(tempDir);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("lt-test");
      expect(loaded[0].accessCount).toBe(3);
    });

    it("returns empty array when no files exist", () => {
      const loaded = loadLongTermMemoriesFromWorkspace(tempDir);
      expect(loaded).toEqual([]);
    });
  });

  describe("round-trip integrity", () => {
    it("preserves all data through save/load cycle", () => {
      const original: CoreMemoryEntry[] = [
        {
          id: "core-roundtrip",
          theme: "expertise",
          description: "Expert in TypeScript and Node.js",
          confidence: 0.92,
          supportingMemoryIds: ["s1", "s2", "s3"],
          createdAt: 1700000000000,
          reinforcedAt: 1700500000000,
          reinforcementCount: 7,
        },
      ];

      saveCoreMemoriesToWorkspace(tempDir, original);
      const loaded = loadCoreMemoriesFromWorkspace(tempDir);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(original[0]);
    });
  });
});
