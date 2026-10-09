import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { selectPooledInstance } from "./providerAccountPool.ts";

type TurnStartContext = Effect.Success<
  ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getTurnStartContext"]>
>;

export class ProviderAccountRoutingError extends Schema.TaggedError<ProviderAccountRoutingError>()(
  "ProviderAccountRoutingError",
  { runId: RunId, cause: Schema.Defect() },
) {}

export class ProviderAccountRoutingService extends Context.Service<
  ProviderAccountRoutingService,
  {
    readonly route: (input: {
      readonly projection: TurnStartContext;
      readonly runId: RunId;
    }) => Effect.Effect<TurnStartContext | null, ProviderAccountRoutingError>;
  }
>()("t3/orchestration-v2/ProviderAccountRoutingService") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  const route = Effect.fn("ProviderAccountRoutingService.route")(function* (input: {
    readonly projection: TurnStartContext;
    readonly runId: RunId;
  }) {
    const { runId } = input;
    let projection = input.projection;
    const initialRun = projection.runs.find((candidate) => candidate.id === runId);
    if (initialRun?.status !== "starting") return projection;
    let run = initialRun;
    const requestedInstance = yield* instances.getInstance(run.providerInstanceId);
    if (requestedInstance === undefined) return projection;
    const requested = yield* requestedInstance.snapshot.getSnapshot;
    if (
      requested?.continuation?.pooled !== true ||
      (requested.driver !== "codex" && requested.driver !== "claudeAgent")
    )
      return projection;
    const current = yield* projections.getTurnStartContext(projection.thread.id, runId);
    const currentRun = current.runs.find((candidate) => candidate.id === runId);
    if (currentRun?.status !== "starting" || currentRun.activeAttemptId !== run.activeAttemptId)
      return null;
    projection = current;
    run = currentRun;
    if (run.providerInstanceId !== initialRun.providerInstanceId) return projection;
    const snapshots = yield* Effect.forEach(
      yield* instances.listInstances,
      (instance) => instance.snapshot.getSnapshot,
    );

    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (providerThread === undefined || attempt === undefined) return projection;
    const previousRun = projection.runs.findLast(
      (candidate) => candidate.ordinal < run.ordinal && candidate.providerThreadId !== null,
    );
    const previousThread = projection.providerThreads.find(
      (candidate) => candidate.id === previousRun?.providerThreadId,
    );
    const previousSnapshot = snapshots.find(
      (snapshot) => snapshot.instanceId === previousThread?.providerInstanceId,
    );
    const sourceThread =
      previousThread?.nativeThreadRef != null &&
      previousSnapshot?.driver === requested.driver &&
      previousSnapshot.continuation?.pooled === true &&
      previousSnapshot.continuation.groupKey === requested.continuation.groupKey
        ? previousThread
        : providerThread;
    const liveSession = projection.providerSessions.find(
      (session) =>
        session.id === sourceThread.providerSessionId &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
    const now = yield* DateTime.now;
    const instanceId = selectPooledInstance({
      providers: snapshots,
      requestedInstanceId: run.modelSelection.instanceId,
      liveInstanceId: liveSession?.providerInstanceId,
      now: DateTime.toEpochMillis(now),
    });
    if (instanceId === run.providerInstanceId) return projection;
    if (adapters.getMetadata === undefined) return projection;
    const sourceMetadata = yield* adapters.getMetadata(sourceThread.providerInstanceId);
    const targetMetadata = yield* adapters.getMetadata(instanceId);
    if (
      !targetMetadata.enabled ||
      sourceMetadata.driver !== targetMetadata.driver ||
      sourceMetadata.continuationKey !== targetMetadata.continuationKey
    )
      return projection;

    const modelSelection = { ...run.modelSelection, instanceId };
    const routedRun = { ...run, providerInstanceId: instanceId, modelSelection };
    const routedAttempt = { ...attempt, providerInstanceId: instanceId };
    const routedThread = {
      ...projection.thread,
      providerInstanceId: instanceId,
      modelSelection,
      updatedAt: now,
    };
    const routedProviderThread = {
      ...providerThread,
      providerInstanceId: instanceId,
      providerSessionId: targetMetadata.capabilities.sessions
        .supportsMultipleProviderThreadsPerSession
        ? ids.derive.providerSession({ providerInstanceId: instanceId })
        : yield* ids.allocate.providerSession({
            providerInstanceId: instanceId,
            threadId: projection.thread.id,
          }),
      nativeThreadRef: sourceThread.nativeThreadRef,
      nativeConversationHeadRef: sourceThread.nativeConversationHeadRef,
      nativeMetadata: sourceThread.nativeMetadata,
      contextUsage: sourceThread.contextUsage,
      status: "not_loaded" as const,
      updatedAt: now,
    };
    const sessionsToDetach = projection.providerSessions.filter(
      (session) =>
        session.providerInstanceId === sourceThread.providerInstanceId &&
        session.providerInstanceId !== instanceId &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
    const eventBase = {
      threadId: projection.thread.id,
      runId,
      providerInstanceId: instanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "thread.provider-switched",
        payload: routedThread,
      },
      {
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "provider-thread.updated",
        payload: routedProviderThread,
      },
      {
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "run.updated",
        payload: routedRun,
      },
      {
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "run-attempt.updated",
        payload: routedAttempt,
      },
    ];
    for (const session of sessionsToDetach) {
      events.push({
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "provider-session.detached",
        providerInstanceId: session.providerInstanceId,
        payload: {
          providerSessionId: session.id,
          detachedAt: now,
          reason: "Pooled account selection changed.",
        },
      });
    }
    let notice: OrchestrationV2TurnItem | undefined;
    if (liveSession !== undefined && liveSession.providerInstanceId !== instanceId) {
      const label = (selected: typeof instanceId) =>
        snapshots.find((snapshot) => snapshot.instanceId === selected)?.displayName ?? selected;
      notice = {
        id: ids.derive.runSignalTurnItem({ runId, signal: "pooled-account-switched" }),
        type: "system_notice",
        threadId: projection.thread.id,
        runId,
        nodeId: run.rootNodeId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
        status: "completed",
        title: `Switched to ${label(instanceId)}`,
        message: `${label(liveSession.providerInstanceId)} reached its usage limit. Continuing this conversation with ${label(instanceId)}.`,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      events.push({
        ...eventBase,
        id: yield* ids.allocate.event({ threadId: projection.thread.id }),
        type: "turn-item.updated",
        payload: notice,
      });
    }
    const commandId = CommandId.make(`command:pool:${runId}:${instanceId}`);
    const write = yield* eventSink.writeIfRunCurrent({
      ...eventBase,
      commandId,
      activeAttemptId: attempt.id,
      expectedStatus: "starting",
      events,
      effects: sessionsToDetach.map((session) => ({
        id: `effect:${commandId}:provider-session.detach:${session.id}`,
        commandId,
        threadId: projection.thread.id,
        request: {
          type: "provider-session.detach" as const,
          providerSessionId: session.id,
          detail: "Pooled account selection changed.",
        },
      })),
    });
    if (!write.committed) return null;
    return {
      ...projection,
      thread: routedThread,
      runs: projection.runs.map((candidate) => (candidate.id === runId ? routedRun : candidate)),
      attempts: projection.attempts.map((candidate) =>
        candidate.id === attempt.id ? routedAttempt : candidate,
      ),
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThread.id ? routedProviderThread : candidate,
      ),
      providerSessions: projection.providerSessions.filter(
        (session) => !sessionsToDetach.includes(session),
      ),
      turnItems: notice === undefined ? projection.turnItems : [...projection.turnItems, notice],
    };
  });
  return ProviderAccountRoutingService.of({
    route: (input) =>
      commands
        .withLock(input.projection.thread.id, route(input))
        .pipe(
          Effect.mapError(
            (cause) => new ProviderAccountRoutingError({ runId: input.runId, cause }),
          ),
        ),
  });
});

export const layer = Layer.effect(ProviderAccountRoutingService, make);
