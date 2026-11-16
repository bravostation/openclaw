import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/**
 * Host-memory receipts that let an owner turn's sessions_send followup carry owner
 * authority into a direct child that the same owner session spawned.
 *
 * A receipt never crosses the wire: it lives in this process only, is bound to one
 * exact sender run, sender incarnation, target incarnation and agent idempotency key,
 * and is consumed at most once. A restart drops every receipt.
 */
export const OWNER_FOLLOWUP_RECEIPT_TTL_MS = 10 * 60_000;
const MAX_OWNER_FOLLOWUP_RECEIPTS = 256;

export type OwnerFollowupReceipt = {
  senderRunId: string;
  senderSessionKey: string;
  senderSessionId: string;
  senderRevision: string;
  targetSessionKey: string;
  targetSessionId: string;
  idempotencyKey: string;
  expiresAt: number;
};

// One process-wide store, shared by the issuing tool and the consuming Gateway turn.
const receipts = resolveGlobalSingleton(
  Symbol.for("openclaw.ownerFollowupReceipts"),
  () => new Map<string, OwnerFollowupReceipt>(),
);

function pruneExpired(now: number): void {
  for (const [key, receipt] of receipts) {
    if (receipt.expiresAt <= now) {
      receipts.delete(key);
    }
  }
}

/** Records a receipt for one followup; returns a revoke that only removes this receipt. */
export function issueOwnerFollowupReceipt(
  receipt: Omit<OwnerFollowupReceipt, "expiresAt">,
  now = Date.now(),
): () => void {
  pruneExpired(now);
  if (receipts.has(receipt.idempotencyKey) || receipts.size >= MAX_OWNER_FOLLOWUP_RECEIPTS) {
    // A colliding or flooding issuer gets no receipt; the followup simply runs without owner.
    return () => {};
  }
  const issued = Object.freeze({ ...receipt, expiresAt: now + OWNER_FOLLOWUP_RECEIPT_TTL_MS });
  receipts.set(receipt.idempotencyKey, issued);
  return () => {
    if (receipts.get(receipt.idempotencyKey) === issued) {
      receipts.delete(receipt.idempotencyKey);
    }
  };
}

/** Removes and returns the receipt for an agent idempotency key. Single use. */
export function takeOwnerFollowupReceipt(idempotencyKey: string): OwnerFollowupReceipt | undefined {
  const receipt = receipts.get(idempotencyKey);
  receipts.delete(idempotencyKey);
  return receipt;
}

export function resetOwnerFollowupReceiptsForTest(): void {
  receipts.clear();
}
