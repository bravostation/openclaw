/**
 * Tests for memory JSON to Markdown conversion.
 * Verifies that memories with dates, frequencies, confidences are
 * correctly converted to clean markdown with "why" explanations.
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
  CORE_MEMORIES_FILENAME,
  LONG_TERM_MEMORIES_FILENAME,
} from "../llm/identity-context.js";

describe("sleep/memory-conversion", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-conversion-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("core memories with full metadata → clean markdown", () => {
    it("converts memories with dates, confidence, reinforcement to single-line entries", () => {
      const memories: CoreMemoryEntry[] = [
        {
          id: "core-security-001",
          theme: "constraint",
          description: "Never log or expose API keys in output",
          reason: "Learned after accidentally exposing a key in March 2025",
          confidence: 0.98,
          supportingMemoryIds: ["mem-001", "mem-002", "mem-003"],
          createdAt: Date.parse("2025-03-15T10:30:00Z"),
          reinforcedAt: Date.parse("2026-01-20T14:00:00Z"),
          reinforcementCount: 12,
        },
        {
          id: "core-style-002",
          theme: "user_preference",
          description: "User prefers TypeScript over JavaScript",
          reason: "Consistent pattern across 47 interactions",
          confidence: 0.92,
          supportingMemoryIds: ["mem-010", "mem-011"],
          createdAt: Date.parse("2025-06-01T09:00:00Z"),
          reinforcementCount: 47,
        },
      ];

      saveCoreMemoriesToWorkspace(tempDir, memories);

      const mdPath = path.join(tempDir, CORE_MEMORIES_FILENAME);
      expect(existsSync(mdPath)).toBe(true);

      const content = readFileSync(mdPath, "utf-8");

      // Should include descriptions
      expect(content).toContain("Never log or expose API keys in output");
      expect(content).toContain("User prefers TypeScript over JavaScript");

      // Should include theme labels
      expect(content).toContain("**Constraint:**");
      expect(content).toContain("**Preference:**");

      // Should include WHY (reason) in italics
      expect(content).toContain("*Learned after accidentally exposing a key in March 2025*");
      expect(content).toContain("*Consistent pattern across 47 interactions*");

      // Should NOT include raw metadata
      expect(content).not.toContain("0.98");
      expect(content).not.toContain("0.92");
      expect(content).not.toContain("confidence");
      expect(content).not.toContain("reinforcementCount");
      expect(content).not.toContain("2025-03-15");
      expect(content).not.toContain("core-security-001");
      expect(content).not.toContain("mem-001");
    });

    it("handles memories without reason (falls back to theme only)", () => {
      const memories: CoreMemoryEntry[] = [
        {
          id: "core-old-001",
          theme: "expertise",
          description: "Experienced with React and Node.js",
          confidence: 0.85,
          supportingMemoryIds: [],
          createdAt: Date.now(),
        },
      ];

      saveCoreMemoriesToWorkspace(tempDir, memories);

      const content = readFileSync(path.join(tempDir, CORE_MEMORIES_FILENAME), "utf-8");

      // Should have theme but no reason section
      expect(content).toContain("**Expertise:** Experienced with React and Node.js");
      // Should not have italic text (reason in *italics*) - only bold **theme** is allowed
      // Check for the italic pattern: text between single asterisks that isn't bold
      const lines = content.split("\n").filter((l) => l.startsWith("- "));
      // Italic would show as " — *reason*" at the end
      expect(lines[0]).not.toContain(" — *");
    });

    it("produces valid single-line entries (no embedded newlines)", () => {
      const memories: CoreMemoryEntry[] = [
        {
          id: "test-1",
          theme: "goal",
          description: "Build a comprehensive test suite",
          reason: "Quality is paramount for production systems",
          confidence: 0.9,
          supportingMemoryIds: [],
          createdAt: Date.now(),
        },
      ];

      saveCoreMemoriesToWorkspace(tempDir, memories);

      const content = readFileSync(path.join(tempDir, CORE_MEMORIES_FILENAME), "utf-8");
      const lines = content.split("\n").filter((l) => l.startsWith("- "));

      // Each memory should be a single line
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\n");
    });
  });

  describe("long-term memories with full metadata → clean markdown", () => {
    it("converts memories with accessCount, confidence, tags to single-line entries", () => {
      const memories: LongTermMemoryEntry[] = [
        {
          id: "lt-tz-001",
          content: "User's timezone is Europe/London (GMT/BST)",
          reason: "Essential for scheduling and time-aware responses",
          confidence: 0.95,
          createdAt: Date.parse("2025-01-10T12:00:00Z"),
          accessCount: 234,
          tags: ["fact", "user_context"],
        },
        {
          id: "lt-repo-002",
          content:
            "# Main Repository\n\nThe primary codebase is at github.com/openclaw/openclaw\n\nUses TypeScript and pnpm.",
          reason: "Central to all development work",
          confidence: 0.99,
          createdAt: Date.parse("2025-02-15T08:00:00Z"),
          accessCount: 567,
          tags: ["preference", "project"],
        },
      ];

      saveLongTermMemoriesToWorkspace(tempDir, memories);

      const mdPath = path.join(tempDir, LONG_TERM_MEMORIES_FILENAME);
      expect(existsSync(mdPath)).toBe(true);

      const content = readFileSync(mdPath, "utf-8");

      // Should include first meaningful line of content
      expect(content).toContain("User's timezone is Europe/London (GMT/BST)");
      expect(content).toContain("The primary codebase is at github.com/openclaw/openclaw");

      // Should include reason in italics
      expect(content).toContain("*Essential for scheduling and time-aware responses*");
      expect(content).toContain("*Central to all development work*");

      // Should NOT include raw metadata
      expect(content).not.toContain("234");
      expect(content).not.toContain("567");
      expect(content).not.toContain("accessCount");
      expect(content).not.toContain("confidence");
      expect(content).not.toContain("lt-tz-001");
    });

    it("extracts first meaningful line from multi-line content (skips headers)", () => {
      const memories: LongTermMemoryEntry[] = [
        {
          id: "lt-multiline",
          content:
            "# Project Config\n\n## Key Points\n\nThe project uses pnpm for package management",
          confidence: 0.9,
          createdAt: Date.now(),
          accessCount: 10,
        },
      ];

      saveLongTermMemoriesToWorkspace(tempDir, memories);

      const content = readFileSync(path.join(tempDir, LONG_TERM_MEMORIES_FILENAME), "utf-8");

      // Should extract "The project uses pnpm..." not headers
      expect(content).toContain("The project uses pnpm for package management");
      expect(content).not.toContain("# Project Config");
      expect(content).not.toContain("## Key Points");
    });

    it("uses tag label for non-fact entries", () => {
      const memories: LongTermMemoryEntry[] = [
        {
          id: "lt-pref",
          content: "Always use strict TypeScript settings",
          confidence: 0.85,
          createdAt: Date.now(),
          accessCount: 5,
          tags: ["preference"],
        },
        {
          id: "lt-fact",
          content: "Node.js 22 is the minimum version",
          confidence: 0.9,
          createdAt: Date.now(),
          accessCount: 3,
          tags: ["fact"],
        },
      ];

      saveLongTermMemoriesToWorkspace(tempDir, memories);

      const content = readFileSync(path.join(tempDir, LONG_TERM_MEMORIES_FILENAME), "utf-8");

      // Preference should have label
      expect(content).toContain("**Preference:** Always use strict TypeScript settings");

      // Facts don't get special label (already factual)
      expect(content).toContain("- Node.js 22 is the minimum version");
      expect(content).not.toContain("**Fact:**");
    });

    it("truncates very long content to ~120 chars", () => {
      const longContent =
        "This is an extremely long memory content that goes on and on with lots of details about various things that probably should not all be included in a single line because that would make the markdown file very hard to read and the context window would be bloated with unnecessary verbosity.";

      const memories: LongTermMemoryEntry[] = [
        {
          id: "lt-long",
          content: longContent,
          confidence: 0.8,
          createdAt: Date.now(),
          accessCount: 1,
        },
      ];

      saveLongTermMemoriesToWorkspace(tempDir, memories);

      const content = readFileSync(path.join(tempDir, LONG_TERM_MEMORIES_FILENAME), "utf-8");
      const lines = content.split("\n").filter((l) => l.startsWith("- "));

      // Should be truncated with ellipsis
      expect(lines[0]).toContain("...");
      expect(lines[0]?.length ?? 0).toBeLessThan(200); // Generous but finite
    });
  });

  describe("JSON preservation", () => {
    it("preserves all metadata in JSON file while MD is clean", () => {
      const memories: CoreMemoryEntry[] = [
        {
          id: "preserve-test",
          theme: "behavioral_pattern",
          description: "Always verify before destructive operations",
          reason: "Critical safety pattern",
          confidence: 0.95,
          supportingMemoryIds: ["a", "b", "c"],
          createdAt: 1700000000000,
          reinforcedAt: 1700500000000,
          reinforcementCount: 8,
        },
      ];

      saveCoreMemoriesToWorkspace(tempDir, memories);

      // JSON should have everything
      const jsonPath = path.join(tempDir, "memory", "memories-core.json");
      const jsonContent = JSON.parse(readFileSync(jsonPath, "utf-8"));

      expect(jsonContent[0].id).toBe("preserve-test");
      expect(jsonContent[0].confidence).toBe(0.95);
      expect(jsonContent[0].reinforcementCount).toBe(8);
      expect(jsonContent[0].supportingMemoryIds).toEqual(["a", "b", "c"]);
      expect(jsonContent[0].createdAt).toBe(1700000000000);
      expect(jsonContent[0].reason).toBe("Critical safety pattern");

      // MD should be clean
      const mdContent = readFileSync(path.join(tempDir, CORE_MEMORIES_FILENAME), "utf-8");
      expect(mdContent).not.toContain("1700000000000");
      expect(mdContent).not.toContain("preserve-test");
    });
  });
});
