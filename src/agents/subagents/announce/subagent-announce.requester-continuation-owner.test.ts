import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayCronCreatorAuthorityAdmission } from "../../../gateway/server-methods/cron-creator-authority-admission.js";
import { createRequesterInitialTransferFixture } from "../registry/subagent-registry-requester-yield.test-support.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

vi.mock("../../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async (params: { agentId: string; sessionKey: string }) => {
    let active = true;
    const target = {
      agentId: params.agentId,
      canonicalKey: params.sessionKey,
      storeKey: params.sessionKey,
      storeKeys: [params.sessionKey],
      storePath: "/synthetic/requester.sqlite",
    };
    return {
      storageTarget: target,
      bindCreation: vi.fn(),
      readCurrent: () => {
        if (!active) {
          throw new Error("Requester session facts retired");
        }
        return {
          target: { ...target, entry: { sessionId: "sess-main", updatedAt: 1 } },
          membership: new Set(),
        };
      },
      release: () => {
        active = false;
      },
    };
  },
}));

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

type YieldingTurn = "owner" | "non-owner" | "no capture";

type ContinuationOutcome = {
  admission: GatewayCronCreatorAuthorityAdmission | undefined;
  senderIsOwner: boolean;
  grants: string[];
};

/**
 * Runs a requester yield and its settle-wake through the real capture, the real
 * single-use gateway admission, and the real dispatch finalizer. Nothing in the
 * requester cron authority chain is mocked.
 */
async function yieldThenSettleWake(
  yieldingTurn: YieldingTurn,
  hooks: { beforeWake?: () => void; afterAdmission?: () => void } = {},
): Promise<ContinuationOutcome> {
  const { resolveGatewayCronCreatorAuthorityAdmission } =
    await import("../../../gateway/server-methods/cron-creator-authority-admission.js");
  const { createSyntheticPluginRuntimeClient } =
    await import("../../../gateway/server-plugin-runtime-client.js");
  const { finalizePreparedAgentRunUserTurn } =
    await import("../../../gateway/agent-turn/agent-run-user-turn.js");
  const {
    claimAgentRunDelegatedAuthority,
    registerAgentRunContext,
    releaseAgentRunDelegatedAuthority,
  } = await import("../../../infra/agent-run-registry.js");
  const { createTestAdmittedRunContext } =
    await import("../../admitted-run-context.test-support.js");
  const { createCronCreatorAuthorityCapability, runWithCronCreatorAuthorityCapability } =
    await import("../../cron-creator-authority-context.js");
  const { withGatewayToolCallerIdentity } = await import("../../tools/gateway-caller-context.js");
  const { markRequesterTurnYieldedInRuns, settleRequesterTurnAfterSessionSpawns } =
    await import("../registry/subagent-registry-requester-yield.js");

  const sourceRunId = `owner-turn-${yieldingTurn.replace(" ", "-")}`;
  let child = makeSettledChild({
    runId: `${sourceRunId}-child`,
    requesterAgentId: "main",
    requesterTurnRunId: sourceRunId,
    completion: { required: true },
    requesterSettleWake: undefined,
  });
  const runs = new Map([[child.runId, child]]);
  const transfer = createRequesterInitialTransferFixture(runs, () => {});
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  const original = createTestAdmittedRunContext(sourceRunId).operationalRunInstance;
  const originalAuthority = claimAgentRunDelegatedAuthority(original);
  registerAgentRunContext(sourceRunId, {
    sessionKey: REQUESTER,
    sessionId: "sess-main",
    agentId: "main",
  });
  onTestFinished(() => {
    releaseAgentRunDelegatedAuthority(originalAuthority);
  });
  const ownerCurrent = () => true;
  const capability =
    yieldingTurn === "owner"
      ? createCronCreatorAuthorityCapability(
          sourceRunId,
          { kind: "unknown" },
          { source: "channel-owner", isCurrent: ownerCurrent },
          undefined,
          undefined,
          { isCurrent: ownerCurrent, senderId: "owner-handle", channel: "imessage" },
        )
      : yieldingTurn === "non-owner"
        ? createCronCreatorAuthorityCapability(
            sourceRunId,
            { kind: "unknown" },
            { source: "control-ui-admin" },
          )
        : undefined;
  const yieldTurn = () =>
    withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: REQUESTER, approvalAuthority: originalAuthority },
      async () => {
        const requester = {
          requesterSessionKey: REQUESTER,
          requesterAgentId: "main",
          requesterTurnRunId: sourceRunId,
        };
        const preparedAuthority = prepareRequesterCronAuthority(requester);
        try {
          expect(
            await markRequesterTurnYieldedInRuns({
              ...requester,
              preparedAuthority: preparedAuthority ?? null,
              runs,
              transfer,
            }),
          ).toBe(1);
        } finally {
          await preparedAuthority?.release();
        }
        expect(
          await settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: REQUESTER,
            requesterAgentId: "main",
            requesterTurnRunId: sourceRunId,
            requesterYielded: true,
            acceptedSessionSpawns: [
              {
                runId: child.runId,
                childSessionKey: child.childSessionKey,
                expectsCompletionMessage: true,
              },
            ],
            runs,
            transfer,
            schedule: () => {},
          }),
        ).toBe(true);
      },
    );
  await (capability ? runWithCronCreatorAuthorityCapability(capability, yieldTurn) : yieldTurn());
  const published = runs.get(child.runId)!;
  child = copySubagentRunRuntimeOwner(published, { ...published });
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
  releaseAgentRunDelegatedAuthority(originalAuthority);
  hooks.beforeWake?.();

  const outcome: ContinuationOutcome = { admission: undefined, senderIsOwner: false, grants: [] };
  deliverSpy.mockImplementationOnce(async (params) => {
    const runId = String(params.directIdempotencyKey);
    const client = createSyntheticPluginRuntimeClient();
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceSessionKey: child.childSessionKey,
      sourceTool: String(params.sourceTool),
    };
    outcome.admission = resolveGatewayCronCreatorAuthorityAdmission({
      runId,
      resolvedSessionKey: REQUESTER,
      sessionId: "sess-main",
      client,
      request: { message: String(params.triggerMessage), idempotencyKey: runId },
      inputProvenance,
      hasRestoredCronContinuation: false,
      isOneShotModelRun: false,
      isRestartRecoveryResumeRun: false,
    });
    hooks.afterAdmission?.();
    const prepared = { senderIsOwner: false } as Parameters<
      typeof finalizePreparedAgentRunUserTurn
    >[0];
    finalizePreparedAgentRunUserTurn(
      prepared,
      {
        client,
        inputProvenance,
        sessionEntry: { sessionId: "sess-main", updatedAt: 1, chatType: "direct" },
        resolvedSessionKey: REQUESTER,
        runId,
        context: { logGateway: { info: (message: string) => outcome.grants.push(message) } },
      },
      outcome.admission,
    );
    outcome.senderIsOwner = prepared.senderIsOwner;
    return { delivered: true, path: "direct" };
  });
  expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }))).toBe(
    true,
  );
  return outcome;
}

