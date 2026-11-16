import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveOwnerFollowupAuthority,
  type SpawnOwnerAuthority,
} from "../../gateway/agent-turn/spawn-owner-authority.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  bindRequesterYieldCronAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { resetOwnerFollowupReceiptsForTest } from "../subagents/owner-followup-receipts.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import {
  consumeRequesterCronAuthorityAdmission,
  retireRequesterFollowupAuthority,
  revokeRequesterCronAuthority,
  withRequesterFollowupAuthority,
} from "../subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { dispatchSessionsSendFollowup } from "./sessions-send-followup.js";
import type { SessionsSendStart } from "./sessions-send-tool.delivery.js";

const MAIN = "agent:main:main";
const CHILD = "agent:main:subagent:worker";
const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const CONTINUATION_RUN = "granted-continuation";

const fixture = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
  active: vi.fn(),
  start: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => ({}),
  runWithOperatorToolGatewayCleanupContext: (work: () => unknown) => work(),
  dispatchGatewayMethodInProcess: () => {
    throw new Error("Unexpected in-process dispatch");
  },
  captureOperatorToolGatewayContinuationContext: async () => ({
    signal: new AbortController().signal,
    assertCurrent: () => {},
    release: () => {},
    run: (work: () => unknown) => work(),
  }),
}));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: {
      connect: { scopes: ["operator.admin"] },
      internal: { operatorRoleActor: { kind: "system" } },
    },
  }),
}));
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async ({ sessionKey }: { sessionKey: string }) => ({
    storageTarget: { agentId: "main", canonicalKey: sessionKey },
    readCurrent: () => ({
      target: {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        entry: fixture.store[sessionKey],
      },
      membership: new Set(),
    }),
    release: () => {},
  }),
}));
vi.mock("../../gateway/session-sharing-policy.js", () => ({
  authorizePreparedSessionMutation: () => undefined,
}));
// mock-isolation: The lineage walk reads fixture session rows without a store worker.
vi.mock("../../gateway/session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async ({ key }: { key: string }) => ({
    cfg: {},
    storePath: "/synthetic/sessions.sqlite",
    canonicalKey: key,
    entry: fixture.store[key],
    store: fixture.store,
  }),
}));
vi.mock("../../process/gateway-work-admission.js", () => ({
  runWithGatewayDetachedWorkContinuation: (work: () => unknown) => work(),
}));
vi.mock("../prepared-model-runtime-generation-scope.js", () => ({
  runOutsidePreparedModelRuntimePluginGenerationScope: (work: () => unknown) => work(),
}));
vi.mock("../../logging/subsystem.js", () => {
  const logger = {
    warn: fixture.log,
    error: fixture.log,
    info: () => {},
    debug: () => {},
    trace: () => {},
    isEnabled: () => false,
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: () => {},
}));
// The Gateway boundary: steer decision and agent admission are emulated below.
vi.mock("./sessions-send-tool.delivery.js", () => ({
  trySessionsSendActiveRunDelivery: (...args: unknown[]) => fixture.active(...args),
  startSessionsSendAgentRun: (...args: unknown[]) => fixture.start(...args),
}));
vi.mock("./sessions-send-reply-flow.js", () => ({ startSessionsSendReplyFlow: vi.fn() }));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  adoptSubagentRunForRequesterTurn: () => {
    throw new Error("Unexpected steer adoption");
  },
  registerSubagentRun: async (params: Partial<SubagentRunRecord> & { runId: string }) => {
    subagentRuns.set(params.runId, {
      ...params,
      createdAt: 1,
      execution: { status: "running" },
      completion: { required: true },
      delivery: { status: "pending" },
    } as SubagentRunRecord);
  },
}));

type SendParams = Parameters<typeof dispatchSessionsSendFollowup>[0];
type ChildTurn = { runId: string; authority: SpawnOwnerAuthority };

/** Emulates the Gateway agent handler: in-process synthetic client, then the real verifier. */
function admitChildTurn(turns: ChildTurn[], disposition: "queued" | "failed" = "queued") {
  fixture.start.mockImplementation(async (params: SendParams): Promise<SessionsSendStart> => {
    const runId = String(params.sendParams.idempotencyKey);
    const entry = fixture.store[params.sessionStoreTarget.canonicalKey];
    const authority = await resolveOwnerFollowupAuthority({
      client: createSyntheticPluginRuntimeClient(),
      cfg: {},
      runId,
      inputProvenance: params.sendParams.inputProvenance,
      sessionEntry: entry,
      resolvedSessionKey: params.sessionStoreTarget.canonicalKey,
      admittedSessionId: entry!.sessionId,
      activeSessionAgentId: "main",
      assertCurrent: () => {},
    });
    turns.push({ runId, authority });
    if (disposition === "failed") {
      return { ok: false, result: { content: [], details: { status: "error" } } } as never;
    }
    return { ok: true, runId, targetDisposition: "queued" };
  });
}

