import {
  takeOwnerFollowupReceipt,
  type OwnerFollowupReceipt,
} from "../../agents/subagents/owner-followup-receipts.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isCompletionReportInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { AgentTurnPrincipal } from "./types.js";

const MAX_SPAWN_OWNER_HOPS = 16;
/** Longest requester yield chain that keeps the owner captured by the original ingress. */
export const MAX_OWNER_CONTINUATION_HOPS = 8;
const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/;

export type SpawnOwnerAuthority =
  | { granted: true; rootSessionKey: string; hops: number }
  | { granted: false; reason: string };

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * Derive owner authority for a native subagent turn from host-owned spawn receipts.
 *
 * The owner principal is never taken from the child's synthetic launch scopes or
 * any message text. It is granted only when the host-only native subagent marker
 * dispatched this run and every lineage hop up to a current direct-chat root was
 * recorded as spawned by a verified owner turn of the same agent, against the exact
 * parent incarnation and lifecycle revision captured at spawn time.
 */
export async function resolveSpawnOwnerAuthority(params: {
  client: AgentTurnPrincipal | null;
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  admittedSessionId: string;
  activeSessionAgentId: string;
  assertCurrent: () => void;
}): Promise<SpawnOwnerAuthority> {
  if (params.client?.internal?.agentRunTracking !== "native_subagent") {
    return { granted: false, reason: "not a host-dispatched native subagent run" };
  }
  return await walkOwnerSpawnLineage(params);
}

/** Every hop up to a current direct-chat root must be an owner spawn of the same agent. */
async function walkOwnerSpawnLineage(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  admittedSessionId: string;
  activeSessionAgentId: string;
  assertCurrent: () => void;
}): Promise<SpawnOwnerAuthority> {
  const deny = (reason: string): SpawnOwnerAuthority => ({ granted: false, reason });
  const agentId = params.activeSessionAgentId;
  let entry = params.sessionEntry;
  let sessionKey = params.resolvedSessionKey;
  if (!entry || !sessionKey || entry.sessionId !== params.admittedSessionId) {
    return deny("admitted session entry is unavailable");
  }
  const seen = new Set<string>();
  for (let hops = 0; hops <= MAX_SPAWN_OWNER_HOPS; hops += 1) {
    if (seen.has(sessionKey) || parseAgentSessionKey(sessionKey)?.agentId !== agentId) {
      return deny(`session lineage at ${sessionKey} is cyclic or crosses agents`);
    }
    seen.add(sessionKey);
    if (entry.spawnedBy === undefined) {
      if (hops === 0) {
        return deny("session was not spawned");
      }
      if (entry.chatType !== "direct") {
        return deny(`root session ${sessionKey} is not a direct chat`);
      }
      return { granted: true, rootSessionKey: sessionKey, hops };
    }
    if (entry.spawnedBySenderIsOwner !== true) {
      return deny(`session ${sessionKey} was not spawned by an owner turn`);
    }
    const parentKey = entry.spawnedBy;
    const parentSessionId = entry.spawnedBySessionId;
    const parentRevision = entry.parentSessionLifecycleRevision;
    if (
      !parentKey ||
      (entry.parentSessionKey !== undefined && entry.parentSessionKey !== parentKey) ||
      !isSessionId(parentSessionId) ||
      !parentRevision
    ) {
      return deny(`session ${sessionKey} has an incomplete spawn receipt`);
    }
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: params.cfg,
      key: parentKey,
      agentId,
      assertActive: params.assertCurrent,
      excludeInternalEffects: true,
    });
    params.assertCurrent();
    const parent = loaded.entry;
    if (
      !parent ||
      parent.sessionId !== parentSessionId ||
      parent.lifecycleRevision !== parentRevision
    ) {
      return deny(`parent ${parentKey} was reset or replaced after the spawn`);
    }
    entry = parent;
    sessionKey = parentKey;
  }
  return deny(`session lineage exceeds ${MAX_SPAWN_OWNER_HOPS} hops`);
}

/**
 * Derive owner authority for a sessions_send followup that an owner turn sent into
 * its own retained native child.
 *
 * The owner principal comes only from a single-use host-memory receipt that the
 * sender's owner turn issued for this exact agent run, target incarnation and
 * sender incarnation. Wire clients cannot present it. The receipt is consumed on
 * first evaluation, dies with the sender run or after ten minutes, and the target's
 * full spawn lineage must still verify as it does for a spawned child.
 */