describe("requester continuation owner authority through the real capture and admission", () => {
  it("carries the yielding owner turn into its settle-wake continuation", async () => {
    const outcome = await yieldThenSettleWake("owner");
    expect(outcome.admission?.requesterOwner).toMatchObject({ senderId: "owner-handle" });
    expect(outcome.senderIsOwner).toBe(true);
    expect(outcome.grants).toEqual([
      expect.stringContaining("agent owner authority from requester continuation"),
    ]);
  });

  it("admits a non-owner sibling yield as a continuation but never as owner", async () => {
    const outcome = await yieldThenSettleWake("non-owner");
    expect(outcome.admission).toBeDefined();
    expect(outcome.admission?.requesterOwner).toBeUndefined();
    expect(outcome.senderIsOwner).toBe(false);
    expect(outcome.grants).toEqual([]);
  });

  it("admits nothing when the yielding turn captured no authority", async () => {
    const outcome = await yieldThenSettleWake("no capture");
    expect(outcome.admission).toBeUndefined();
    expect(outcome.senderIsOwner).toBe(false);
    expect(outcome.grants).toEqual([]);
  });

  it("drops a captured owner when a gateway restart lands between yield and settle-wake", async () => {
    const { rotateAgentRunRegistryLifecycleGeneration } =
      await import("../../../infra/agent-run-registry.js");
    const outcome = await yieldThenSettleWake("owner", {
      beforeWake: rotateAgentRunRegistryLifecycleGeneration,
    });
    expect(outcome.admission).toBeUndefined();
    expect(outcome.senderIsOwner).toBe(false);
    expect(outcome.grants).toEqual([]);
  });

  it("revokes an admitted owner continuation when the lifecycle generation rotates before dispatch", async () => {
    const { rotateAgentRunRegistryLifecycleGeneration } =
      await import("../../../infra/agent-run-registry.js");
    const outcome = await yieldThenSettleWake("owner", {
      afterAdmission: rotateAgentRunRegistryLifecycleGeneration,
    });
    expect(outcome.admission?.requesterOwner).toMatchObject({ senderId: "owner-handle" });
    expect(outcome.admission?.isCurrent?.()).toBe(false);
    expect(outcome.senderIsOwner).toBe(false);
    expect(outcome.grants).toEqual([]);
  });
});