/** Runs one sessions_send followup from the granted hop-1 continuation of the owner DM. */
async function followupFromGrantedContinuation(params: {
  runId: string;
  senderIsOwner: boolean;
  mode?: "followup" | "steer";
}) {
  const owner = { senderId: "owner", channel: "imessage", isCurrent: () => true };
  const scope = createCronCreatorAuthorityCapability(
    CONTINUATION_RUN,
    { kind: "unknown" },
    { source: "channel-owner", isCurrent: () => true },
    () => true,
    undefined,
    owner,
    undefined,
    1,
  )!;
  const { operationalRunInstance } = createTestAdmittedRunContext(CONTINUATION_RUN);
  const approvalAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(CONTINUATION_RUN, {
    agentId: "main",
    sessionKey: MAIN,
    sessionId: MAIN_ID,
  });
  try {
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: MAIN,
        operationalRunInstance,
        approvalAuthority,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(approvalAuthority),
      },
      () =>
        runWithCronCreatorAuthorityCapability(scope, async () => {
          const sendParams = {
            message: "[inter-session] continue the desktop task",
            agentId: "main",
            sessionKey: CHILD,
            idempotencyKey: params.runId,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only" as const,
            channel: "internal",
            inputProvenance: {
              kind: "inter_session" as const,
              sourceSessionKey: MAIN,
              sourceTool: "sessions_send",
            },
          };
          const result = await dispatchSessionsSendFollowup(
            {
              cfg: {},
              callGateway: vi.fn(),
              runId: params.runId,
              mode: params.mode,
              sendParams,
              sessionKey: CHILD,
              sessionStoreTarget: { agentId: "main", canonicalKey: CHILD },
              preparedTargetSessionId: CHILD_ID,
            } as unknown as SendParams,
            {
              requesterSessionKey: MAIN,
              requesterSession: { sessionId: MAIN_ID, lifecycleRevision: "rev-main" },
            } as unknown as Parameters<typeof dispatchSessionsSendFollowup>[1],
            {
              message: "continue the desktop task",
              ownChild: true,
              nativeChild: true,
              watch: false,
              requesterSessionKey: MAIN,
              requesterAgentId: "main",
              requesterTurnRunId: CONTINUATION_RUN,
              targetSession: fixture.store[CHILD],
              ownerSender: params.senderIsOwner ? fixture.store[MAIN] : undefined,
              withRequesterAuthority: bindRequesterYieldCronAuthority(CONTINUATION_RUN),
            },
          );
          result.completion?.close();
          return result;
        }),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(approvalAuthority);
    clearAgentRunContext(CONTINUATION_RUN);
  }
}

beforeEach(() => {
  fixture.store = {
    [MAIN]: {
      sessionId: MAIN_ID,
      updatedAt: 1,
      chatType: "direct",
      lifecycleRevision: "rev-main",
    },
    [CHILD]: {
      sessionId: CHILD_ID,
      updatedAt: 1,
      lifecycleRevision: "rev-child",
      spawnedBy: MAIN,
      spawnedBySessionId: MAIN_ID,
      parentSessionLifecycleRevision: "rev-main",
      spawnedBySenderIsOwner: true,
    },
  };
  fixture.active.mockResolvedValue({});
});
afterEach(() => {
  for (const entry of subagentRuns.values()) {
    retireRequesterFollowupAuthority(entry);
  }
  subagentRuns.clear();
  revokeRequesterCronAuthority(MAIN);
  resetOwnerFollowupReceiptsForTest();
  vi.clearAllMocks();
});

