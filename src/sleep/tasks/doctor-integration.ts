/**
 * Doctor integration task: runs key doctor checks during shallow sleep.
 *
 * This provides a non-interactive subset of `openclaw doctor` that:
 * - Validates state directory integrity
 * - Checks file permissions
 * - Verifies gateway configuration
 * - Scans for security warnings
 *
 * Full doctor repairs are not attempted; issues are logged for the report.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { isLoopbackHost, resolveGatewayBindHost } from "../../gateway/net.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../../config/sessions.js";

import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { createTaskResult, okItem, warningItem, errorItem, createSkippedResult } from "./types.js";

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function canWriteDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function shortenHomePath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/** Check state directory integrity */
function checkStateIntegrity(cfg: ShallowSleepTaskContext["cfg"]): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const stateDir = resolveStateDir(process.env, os.homedir);

  // Check state directory exists
  if (!existsDir(stateDir)) {
    issues.push(`State directory missing: ${shortenHomePath(stateDir)}`);
    return { ok: false, issues };
  }

  // Check permissions
  if (!canWriteDir(stateDir)) {
    issues.push(`State directory not writable: ${shortenHomePath(stateDir)}`);
  }

  // Check permissions are tight enough
  if (process.platform !== "win32") {
    try {
      const stat = fs.statSync(stateDir);
      if ((stat.mode & 0o077) !== 0) {
        issues.push(`State directory permissions too open (recommend chmod 700)`);
      }
    } catch {
      // Ignore stat errors
    }
  }

  // Check sessions directory
  const agentId = resolveDefaultAgentId(cfg);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, process.env, os.homedir);
  if (!existsDir(sessionsDir)) {
    issues.push(`Sessions directory missing: ${shortenHomePath(sessionsDir)}`);
  } else if (!canWriteDir(sessionsDir)) {
    issues.push(`Sessions directory not writable: ${shortenHomePath(sessionsDir)}`);
  }

  // Check session store
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const storeDir = path.dirname(storePath);
  if (!existsDir(storeDir)) {
    issues.push(`Session store directory missing: ${shortenHomePath(storeDir)}`);
  }

  // Check for missing session transcripts
  const store = loadSessionStore(storePath);
  const entries = Object.entries(store).filter(([, entry]) => entry && typeof entry === "object");
  if (entries.length > 0) {
    const recent = entries
      .toSorted((a, b) => {
        const aUpdated = typeof a[1].updatedAt === "number" ? a[1].updatedAt : 0;
        const bUpdated = typeof b[1].updatedAt === "number" ? b[1].updatedAt : 0;
        return bUpdated - aUpdated;
      })
      .slice(0, 5);
    const missing = recent.filter(([, entry]) => {
      const sessionId = entry.sessionId;
      if (!sessionId) {
        return false;
      }
      const transcriptPath = resolveSessionFilePath(sessionId, entry, { agentId });
      return !existsFile(transcriptPath);
    });
    if (missing.length > 0) {
      issues.push(`${missing.length}/${recent.length} recent sessions missing transcripts`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Check gateway security configuration */
async function checkGatewaySecurity(
  cfg: ShallowSleepTaskContext["cfg"],
): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];

  const gatewayBind = (cfg.gateway?.bind ?? "loopback") as string;
  const customBindHost = cfg.gateway?.customBindHost?.trim();

  type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";
  const bindModes: GatewayBindMode[] = ["auto", "lan", "loopback", "custom", "tailnet"];
  const bindMode = bindModes.includes(gatewayBind as GatewayBindMode)
    ? (gatewayBind as GatewayBindMode)
    : undefined;
  const resolvedBindHost = bindMode
    ? await resolveGatewayBindHost(bindMode, customBindHost)
    : "0.0.0.0";
  const isExposed = !isLoopbackHost(resolvedBindHost);

  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
  });

  const authToken = resolvedAuth.token?.trim() ?? "";
  const authPassword = resolvedAuth.password?.trim() ?? "";
  const hasToken = authToken.length > 0;
  const hasPassword = authPassword.length > 0;
  const hasSharedSecret =
    (resolvedAuth.mode === "token" && hasToken) ||
    (resolvedAuth.mode === "password" && hasPassword);

  if (isExposed && !hasSharedSecret) {
    issues.push(`CRITICAL: Gateway bound to ${resolvedBindHost} without authentication`);
  } else if (isExposed) {
    issues.push(`Gateway bound to ${resolvedBindHost} (network-accessible)`);
  }

  // Check gateway mode is set
  if (!cfg.gateway?.mode) {
    issues.push("Gateway mode not set (gateway.mode is unset)");
  }

  return { ok: issues.length === 0, issues };
}

/** Check config file integrity */
function checkConfigIntegrity(cfg: ShallowSleepTaskContext["cfg"]): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for missing essential config
  if (!cfg.gateway?.mode) {
    issues.push("gateway.mode not configured");
  }

  // Check model configuration via agents.defaults.model
  if (!cfg.agents?.defaults?.model?.primary) {
    issues.push("No default model configured (agents.defaults.model.primary)");
  }

  // Check for deprecated settings
  if (cfg.session && "openaiApiKey" in cfg.session) {
    issues.push("Deprecated: session.openaiApiKey found (use models.providers)");
  }

  return { ok: issues.length === 0, issues };
}

export const doctorIntegrationTask: ShallowSleepTask = {
  name: "doctor-integration",
  description: "Run doctor checks for state integrity and security",
  critical: false, // Findings are advisory, not blocking
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    if (!ctx.sleepCfg.shallow.tasks.doctorIntegration) {
      return createSkippedResult(this.name, "Doctor integration disabled");
    }

    const startMs = Date.now();
    const items: TaskResult["items"] = [];
    let hasWarning = false;
    let hasCritical = false;

    // State integrity check
    const stateResult = checkStateIntegrity(ctx.cfg);
    if (stateResult.ok) {
      items.push(okItem("State integrity", "All directories accessible"));
    } else {
      for (const issue of stateResult.issues) {
        // State issues are warnings unless explicitly marked CRITICAL
        if (issue.startsWith("CRITICAL:")) {
          items.push(errorItem("State integrity", issue));
          hasCritical = true;
        } else {
          items.push(warningItem("State integrity", issue));
          hasWarning = true;
        }
      }
    }

    // Gateway security check
    const gatewayResult = await checkGatewaySecurity(ctx.cfg);
    if (gatewayResult.ok) {
      items.push(okItem("Gateway security", "Properly configured"));
    } else {
      for (const issue of gatewayResult.issues) {
        if (issue.includes("CRITICAL")) {
          items.push(errorItem("Gateway security", issue));
          hasCritical = true;
        } else {
          items.push(warningItem("Gateway security", issue));
          hasWarning = true;
        }
      }
    }

    // Config integrity check
    const configResult = checkConfigIntegrity(ctx.cfg);
    if (configResult.ok) {
      items.push(okItem("Config integrity", "Essential settings present"));
    } else {
      for (const issue of configResult.issues) {
        items.push(warningItem("Config", issue));
        hasWarning = true;
      }
    }

    // Summary
    if (hasCritical) {
      items.unshift(errorItem("Doctor", "Critical issues found - run `openclaw doctor` to fix"));
    } else if (hasWarning) {
      items.unshift(warningItem("Doctor", "Warnings found - consider running `openclaw doctor`"));
    } else {
      items.unshift(okItem("Doctor", "All health checks passed"));
    }

    return createTaskResult({
      name: this.name,
      critical: false, // Doctor findings are advisory, don't block deep sleep
      startMs,
      items,
    });
  },
};
