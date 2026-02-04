/**
 * Package manager validation task: checks for outdated dependencies.
 *
 * Validates:
 * - npm/pnpm/bun outdated packages
 * - Lock file integrity
 * - Security audit status
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { createTaskResult, okItem, warningItem, infoItem, createSkippedResult } from "./types.js";

const execAsync = promisify(exec);
const TIMEOUT_MS = 30_000;

type PackageManager = "pnpm" | "npm" | "bun" | "yarn";

/** Detect which package manager is in use */
function detectPackageManager(workspaceDir: string): PackageManager | null {
  const lockFiles: Array<{ file: string; manager: PackageManager }> = [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "bun.lockb", manager: "bun" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "package-lock.json", manager: "npm" },
  ];

  for (const { file, manager } of lockFiles) {
    if (fs.existsSync(path.join(workspaceDir, file))) {
      return manager;
    }
  }

  // Check for package.json at least
  if (fs.existsSync(path.join(workspaceDir, "package.json"))) {
    return "npm"; // Default to npm if package.json exists
  }

  return null;
}

/** Check if package manager binary exists */
async function hasPackageManager(manager: PackageManager): Promise<boolean> {
  try {
    await execAsync(`${manager} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Get outdated packages count */
async function getOutdatedCount(
  manager: PackageManager,
  workspaceDir: string,
): Promise<{ count: number; critical: number; error?: string }> {
  try {
    let cmd: string;
    switch (manager) {
      case "pnpm":
        cmd = "pnpm outdated --format json 2>/dev/null || true";
        break;
      case "npm":
        cmd = "npm outdated --json 2>/dev/null || true";
        break;
      case "bun":
        // Bun doesn't have a direct outdated command, check via npm
        cmd = "npm outdated --json 2>/dev/null || true";
        break;
      case "yarn":
        cmd = "yarn outdated --json 2>/dev/null || true";
        break;
    }

    const { stdout } = await execAsync(cmd, { cwd: workspaceDir, timeout: TIMEOUT_MS });

    if (!stdout.trim()) {
      return { count: 0, critical: 0 };
    }

    // Parse output
    try {
      const data = JSON.parse(stdout);

      if (manager === "pnpm") {
        // pnpm returns array of package objects
        const packages = Array.isArray(data) ? data : [];
        const critical = packages.filter((p: { current?: string; latest?: string }) => {
          // Major version bump = critical
          const current = p.current?.split(".")[0];
          const latest = p.latest?.split(".")[0];
          return current && latest && current !== latest;
        }).length;
        return { count: packages.length, critical };
      }

      if (manager === "npm" || manager === "bun") {
        // npm returns object with package names as keys
        const packages = Object.keys(data);
        const critical = packages.filter((name) => {
          const pkg = data[name];
          const current = pkg?.current?.split(".")[0];
          const latest = pkg?.latest?.split(".")[0];
          return current && latest && current !== latest;
        }).length;
        return { count: packages.length, critical };
      }

      if (manager === "yarn") {
        // Yarn's JSON output is different per version
        if (data.data?.body) {
          return { count: data.data.body.length, critical: 0 };
        }
        return { count: 0, critical: 0 };
      }

      return { count: 0, critical: 0 };
    } catch {
      // Parse error - likely no outdated packages
      return { count: 0, critical: 0 };
    }
  } catch (err) {
    return { count: 0, critical: 0, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Run security audit */
async function runSecurityAudit(
  manager: PackageManager,
  workspaceDir: string,
): Promise<{ vulnerabilities: number; critical: number; error?: string }> {
  try {
    let cmd: string;
    switch (manager) {
      case "pnpm":
        cmd = "pnpm audit --json 2>/dev/null || true";
        break;
      case "npm":
        cmd = "npm audit --json 2>/dev/null || true";
        break;
      case "bun":
        // Bun uses npm audit
        cmd = "npm audit --json 2>/dev/null || true";
        break;
      case "yarn":
        cmd = "yarn audit --json 2>/dev/null || true";
        break;
    }

    const { stdout } = await execAsync(cmd, { cwd: workspaceDir, timeout: TIMEOUT_MS });

    if (!stdout.trim()) {
      return { vulnerabilities: 0, critical: 0 };
    }

    try {
      const data = JSON.parse(stdout);

      // npm/pnpm audit format
      if (data.metadata?.vulnerabilities) {
        const vuln = data.metadata.vulnerabilities;
        const total =
          (vuln.total ?? 0) ||
          (vuln.low ?? 0) + (vuln.moderate ?? 0) + (vuln.high ?? 0) + (vuln.critical ?? 0);
        return {
          vulnerabilities: total,
          critical: (vuln.critical ?? 0) + (vuln.high ?? 0),
        };
      }

      // Alternative format
      if (data.vulnerabilities) {
        const vulns = Object.values(data.vulnerabilities);
        const critical = vulns.filter(
          (v: unknown) => (v as { severity?: string }).severity === "critical",
        ).length;
        return { vulnerabilities: vulns.length, critical };
      }

      return { vulnerabilities: 0, critical: 0 };
    } catch {
      return { vulnerabilities: 0, critical: 0 };
    }
  } catch (err) {
    return {
      vulnerabilities: 0,
      critical: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export const packageManagerTask: ShallowSleepTask = {
  name: "package-manager",
  description: "Check package manager health and outdated dependencies",
  critical: false,
  category: "updates",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.updates.checkPackageManager) {
      return createSkippedResult(this.name, "Package manager check disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    // Detect package manager from workspace
    const workspaceDir = ctx.workspaceDir ?? process.cwd();
    const manager = detectPackageManager(workspaceDir);

    if (!manager) {
      items.push(infoItem("No package manager detected (no lock file found)"));
      return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
    }

    // Check if package manager is installed
    const hasManager = await hasPackageManager(manager);
    if (!hasManager) {
      items.push(warningItem(`${manager}`, "Not installed or not in PATH"));
      return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
    }

    items.push(okItem("Package manager", manager));

    // Check for outdated packages
    const outdated = await getOutdatedCount(manager, workspaceDir);
    if (outdated.error) {
      items.push(warningItem("Outdated check", `Failed: ${outdated.error}`));
    } else if (outdated.count === 0) {
      items.push(okItem("Dependencies", "All up to date"));
    } else if (outdated.critical > 0) {
      items.push(
        warningItem("Outdated packages", `${outdated.count} outdated (${outdated.critical} major)`),
      );
    } else {
      items.push(infoItem("Outdated packages", `${outdated.count} minor/patch updates available`));
    }

    // Run security audit
    const audit = await runSecurityAudit(manager, workspaceDir);
    if (audit.error) {
      items.push(warningItem("Security audit", `Failed: ${audit.error}`));
    } else if (audit.vulnerabilities === 0) {
      items.push(okItem("Security audit", "No vulnerabilities found"));
    } else if (audit.critical > 0) {
      items.push(
        warningItem(
          "Security audit",
          `${audit.vulnerabilities} vulnerabilities (${audit.critical} high/critical)`,
        ),
      );
    } else {
      items.push(
        infoItem("Security audit", `${audit.vulnerabilities} low-severity vulnerabilities`),
      );
    }

    return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
  },
};
