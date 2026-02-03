import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORIES_CORE_FILENAME,
  DEFAULT_MEMORIES_LONG_FILENAME,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

describe("loadWorkspaceBootstrapFiles", () => {
  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("memory");
  });

  it("includes memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("alt");
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(0);
  });

  it("includes MEMORIES-CORE.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: "MEMORIES-CORE.md",
      content: "# Core Memories\nIdentity patterns",
    });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const coreEntry = files.find((f) => f.name === DEFAULT_MEMORIES_CORE_FILENAME);

    expect(coreEntry).toBeDefined();
    expect(coreEntry?.missing).toBe(false);
    expect(coreEntry?.content).toContain("Core Memories");
  });

  it("includes MEMORIES-LONG.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: "MEMORIES-LONG.md",
      content: "# Long-Term Memories\nStable facts",
    });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const longEntry = files.find((f) => f.name === DEFAULT_MEMORIES_LONG_FILENAME);

    expect(longEntry).toBeDefined();
    expect(longEntry?.missing).toBe(false);
    expect(longEntry?.content).toContain("Long-Term Memories");
  });

  it("omits memory tier files when not present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const tierFiles = files.filter((f) =>
      [DEFAULT_MEMORIES_CORE_FILENAME, DEFAULT_MEMORIES_LONG_FILENAME].includes(f.name),
    );

    expect(tierFiles).toHaveLength(0);
  });
});
