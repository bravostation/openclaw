/**
 * Memory utilities for the sleep system.
 */

import path from "node:path";

import { STATE_DIR } from "../../config/paths.js";

/**
 * Resolve agent directory path (simplified version for sleep system).
 * Uses default STATE_DIR-based path structure.
 */
export function resolveAgentDirForSleep(agentId: string): string {
  const id = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return path.join(STATE_DIR, "agents", id, "agent");
}

/**
 * Resolve memory database path for an agent.
 * Uses the same path as the main memory manager: ~/.openclaw/memory/{agentId}.sqlite
 */
export function resolveMemoryDbPath(agentId: string): string {
  return path.join(STATE_DIR, "memory", `${agentId}.sqlite`);
}

/**
 * Resolve sessions directory for an agent.
 */
export function resolveSessionsDir(agentId: string): string {
  return path.join(resolveAgentDirForSleep(agentId), "sessions");
}

/**
 * Resolve core memories file path for an agent.
 */
export function resolveCoreMemoriesPath(agentId: string): string {
  return path.join(resolveAgentDirForSleep(agentId), "core-memories.json");
}

/**
 * Resolve long-term memories file path for an agent.
 */
export function resolveLongTermMemoriesPath(agentId: string): string {
  return path.join(resolveAgentDirForSleep(agentId), "long-term-memories.json");
}

/**
 * Resolve medium-term memories file path for an agent.
 */
export function resolveMediumTermMemoriesPath(agentId: string): string {
  return path.join(resolveAgentDirForSleep(agentId), "medium-term-memories.json");
}
