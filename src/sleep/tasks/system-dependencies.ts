/**
 * System dependencies check task: verifies brew packages, OS version, and other dependencies.
 *
 * Checks:
 * - Homebrew packages that may be outdated
 * - macOS/OS version and available updates
 * - Node.js version compatibility
 * - Git version
 * - Other CLI tools the system depends on
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import {
  createTaskResult,
  okItem,
  warningItem,
  errorItem,
  infoItem,
  createSkippedResult,
} from "./types.js";

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 30_000;

// Minimum versions for key dependencies
const MIN_NODE_VERSION = 22;
const MIN_GIT_VERSION = "2.30.0";

type BrewOutdated = {
  name: string;
  installed_versions: string[];
  current_version: string;
  pinned: boolean;
};

async function runCommand(
  command: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const result = await execAsync(command, { timeout: timeoutMs });
    return result;
  } catch {
    return null;
  }
}

function parseVersion(versionStr: string): number[] {
  const match = versionStr.match(/(\d+)\.(\d+)\.?(\d+)?/);
  if (!match) return [0, 0, 0];
  return [
    parseInt(match[1] ?? "0", 10),
    parseInt(match[2] ?? "0", 10),
    parseInt(match[3] ?? "0", 10),
  ];
}

function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);

  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

async function checkBrewOutdated(signal: AbortSignal): Promise<TaskResult["items"]> {
  const items: TaskResult["items"] = [];

  // Check if brew is available
  const brewCheck = await runCommand("which brew");
  if (!brewCheck?.stdout.trim()) {
    items.push(infoItem("Homebrew", "Not installed"));
    return items;
  }

  if (signal.aborted) return items;

  // Get outdated packages
  const outdatedResult = await runCommand("brew outdated --json 2>/dev/null");
  if (!outdatedResult?.stdout.trim()) {
    items.push(okItem("Homebrew", "All packages up to date"));
    return items;
  }

  try {
    const outdated = JSON.parse(outdatedResult.stdout) as {
      formulae?: BrewOutdated[];
      casks?: BrewOutdated[];
    };

    const formulae = outdated.formulae ?? [];
    const casks = outdated.casks ?? [];

    const criticalPackages = ["node", "git", "python", "sqlite", "openssl"];
    const outdatedCritical = formulae.filter((f) =>
      criticalPackages.some((p) => f.name.toLowerCase().includes(p)),
    );

    if (outdatedCritical.length > 0) {
      for (const pkg of outdatedCritical.slice(0, 5)) {
        const installed = pkg.installed_versions?.[0] ?? "unknown";
        items.push(warningItem(`brew: ${pkg.name}`, `${installed} → ${pkg.current_version}`));
      }
    }

    const totalOutdated = formulae.length + casks.length;
    if (totalOutdated > 0) {
      items.push(infoItem("Homebrew outdated", `${totalOutdated} package(s) can be upgraded`));
    } else {
      items.push(okItem("Homebrew", "All packages up to date"));
    }
  } catch {
    items.push(infoItem("Homebrew", "Could not parse outdated packages"));
  }

  return items;
}

async function checkOsVersion(signal: AbortSignal): Promise<TaskResult["items"]> {
  const items: TaskResult["items"] = [];
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS
    const versionResult = await runCommand("sw_vers -productVersion");
    const version = versionResult?.stdout.trim() ?? "unknown";

    // Check for software updates (non-blocking check)
    if (!signal.aborted) {
      const updatesResult = await runCommand(
        "softwareupdate -l 2>&1 | grep -c 'Software Update found' || echo 0",
        15_000,
      );

      const hasUpdates = parseInt(updatesResult?.stdout.trim() ?? "0", 10) > 0;

      if (hasUpdates) {
        items.push(warningItem("macOS", `${version} (updates available)`));
      } else {
        items.push(okItem("macOS", version));
      }
    } else {
      items.push(okItem("macOS", version));
    }
  } else if (platform === "linux") {
    // Linux - check distro
    const osRelease = await runCommand("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME");
    const match = osRelease?.stdout.match(/PRETTY_NAME="([^"]+)"/);
    const distro = match?.[1] ?? `Linux ${os.release()}`;

    items.push(okItem("OS", distro));

    // Check for package manager updates
    if (!signal.aborted) {
      const aptCheck = await runCommand("which apt-get");
      if (aptCheck?.stdout.trim()) {
        const updates = await runCommand(
          "apt-get -s upgrade 2>/dev/null | grep -c 'Inst ' || echo 0",
          15_000,
        );
        const count = parseInt(updates?.stdout.trim() ?? "0", 10);
        if (count > 0) {
          items.push(infoItem("apt", `${count} package(s) can be upgraded`));
        }
      }
    }
  } else {
    items.push(okItem("OS", `${platform} ${os.release()}`));
  }

  return items;
}

async function checkNodeVersion(): Promise<TaskResult["items"]> {
  const items: TaskResult["items"] = [];

  const versionResult = await runCommand("node --version");
  const version = versionResult?.stdout.trim() ?? "unknown";
  const majorVersion = parseInt(version.replace("v", "").split(".")[0] ?? "0", 10);

  if (majorVersion < MIN_NODE_VERSION) {
    items.push(errorItem("Node.js", `${version} (minimum v${MIN_NODE_VERSION} required)`));
  } else {
    items.push(okItem("Node.js", version));
  }

  return items;
}

async function checkGitVersion(): Promise<TaskResult["items"]> {
  const items: TaskResult["items"] = [];

  const versionResult = await runCommand("git --version");
  const match = versionResult?.stdout.match(/git version ([\d.]+)/);
  const version = match?.[1] ?? "unknown";

  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    items.push(warningItem("Git", `${version} (${MIN_GIT_VERSION}+ recommended)`));
  } else {
    items.push(okItem("Git", version));
  }

  return items;
}

async function checkEssentialTools(): Promise<TaskResult["items"]> {
  const items: TaskResult["items"] = [];

  const tools = [
    { name: "curl", command: "curl --version" },
    { name: "jq", command: "jq --version", optional: true },
    { name: "sqlite3", command: "sqlite3 --version", optional: true },
  ];

  for (const tool of tools) {
    const result = await runCommand(`which ${tool.name}`);
    if (result?.stdout.trim()) {
      const versionResult = await runCommand(tool.command);
      const version = versionResult?.stdout.split("\n")[0]?.trim() ?? "installed";
      items.push(okItem(tool.name, version.slice(0, 50)));
    } else if (!tool.optional) {
      items.push(errorItem(tool.name, "Not found"));
    }
  }

  return items;
}

export const systemDependenciesTask: ShallowSleepTask = {
  name: "system-dependencies",
  description: "Check system dependencies, brew packages, and OS updates",
  critical: false,
  category: "updates",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.updates.checkSystemDependencies) {
      return createSkippedResult(this.name, "System dependencies check disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      // Check Node.js version
      if (!ctx.signal.aborted) {
        items.push(...(await checkNodeVersion()));
      }

      // Check Git version
      if (!ctx.signal.aborted) {
        items.push(...(await checkGitVersion()));
      }

      // Check essential tools
      if (!ctx.signal.aborted) {
        items.push(...(await checkEssentialTools()));
      }

      // Check OS version and updates
      if (!ctx.signal.aborted) {
        items.push(...(await checkOsVersion(ctx.signal)));
      }

      // Check Homebrew (macOS/Linux)
      if (!ctx.signal.aborted) {
        items.push(...(await checkBrewOutdated(ctx.signal)));
      }

      return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return createTaskResult({
        name: this.name,
        critical: this.critical,
        startMs,
        items,
        error,
      });
    }
  },
};