describe("owner followup into a retained child (msg226 shape)", () => {
  it("grants the child turn once and its completion wake inherits hop 2", async () => {
    const turns: ChildTurn[] = [];
    admitChildTurn(turns);
    const { start } = await followupFromGrantedContinuation({
      runId: "followup-1",
      senderIsOwner: true,
    });
    expect(start).toMatchObject({ ok: true, targetDisposition: "queued" });
    expect(turns).toEqual([
      {
        runId: "followup-1",
        authority: { granted: true, rootSessionKey: MAIN, hops: 1, senderSessionKey: MAIN },
      },
    ]);

    const entry = subagentRuns.get("followup-1");
    expect(entry).toBeDefined();
    const wake = await withRequesterFollowupAuthority(entry!, "wake-1", async () =>
      consumeRequesterCronAuthorityAdmission({
        runId: "wake-1",
        sessionKey: MAIN,
        sessionId: MAIN_ID,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
          sourceSessionKey: CHILD,
        },
      }),
    );
    expect(wake?.requesterOwner?.senderId).toBe("owner");
    expect(wake?.requesterOwnerHop).toBe(2);
  });

  it("denies the child turn when the sending turn was not owner", async () => {
    const turns: ChildTurn[] = [];
    admitChildTurn(turns);
    await followupFromGrantedContinuation({ runId: "followup-2", senderIsOwner: false });
    expect(turns).toEqual([
      {
        runId: "followup-2",
        authority: { granted: false, reason: "no owner followup receipt for this run" },
      },
    ]);
  });

  it("issues nothing when the followup steers an active child run", async () => {
    const turns: ChildTurn[] = [];
    admitChildTurn(turns);
    fixture.active.mockResolvedValue({
      ok: true,
      runId: "followup-3",
      targetDisposition: "steered",
      steeredRunId: "child-active",
    });
    const { start } = await followupFromGrantedContinuation({
      runId: "followup-3",
      senderIsOwner: true,
      mode: "steer",
    });
    expect(start).toMatchObject({ ok: true, targetDisposition: "steered" });
    expect(turns).toEqual([]);
    const late = await resolveOwnerFollowupAuthority({
      client: createSyntheticPluginRuntimeClient(),
      cfg: {},
      runId: "followup-3",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: MAIN,
        sourceTool: "sessions_send",
      },
      sessionEntry: fixture.store[CHILD],
      resolvedSessionKey: CHILD,
      admittedSessionId: CHILD_ID,
      activeSessionAgentId: "main",
      assertCurrent: () => {},
    });
    expect(late).toEqual({ granted: false, reason: "no owner followup receipt for this run" });
  });

  it("revokes the receipt when the Gateway does not admit the followup", async () => {
    const turns: ChildTurn[] = [];
    let issuedRunId: string | undefined;
    fixture.start.mockImplementation(async (params: SendParams) => {
      issuedRunId = String(params.sendParams.idempotencyKey);
      return { ok: false, result: { content: [], details: { status: "error" } } };
    });
    await followupFromGrantedContinuation({ runId: "followup-4", senderIsOwner: true });
    expect(issuedRunId).toBe("followup-4");
    const late = await resolveOwnerFollowupAuthority({
      client: createSyntheticPluginRuntimeClient(),
      cfg: {},
      runId: "followup-4",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: MAIN,
        sourceTool: "sessions_send",
      },
      sessionEntry: fixture.store[CHILD],
      resolvedSessionKey: CHILD,
      admittedSessionId: CHILD_ID,
      activeSessionAgentId: "main",
      assertCurrent: () => {},
    });
    expect(turns).toEqual([]);
    expect(late).toEqual({ granted: false, reason: "no owner followup receipt for this run" });
  });

  it.each([
    ["a non-queued disposition", { targetDisposition: "steered", runId: "followup-6" }],
    ["another run id", { targetDisposition: "queued", runId: "other-run" }],
  ] as const)("revokes the receipt when the Gateway admits %s", async (_label, admitted) => {
    const RUN = "followup-6";
    fixture.start.mockImplementation(async () => ({ ok: true, ...admitted }) as SessionsSendStart);
    await followupFromGrantedContinuation({ runId: RUN, senderIsOwner: true });
    const late = await resolveOwnerFollowupAuthority({
      client: createSyntheticPluginRuntimeClient(),
      cfg: {},
      runId: RUN,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: MAIN,
        sourceTool: "sessions_send",
      },
      sessionEntry: fixture.store[CHILD],
      resolvedSessionKey: CHILD,
      admittedSessionId: CHILD_ID,
      activeSessionAgentId: "main",
      assertCurrent: () => {},
    });
    expect(late).toEqual({ granted: false, reason: "no owner followup receipt for this run" });
  });

  it("issues nothing when the followup falls back to another session", async () => {
    const turns: ChildTurn[] = [];
    admitChildTurn(turns);
    fixture.active.mockResolvedValue({ fallbackSessionKey: "agent:main:subagent:other" });
    await followupFromGrantedContinuation({ runId: "followup-7", senderIsOwner: true });
    expect(turns).toEqual([
      {
        runId: "followup-7",
        authority: { granted: false, reason: "no owner followup receipt for this run" },
      },
    ]);
  });

  it("denies a child turn admitted after the granted continuation ended", async () => {
    let admitted: (() => Promise<SpawnOwnerAuthority>) | undefined;
    fixture.start.mockImplementation(async (params: SendParams): Promise<SessionsSendStart> => {
      const runId = String(params.sendParams.idempotencyKey);
      admitted = () =>
        resolveOwnerFollowupAuthority({
          client: createSyntheticPluginRuntimeClient(),
          cfg: {},
          runId,
          inputProvenance: params.sendParams.inputProvenance,
          sessionEntry: fixture.store[CHILD],
          resolvedSessionKey: CHILD,
          admittedSessionId: CHILD_ID,
          activeSessionAgentId: "main",
          assertCurrent: () => {},
        });
      return { ok: true, runId, targetDisposition: "queued" };
    });
    await followupFromGrantedContinuation({ runId: "followup-5", senderIsOwner: true });
    await expect(admitted!()).resolves.toEqual({
      granted: false,
      reason: "owner followup sender run has ended",
    });
  });
});
