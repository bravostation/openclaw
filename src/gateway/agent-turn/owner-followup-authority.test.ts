import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_FOLLOWUP_RECEIPT_TTL_MS,
  issueOwnerFollowupReceipt,
  resetOwnerFollowupReceiptsForTest,
} from "../../agents/subagents/owner-followup-receipts.js";
import { issueSessionsSendOwnerFollowupReceipt } from "../../agents/tools/sessions-send-owner-followup.js";
import type { SessionEntry } from "../../config/sessions.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { resolveOwnerFollowupAuthority } from "./spawn-owner-authority.js";
import type { AgentTurnPrincipal } from "./types.js";

const mocks = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
// mock-isolation: The lineage walk receives fixture session rows without starting a read worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadSessionEntry,
}));

const MAIN = "agent:main:main";
const CHILD = "agent:main:subagent:worker";
const GRANDCHILD = "agent:main:subagent:worker:subagent:leaf";
const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD_ID = "33333333-3333-4333-8333-333333333333";
const SENDER_RUN = "owner-turn";
const FOLLOWUP_RUN = "followup-run";
const synthetic = { internal: { syntheticClient: true } } as unknown as AgentTurnPrincipal;
const followupProvenance: InputProvenance = {
  kind: "inter_session",
  sourceSessionKey: MAIN,
  sourceTool: "sessions_send",
};

let store: Record<string, SessionEntry>;
const mainEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: MAIN_ID,
  updatedAt: 1,
  chatType: "direct",
  lifecycleRevision: "rev-main",
  ...overrides,
});
const childEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: CHILD_ID,
  updatedAt: 1,
  lifecycleRevision: "rev-child",
  spawnedBy: MAIN,
  spawnedBySessionId: MAIN_ID,
  parentSessionLifecycleRevision: "rev-main",
  spawnedBySenderIsOwner: true,
  ...overrides,
});

type IssueOverrides = Partial<Parameters<typeof issueSessionsSendOwnerFollowupReceipt>[0]>;
const issue = (overrides: IssueOverrides = {}) =>
  issueSessionsSendOwnerFollowupReceipt({
    sender: store[MAIN],
    mode: undefined,
    nativeTarget: true,
    sameAgent: true,
    senderRunId: SENDER_RUN,
    senderSessionKey: MAIN,
    targetSessionKey: CHILD,
    target: store[CHILD],
    idempotencyKey: FOLLOWUP_RUN,
    ...overrides,
  });

type ResolveOverrides = Partial<Parameters<typeof resolveOwnerFollowupAuthority>[0]>;
const resolve = (overrides: ResolveOverrides = {}) =>
  resolveOwnerFollowupAuthority({
    client: synthetic,
    cfg: {},
    runId: FOLLOWUP_RUN,
    inputProvenance: followupProvenance,
    sessionEntry: store[CHILD],
    resolvedSessionKey: CHILD,
    admittedSessionId: CHILD_ID,
    activeSessionAgentId: "main",
    assertCurrent: () => {},
    ...overrides,
  });

const GRANT = { granted: true, rootSessionKey: MAIN, hops: 1, senderSessionKey: MAIN };
const denied = (reason: string) => ({ granted: false, reason });

beforeEach(() => {
  store = { [MAIN]: mainEntry(), [CHILD]: childEntry() };
  mocks.loadSessionEntry.mockReset().mockImplementation(async ({ key }: { key: string }) => ({
    cfg: {},
    storePath: "/synthetic/sessions.sqlite",
    canonicalKey: key,
    entry: store[key],
    store,
  }));
  registerAgentRunContext(SENDER_RUN, { agentId: "main", sessionKey: MAIN, sessionId: MAIN_ID });
});
afterEach(() => {
  clearAgentRunContext(SENDER_RUN);
  resetOwnerFollowupReceiptsForTest();
});