export async function resolveOwnerFollowupAuthority(params: {
  client: AgentTurnPrincipal | null;
  cfg: OpenClawConfig;
  runId: string;
  inputProvenance?: InputProvenance;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  admittedSessionId: string;
  activeSessionAgentId: string;
  assertCurrent: () => void;
  now?: number;
}): Promise<SpawnOwnerAuthority & { senderSessionKey?: string }> {
  const deny = (reason: string): SpawnOwnerAuthority => ({ granted: false, reason });
  if (params.client?.internal?.syntheticClient !== true) {
    return deny("not a host-dispatched followup");
  }
  const provenance = params.inputProvenance;
  if (
    provenance?.kind !== "inter_session" ||
    provenance.sourceTool !== "sessions_send" ||
    !provenance.sourceSessionKey
  ) {
    return deny("not a sessions_send followup");
  }
  const receipt: OwnerFollowupReceipt | undefined = takeOwnerFollowupReceipt(params.runId);
  if (!receipt || receipt.idempotencyKey !== params.runId) {
    return deny("no owner followup receipt for this run");
  }
  if (receipt.expiresAt <= (params.now ?? Date.now())) {
    return deny("owner followup receipt expired");
  }
  if (receipt.senderSessionKey !== provenance.sourceSessionKey) {
    return deny("followup source does not match the receipt sender");
  }
  if (getAgentRunContext(receipt.senderRunId)?.sessionKey !== receipt.senderSessionKey) {
    return deny("owner followup sender run has ended");
  }
  const entry = params.sessionEntry;
  if (
    params.resolvedSessionKey !== receipt.targetSessionKey ||
    params.admittedSessionId !== receipt.targetSessionId ||
    entry?.sessionId !== receipt.targetSessionId
  ) {
    return deny("followup target does not match the receipt");
  }
  if (
    entry.spawnedBy !== receipt.senderSessionKey ||
    entry.spawnedBySenderIsOwner !== true ||
    entry.spawnedBySessionId !== receipt.senderSessionId ||
    entry.parentSessionLifecycleRevision !== receipt.senderRevision
  ) {
    return deny("followup target is not a direct owner spawn of the sender incarnation");
  }
  const lineage = await walkOwnerSpawnLineage(params);
  return lineage.granted ? { ...lineage, senderSessionKey: receipt.senderSessionKey } : lineage;
}

/**
 * Derive owner authority for a requester continuation turn, such as a subagent
 * settle or completion wake that resumes the requester after it yielded.
 *
 * The owner principal comes only from the live requester-owner capability that a
 * fresh, configured-owner channel ingress minted and that the requester's yield
 * captured for exactly this admitted continuation. Both the capability and the
 * continuation custody must still be current, and the requester must be an
 * unspawned direct-chat session. Message text and transcript history are ignored.
 */
export function resolveRequesterContinuationOwnerAuthority(params: {
  client: AgentTurnPrincipal | null;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  inputProvenance?: InputProvenance;
  sessionEntry?: SessionEntry;
  requesterSessionKey?: string;
}): SpawnOwnerAuthority {
  const deny = (reason: string): SpawnOwnerAuthority => ({ granted: false, reason });
  if (params.client?.internal?.syntheticClient !== true) {
    return deny("not a host-dispatched continuation");
  }
  if (!isCompletionReportInputProvenance(params.inputProvenance)) {
    return deny("not a subagent completion continuation");
  }
  const authority = params.cronCreatorAuthority;
  const owner = authority?.requesterOwner;
  if (!authority || !owner || authority.callerOrigin.kind !== "unknown" || !authority.isCurrent) {
    return deny("no captured requester owner");
  }
  const ownerHop = authority.requesterOwnerHop;
  if (
    typeof ownerHop !== "number" ||
    !Number.isInteger(ownerHop) ||
    ownerHop < 1 ||
    ownerHop > MAX_OWNER_CONTINUATION_HOPS
  ) {
    return deny(`requester owner continuation hop is outside 1..${MAX_OWNER_CONTINUATION_HOPS}`);
  }
  try {
    if (authority.isCurrent() !== true || owner.isCurrent() !== true) {
      return deny("requester owner no longer current");
    }
  } catch {
    return deny("requester owner no longer current");
  }
  const entry = params.sessionEntry;
  if (!params.requesterSessionKey || !entry || entry.spawnedBy || entry.chatType !== "direct") {
    return deny("requester is not a direct owner chat");
  }
  return { granted: true, rootSessionKey: params.requesterSessionKey, hops: ownerHop };
}

/**
 * Owner bit for a dispatched continuation turn plus the admission its run scope may carry.
 * The captured requester owner survives into the run scope only when this exact run was
 * granted, so a denied continuation that yields again cannot hand the owner to a later hop.
 * Logs only actual grants.
 */
export function resolveContinuationOwner(
  params: {
    client: AgentTurnPrincipal | null;
    inputProvenance?: InputProvenance;
    sessionEntry?: SessionEntry;
    resolvedSessionKey?: string;
    runId: string;
    context: { logGateway: { info: (message: string) => void } };
  },
  cronCreatorAuthority: GatewayCronCreatorAuthorityAdmission | undefined,
): { granted: boolean; cronCreatorAuthority: GatewayCronCreatorAuthorityAdmission | undefined } {
  const continuationOwner = resolveRequesterContinuationOwnerAuthority({
    client: params.client,
    cronCreatorAuthority,
    inputProvenance: params.inputProvenance,
    sessionEntry: params.sessionEntry,
    requesterSessionKey: params.resolvedSessionKey,
  });
  if (!continuationOwner.granted) {
    return {
      granted: false,
      cronCreatorAuthority: stripRequesterOwner(cronCreatorAuthority),
    };
  }
  params.context.logGateway.info(
    `agent owner authority from requester continuation: run=${params.runId} session=${continuationOwner.rootSessionKey} source=${params.inputProvenance?.sourceTool ?? "unknown"} hop=${continuationOwner.hops}`,
  );
  return { granted: true, cronCreatorAuthority };
}

function stripRequesterOwner(
  admission: GatewayCronCreatorAuthorityAdmission | undefined,
): GatewayCronCreatorAuthorityAdmission | undefined {
  if (!admission?.requesterOwner && admission?.requesterOwnerHop === undefined) {
    return admission;
  }
  const { requesterOwner: _owner, requesterOwnerHop: _hop, ...rest } = admission;
  return Object.freeze(rest);
}
