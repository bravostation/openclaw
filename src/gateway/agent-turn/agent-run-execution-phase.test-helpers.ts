import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { startAgentRunExecution } from "./agent-run-execution-phase.js";

export function createExecution(
  options: {
    aborted?: boolean;
    assertContextCurrent?: () => void;
    pendingInputSettlement?: () => Promise<void>;
  } = {},
) {
  const pluginGeneration: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: createPluginMetadataSnapshot({
      config: {},
      manifestRegistry: makeRegistry([]),
    }),
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const abortCleanup = vi.fn();
  const gatewayRelease = vi.fn();
  const callerRelease = vi.fn();
  const { promise: runtimeReleased, resolve: resolveRuntimeReleased } = createDeferred();
  const runtimeRelease = vi.fn(async () => resolveRuntimeReleased());
  const controller = new AbortController();
  if (options.aborted) {
    controller.abort();
  }
  return {
    abortCleanup,
    gatewayRelease,
    callerRelease,
    runtimeRelease,
    runtimeReleased,
    params: {
      assertContextCurrent: options.assertContextCurrent,
      prepared: {
        releaseCallerAuthority: callerRelease,
        activeGatewayWorkAdmission: {
          release: gatewayRelease,
          run: async (run: () => Promise<void>) => await run(),
        },
        activeRunAbort: {
          cleanup: abortCleanup,
          controller,
          registered: false,
        },
        effectiveAllowModelOverride: false,
        lifecycleStorePath: "",
        operationalRunInstance: {},
        preparedModelRuntimeLease: {
          [Symbol.asyncDispose]: runtimeRelease,
          snapshot: {},
          pluginGeneration,
        },
        replyDispatchRuntime: {
          config: { runtime: "A" },
          pluginGeneration,
        },
        unpersistedOffloadedRefs: [],
        userTurn: {
          recorder: options.pendingInputSettlement
            ? { waitForPendingInputSettlement: options.pendingInputSettlement }
            : undefined,
          execApprovalFollowupHandoffClaimId: "claim",
          message: "continue",
          senderIsOwner: false,
          suppressPromptPersistence: false,
        },
        workspaceOverride: "/workspace/A",
      },
      request: {},
      cfg: {},
      activeSessionAgentId: "main",
      delivery: {},
      isNewSession: false,
      isRawModelRun: true,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: false,
      suppressVisibleSessionEffects: true,
      images: [],
      imageOrder: [],
      media: [],
      runId: "owner-test",
      agentDedupeKeys: [],
      bestEffortDeliver: false,
      lifecycleGeneration: "test",
      preserveUserFacingSessionModelState: false,
      skipAgentInitialSessionTouch: true,
      canUseInternalRuntimeHandoff: false,
      client: null,
      context: {
        getSessionEventSubscriberConnIds: () => new Set(),
        dedupe: new Map(),
        deps: {},
        logGateway: { error: vi.fn(), warn: vi.fn() },
      },
      io: {
        emitAcceptance: vi.fn(),
        emitFinal: vi.fn(),
      },
      releaseCronContinuationClaimWithRecovery: async () => true,
    } as unknown as Parameters<typeof startAgentRunExecution>[0],
  };
}