describe("owner followup authority (gap 1)", () => {
  it("grants a host-dispatched followup into a direct owner-spawned child of the sender", async () => {
    issue();
    await expect(resolve()).resolves.toEqual(GRANT);
  });

  it("consumes the receipt once: a replay of the same run is denied", async () => {
    issue();
    await expect(resolve()).resolves.toEqual(GRANT);
    await expect(resolve()).resolves.toEqual(denied("no owner followup receipt for this run"));
  });

  it.each([
    ["a wire client without internal context", null],
    ["a WS client", { connect: { scopes: ["operator.admin"] } }],
    ["a non-synthetic internal client", { internal: { agentRunTracking: "native_subagent" } }],
  ])("ignores the receipt for %s without burning it", async (_label, client) => {
    issue();
    await expect(resolve({ client: client as AgentTurnPrincipal | null })).resolves.toEqual(
      denied("not a host-dispatched followup"),
    );
    await expect(resolve()).resolves.toEqual(GRANT);
  });

  it.each<[string, InputProvenance | undefined]>([
    ["missing provenance", undefined],
    ["a completion announce", { ...followupProvenance, sourceTool: "subagent_announce" }],
    ["an external user", { kind: "external_user" } as InputProvenance],
    [
      "a non-inter-session sessions_send source",
      { ...followupProvenance, kind: "external_user" } as InputProvenance,
    ],
    ["no source session", { ...followupProvenance, sourceSessionKey: undefined }],
  ])("denies %s before touching the receipt", async (_label, inputProvenance) => {
    issue();
    await expect(resolve({ inputProvenance })).resolves.toEqual(
      denied("not a sessions_send followup"),
    );
    await expect(resolve()).resolves.toEqual(GRANT);
  });

  it("denies a forged followup source and burns the receipt", async () => {
    issue();
    await expect(
      resolve({ inputProvenance: { ...followupProvenance, sourceSessionKey: "agent:main:other" } }),
    ).resolves.toEqual(denied("followup source does not match the receipt sender"));
    await expect(resolve()).resolves.toEqual(denied("no owner followup receipt for this run"));
  });

  it("denies a run whose idempotency key has no receipt", async () => {
    issue();
    await expect(resolve({ runId: "other-run" })).resolves.toEqual(
      denied("no owner followup receipt for this run"),
    );
  });

  it("expires at ten minutes and grants just before", async () => {
    const now = Date.now();
    issue();
    await expect(resolve({ now: now + OWNER_FOLLOWUP_RECEIPT_TTL_MS + 1_000 })).resolves.toEqual(
      denied("owner followup receipt expired"),
    );
    issueOwnerFollowupReceipt(
      {
        senderRunId: SENDER_RUN,
        senderSessionKey: MAIN,
        senderSessionId: MAIN_ID,
        senderRevision: "rev-main",
        targetSessionKey: CHILD,
        targetSessionId: CHILD_ID,
        idempotencyKey: FOLLOWUP_RUN,
      },
      now,
    );
    await expect(resolve({ now: now + OWNER_FOLLOWUP_RECEIPT_TTL_MS - 1 })).resolves.toEqual(GRANT);
  });

  it("expires exactly ten minutes after issue", async () => {
    const issueAt = 1_000_000;
    const receipt = {
      senderRunId: SENDER_RUN,
      senderSessionKey: MAIN,
      senderSessionId: MAIN_ID,
      senderRevision: "rev-main",
      targetSessionKey: CHILD,
      targetSessionId: CHILD_ID,
      idempotencyKey: FOLLOWUP_RUN,
    };
    issueOwnerFollowupReceipt(receipt, issueAt);
    await expect(resolve({ now: issueAt + 600_000 })).resolves.toEqual(
      denied("owner followup receipt expired"),
    );
    issueOwnerFollowupReceipt(receipt, issueAt);
    await expect(resolve({ now: issueAt + 599_999 })).resolves.toEqual(GRANT);
  });

  it("denies once the sender run has ended", async () => {
    issue();
    clearAgentRunContext(SENDER_RUN);
    await expect(resolve()).resolves.toEqual(denied("owner followup sender run has ended"));
  });

  it("denies when the sender run id now belongs to another session", async () => {
    issue();
    registerAgentRunContext(SENDER_RUN, { agentId: "main", sessionKey: "agent:main:other" });
    await expect(resolve()).resolves.toEqual(denied("owner followup sender run has ended"));
  });

  it.each<[string, ResolveOverrides]>([
    ["another session key", { resolvedSessionKey: "agent:main:subagent:other" }],
    ["a reset target incarnation", { admittedSessionId: GRANDCHILD_ID }],
    ["an entry of another incarnation", { sessionEntry: childEntry({ sessionId: GRANDCHILD_ID }) }],
  ])("denies a followup admitted into %s", async (_label, overrides) => {
    issue();
    await expect(resolve(overrides)).resolves.toEqual(
      denied("followup target does not match the receipt"),
    );
  });

  it.each<[string, Partial<SessionEntry>]>([
    ["not owner-spawned", { spawnedBySenderIsOwner: false }],
    ["spawned by another session", { spawnedBy: "agent:main:other" }],
    ["spawned by an older sender incarnation", { spawnedBySessionId: GRANDCHILD_ID }],
    ["spawned at an older sender revision", { parentSessionLifecycleRevision: "rev-old" }],
  ])("denies when the admitted target is %s", async (_label, overrides) => {
    issue();
    await expect(resolve({ sessionEntry: childEntry(overrides) })).resolves.toEqual(
      denied("followup target is not a direct owner spawn of the sender incarnation"),
    );
  });

  it("still requires the lineage walk: a sender reset after issue is denied", async () => {
    issue();
    store[MAIN] = mainEntry({ lifecycleRevision: "rev-reset" });
    await expect(resolve()).resolves.toEqual(
      denied(`parent ${MAIN} was reset or replaced after the spawn`),
    );
  });

  it("still requires the lineage walk: a non-direct root is denied", async () => {
    store[MAIN] = mainEntry({ chatType: "group" });
    issue();
    await expect(resolve()).resolves.toEqual(denied(`root session ${MAIN} is not a direct chat`));
  });

  it("grants a followup from an owner-granted child into its own child with the full lineage", async () => {
    store[GRANDCHILD] = childEntry({
      sessionId: GRANDCHILD_ID,
      spawnedBy: CHILD,
      spawnedBySessionId: CHILD_ID,
      parentSessionLifecycleRevision: "rev-child",
    });
    registerAgentRunContext("child-turn", { agentId: "main", sessionKey: CHILD });
    try {
      issue({
        sender: store[CHILD],
        senderRunId: "child-turn",
        senderSessionKey: CHILD,
        targetSessionKey: GRANDCHILD,
        target: store[GRANDCHILD],
      });
      await expect(
        resolve({
          inputProvenance: { ...followupProvenance, sourceSessionKey: CHILD },
          sessionEntry: store[GRANDCHILD],
          resolvedSessionKey: GRANDCHILD,
          admittedSessionId: GRANDCHILD_ID,
        }),
      ).resolves.toEqual({ ...GRANT, hops: 2, senderSessionKey: CHILD });
    } finally {
      clearAgentRunContext("child-turn");
    }
  });

  describe("issue rules", () => {
    const NO_RECEIPT = denied("no owner followup receipt for this run");
    it.each<[string, () => IssueOverrides]>([
      ["a non-owner sender", () => ({ sender: undefined })],
      ["steer", () => ({ mode: "steer" })],
      ["notify", () => ({ mode: "notify" })],
      ["an ACP target", () => ({ nativeTarget: false })],
      ["a cross-agent target", () => ({ sameAgent: false })],
      ["a sender without a run", () => ({ senderRunId: undefined })],
      [
        "a sender without a revision",
        () => ({ sender: mainEntry({ lifecycleRevision: undefined }) }),
      ],
      ["a missing target entry", () => ({ target: undefined })],
      [
        "a target not owner-spawned",
        () => ({ target: childEntry({ spawnedBySenderIsOwner: false }) }),
      ],
      [
        "a grandchild (not a direct child of the sender)",
        () => ({ target: childEntry({ spawnedBy: CHILD }) }),
      ],
      [
        "a target spawned by a reset sender",
        () => ({ sender: mainEntry({ sessionId: GRANDCHILD_ID }) }),
      ],
      [
        "a target spawned at a stale sender revision",
        () => ({ sender: mainEntry({ lifecycleRevision: "rev-new" }) }),
      ],
    ])("issues no receipt for %s", async (_label, overrides) => {
      issue(overrides());
      await expect(resolve()).resolves.toEqual(NO_RECEIPT);
    });

    it("issues for an explicit followup mode", async () => {
      issue({ mode: "followup" });
      await expect(resolve()).resolves.toEqual(GRANT);
    });

    it("revokes only its own receipt", async () => {
      const revoke = issue();
      revoke();
      await expect(resolve()).resolves.toEqual(NO_RECEIPT);
      const stale = issue();
      stale();
      const current = issue();
      stale();
      await expect(resolve()).resolves.toEqual(GRANT);
      current();
    });

    it("refuses a colliding idempotency key instead of replacing the receipt", async () => {
      issue();
      const collide = issue({ targetSessionKey: "agent:main:subagent:other" });
      collide();
      await expect(resolve()).resolves.toEqual(GRANT);
    });
  });
});
