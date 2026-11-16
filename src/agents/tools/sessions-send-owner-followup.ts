import type { SessionEntry } from "../../config/sessions.js";
import { issueOwnerFollowupReceipt } from "../subagents/owner-followup-receipts.js";

export type OwnerFollowupTarget = { sessionId: string; lifecycleRevision?: string } & Pick<
  Partial<SessionEntry>,
  "spawnedBy" | "spawnedBySenderIsOwner" | "spawnedBySessionId" | "parentSessionLifecycleRevision"
>;

/**
 * Issues the single-use owner followup receipt only when a host-verified owner turn
 * sends a new followup turn into a native child that this exact sender incarnation
 * spawned as owner. Every other send gets a no-op revoke and no authority.
 */
export function issueSessionsSendOwnerFollowupReceipt(params: {
  /** Present only when the host verified the sending turn as owner. */
  sender?: SessionEntry;
  mode?: string;
  nativeTarget: boolean;
  sameAgent: boolean;
  senderRunId?: string;
  senderSessionKey: string;
  targetSessionKey: string;
  target?: OwnerFollowupTarget;
  idempotencyKey: string;
}): () => void {
  const { sender, target } = params;
  if (
    !sender?.sessionId ||
    !sender.lifecycleRevision ||
    (params.mode !== undefined && params.mode !== "followup") ||
    !params.nativeTarget ||
    !params.sameAgent ||
    !params.senderRunId ||
    !target?.sessionId ||
    target.spawnedBy !== params.senderSessionKey ||
    target.spawnedBySenderIsOwner !== true ||
    target.spawnedBySessionId !== sender.sessionId ||
    target.parentSessionLifecycleRevision !== sender.lifecycleRevision
  ) {
    return () => {};
  }
  return issueOwnerFollowupReceipt({
    senderRunId: params.senderRunId,
    senderSessionKey: params.senderSessionKey,
    senderSessionId: sender.sessionId,
    senderRevision: sender.lifecycleRevision,
    targetSessionKey: params.targetSessionKey,
    targetSessionId: target.sessionId,
    idempotencyKey: params.idempotencyKey,
  });
}
