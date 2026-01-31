/**
 * Security scan task: checks for security issues.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import {
  createTaskResult,
  okItem,
  warningItem,
  errorItem,
  criticalItem,
  infoItem,
  createSkippedResult,
} from "./types.js";

const execAsync = promisify(exec);
const NPM_AUDIT_TIMEOUT_MS = 60_000;

// Patterns that might indicate leaked credentials
const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi,
  /(?:secret|password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
  /(?:bearer|authorization)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi,
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI-style keys
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36}/g, // GitHub OAuth tokens
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
];

const EXCLUDED_FILES = new Set([
  ".git",
  "node_modules",
  ".env.example",
  ".env.sample",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

type NpmAuditResult = {
  vulnerabilities?: Record<
    string,
    {
      severity: string;
      via: unknown[];
    }
  >;
  metadata?: {
    vulnerabilities: {
      info: number;
      low: number;
      moderate: number;
      high: number;
      critical: number;
      total: number;
    };
  };
};

async function scanForCredentials(
  dir: string,
  signal: AbortSignal,
): Promise<{ file: string; pattern: string }[]> {
  const findings: { file: string; pattern: string }[] = [];
  const maxDepth = 3;

  async function scanDir(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || signal.aborted) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal.aborted) {
        break;
      }
      if (EXCLUDED_FILES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scanDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        // Only scan certain file types
        const ext = path.extname(entry.name).toLowerCase();
        if (
          ![
            ".js",
            ".ts",
            ".json",
            ".yml",
            ".yaml",
            ".env",
            ".sh",
            ".md",
            ".txt",
            ".config",
          ].includes(ext) &&
          !entry.name.startsWith(".")
        ) {
          continue;
        }

        // Skip large files
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 100 * 1024) {
            continue;
          } // Skip files > 100KB
        } catch {
          continue;
        }

        try {
          const content = await fs.readFile(fullPath, "utf-8");
          for (const pattern of CREDENTIAL_PATTERNS) {
            pattern.lastIndex = 0;
            if (pattern.test(content)) {
              findings.push({
                file: path.relative(dir, fullPath),
                pattern: pattern.source.slice(0, 30) + "...",
              });
              break; // One finding per file is enough
            }
          }
        } catch {
          // File not readable
        }
      }
    }
  }

  await scanDir(dir, 0);
  return findings;
}

export const securityScanTask: ShallowSleepTask = {
  name: "security-scan",
  description: "Scan for security vulnerabilities",
  critical: false, // Overall not critical, but individual findings may be
  category: "security",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.security.enabled) {
      return createSkippedResult(this.name, "Security scan disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      // Run npm audit
      if (ctx.sleepCfg.shallow.security.npmAudit && ctx.workspaceDir) {
        const packageJsonPath = path.join(ctx.workspaceDir, "package.json");
        try {
          await fs.access(packageJsonPath);

          try {
            const { stdout } = await execAsync("npm audit --json 2>/dev/null || true", {
              cwd: ctx.workspaceDir,
              timeout: NPM_AUDIT_TIMEOUT_MS,
            });

            if (stdout.trim()) {
              const audit = JSON.parse(stdout) as NpmAuditResult;
              const vulns = audit.metadata?.vulnerabilities;

              if (vulns) {
                if (vulns.total === 0) {
                  items.push(okItem("npm audit", "No vulnerabilities"));
                } else {
                  if (vulns.critical > 0) {
                    items.push(
                      criticalItem("npm audit", `${vulns.critical} critical vulnerabilities`),
                    );
                  }
                  if (vulns.high > 0) {
                    items.push(errorItem("npm audit", `${vulns.high} high vulnerabilities`));
                  }
                  if (vulns.moderate > 0) {
                    items.push(
                      warningItem("npm audit", `${vulns.moderate} moderate vulnerabilities`),
                    );
                  }
                  if (vulns.low > 0) {
                    items.push(infoItem("npm audit", `${vulns.low} low vulnerabilities`));
                  }
                }
              }
            } else {
              items.push(okItem("npm audit", "No vulnerabilities"));
            }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            items.push(infoItem("npm audit failed", error));
          }
        } catch {
          items.push(infoItem("npm audit", "No package.json in workspace"));
        }
      }

      // Scan for credential patterns
      if (ctx.sleepCfg.shallow.security.credentialScan && ctx.workspaceDir) {
        try {
          const findings = await scanForCredentials(ctx.workspaceDir, ctx.signal);
          if (findings.length === 0) {
            items.push(okItem("Credential scan", "No potential leaks found"));
          } else {
            items.push(
              criticalItem(
                "Credential scan",
                `Found ${findings.length} potential credential leaks`,
              ),
            );
            // Show first 3 findings
            for (const finding of findings.slice(0, 3)) {
              items.push(warningItem(`  ${finding.file}`));
            }
            if (findings.length > 3) {
              items.push(infoItem(`  ...and ${findings.length - 3} more`));
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          items.push(infoItem("Credential scan failed", error));
        }
      }

      // TLS check (placeholder - could check certificate expiry for configured endpoints)
      if (ctx.sleepCfg.shallow.security.tlsCheck) {
        items.push(infoItem("TLS check", "Not yet implemented"));
      }

      // Advisory check (placeholder - would query GitHub Advisory Database)
      if (ctx.sleepCfg.shallow.security.advisoryCheck) {
        items.push(infoItem("Advisory check", "Not yet implemented"));
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
