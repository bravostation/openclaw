/**
 * Credentials check task: verifies auth tokens and expiry.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ShallowSleepTask, ShallowSleepTaskContext, TaskResult } from "./types.js";
import { STATE_DIR } from "../../config/paths.js";
import { createTaskResult, okItem, warningItem, errorItem, infoItem } from "./types.js";

const CREDENTIALS_DIR = "credentials";
const EXPIRY_WARNING_DAYS = 14;
const EXPIRY_CRITICAL_DAYS = 7;

type CredentialFile = {
  name: string;
  path: string;
  expiresAt?: number;
};

async function findCredentialFiles(baseDir: string): Promise<CredentialFile[]> {
  const credentialsDir = path.join(baseDir, CREDENTIALS_DIR);
  const files: CredentialFile[] = [];

  try {
    const entries = await fs.readdir(credentialsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const filePath = path.join(credentialsDir, entry.name);
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const data = JSON.parse(content);
          files.push({
            name: entry.name.replace(".json", ""),
            path: filePath,
            expiresAt: data.expiresAt ?? data.expires_at ?? data.expiry,
          });
        } catch {
          files.push({ name: entry.name.replace(".json", ""), path: filePath });
        }
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files;
}

export const credentialsCheckTask: ShallowSleepTask = {
  name: "credentials-check",
  description: "Check for expiring credentials and tokens",
  critical: false, // Warnings only, not critical
  category: "health",

  async run(ctx: ShallowSleepTaskContext): Promise<TaskResult> {
    const startMs = Date.now();
    const items: TaskResult["items"] = [];

    try {
      const openclawDir = STATE_DIR;
      const credentials = await findCredentialFiles(openclawDir);

      if (credentials.length === 0) {
        items.push(infoItem("No credential files found"));
        return createTaskResult({ name: this.name, critical: this.critical, startMs, items });
      }

      const nowMs = Date.now();
      const warningThresholdMs = EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
      const criticalThresholdMs = EXPIRY_CRITICAL_DAYS * 24 * 60 * 60 * 1000;

      for (const cred of credentials) {
        if (!cred.expiresAt) {
          items.push(infoItem(`${cred.name}`, "No expiry information"));
          continue;
        }

        const expiresAtMs = cred.expiresAt * (cred.expiresAt < 1e12 ? 1000 : 1);
        const remainingMs = expiresAtMs - nowMs;

        if (remainingMs <= 0) {
          items.push(errorItem(`${cred.name}`, "Expired"));
        } else if (remainingMs <= criticalThresholdMs) {
          const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
          items.push(errorItem(`${cred.name}`, `Expires in ${days} days`));
        } else if (remainingMs <= warningThresholdMs) {
          const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
          items.push(warningItem(`${cred.name}`, `Expires in ${days} days`));
        } else {
          const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
          items.push(okItem(`${cred.name}`, `Valid for ${days} days`));
        }
      }

      // Check for OAuth tokens in config
      const authProfiles = ctx.cfg.auth?.profiles;
      if (authProfiles) {
        for (const [profileId, profile] of Object.entries(authProfiles)) {
          if (profile && typeof profile === "object" && "expiresAt" in profile) {
            const expiresAt = (profile as { expiresAt?: number }).expiresAt;
            if (expiresAt) {
              const expiresAtMs = expiresAt * (expiresAt < 1e12 ? 1000 : 1);
              const remainingMs = expiresAtMs - nowMs;
              if (remainingMs <= 0) {
                items.push(errorItem(`Auth profile: ${profileId}`, "Expired"));
              } else if (remainingMs <= criticalThresholdMs) {
                const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
                items.push(errorItem(`Auth profile: ${profileId}`, `Expires in ${days} days`));
              } else if (remainingMs <= warningThresholdMs) {
                const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
                items.push(warningItem(`Auth profile: ${profileId}`, `Expires in ${days} days`));
              }
            }
          }
        }
      }

      if (items.length === 0) {
        items.push(okItem("All credentials valid"));
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
