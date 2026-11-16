import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const { config, callGatewayMock } = vi.hoisted(() => ({
  config: {
    session: { mainKey: "main", scope: "per-sender" },
    agents: { entries: { main: {} } },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  } as OpenClawConfig,
  callGatewayMock: vi.fn(),
}));
// mock-isolation: Fixture children are native; no ACP metadata is read.
vi.mock("../acp/runtime/session-meta-readonly.js", async () => {
  const { rowToAcpSessionMeta } = await vi.importActual<
    typeof import("../acp/runtime/session-meta-readonly.js")
  >("../acp/runtime/session-meta-readonly.js");
  return { rowToAcpSessionMeta, readAcpSessionMetaForEntryAsync: async () => undefined };
});
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("../commands/agent.js", () => ({ agentCommandFromIngress: vi.fn() }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import {
  endChildRun,
  type GatewayCall,
} from "./openclaw-tools.sessions-send-requester-retirement.test-support.js";
import {
  resetOwnerFollowupReceiptsForTest,
  takeOwnerFollowupReceipt,
} from "./subagents/owner-followup-receipts.js";
import { observeRootWork } from "./subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const PARENT = "agent:main:dashboard:owner-parent";
const CHILD = "agent:main:dashboard:owner-child";
const PARENT_TURN = "owner-parent-turn";

async function writeEntry(sessionKey: string, entry: SessionEntry) {
  const agentId = parseAgentSessionKey(sessionKey)!.agentId;
  await replaceSessionEntry(
    {
      agentId,
      sessionKey,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
    },
    entry,
  );
}

describe("sessions_send owner followup receipts", () => {
  let state: OpenClawTestState;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  beforeEach(async () => {
    settleRootWork = observeRootWork();
    state = await createOpenClawTestState({ scenario: "minimal" });
    config.session = {
      mainKey: "main",
      scope: "per-sender",
      dmScope: "main",
      store: state.path("configured", "agents", "{agentId}", "sessions", "sessions.json"),
    };
    setRuntimeConfigSnapshot(config);
    resetGatewayWorkAdmission();
    callGatewayMock.mockReset();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    await resetSubagentRegistryForTests();
  });
  afterEach(async () => {
    resetOwnerFollowupReceiptsForTest();
    await settleRootWork(true);
    expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(0);
    await resetSubagentRegistryForTests();
    resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([true, false])(
    "issues a receipt only when the host verified the sender as owner (%s)",
    async (senderIsOwner) => {
      await writeEntry(PARENT, {
        sessionId: "owner-parent",
        updatedAt: 1,
        chatType: "direct",
        lifecycleRevision: "rev-parent",
      });
      await writeEntry(CHILD, {
        sessionId: "owner-child",
        updatedAt: 1,
        spawnedBy: PARENT,
        spawnedBySessionId: "owner-parent",
        parentSessionLifecycleRevision: "rev-parent",
        spawnedBySenderIsOwner: true,
        spawnDepth: 1,
      });
      let runId = "";
      let receipt: ReturnType<typeof takeOwnerFollowupReceipt>;
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        if (request.method === "agent") {
          runId = String(request.params?.idempotencyKey);
          receipt = takeOwnerFollowupReceipt(runId);
          return { runId, status: "accepted", targetDisposition: "queued" };
        }
        if (request.method === "agent.wait") {
          return { runId, status: "error", startedAt: 1, endedAt: Date.now(), error: "stop" };
        }
        return {};
      });
      await createSessionsSendTool({
        agentSessionKey: PARENT,
        requesterTurnRunId: PARENT_TURN,
        senderIsOwner,
        config,
        callGateway: callGatewayMock,
      }).execute("owner-followup", {
        sessionKey: CHILD,
        mode: "followup",
        timeoutSeconds: 1,
        message: "Continue",
      });
      expect(runId).not.toBe("");
      expect(receipt).toEqual(
        senderIsOwner
          ? expect.objectContaining({
              senderRunId: PARENT_TURN,
              senderSessionKey: PARENT,
              senderSessionId: "owner-parent",
              senderRevision: "rev-parent",
              targetSessionKey: CHILD,
              targetSessionId: "owner-child",
              idempotencyKey: runId,
            })
          : undefined,
      );
      await settleRequesterAfterSessionSpawns({
        requesterSessionKey: PARENT,
        requesterAgentId: "main",
        requesterTurnRunId: PARENT_TURN,
        requesterYielded: false,
        acceptedSessionSpawns: [{ runId, childSessionKey: CHILD, expectsCompletionMessage: false }],
      });
      await endChildRun(runId, CHILD, { disposition: "visible", text: "done" });
    },
  );
});
