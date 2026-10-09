import {
  MessageId,
  NodeId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAccountRouting from "./ProviderAccountRoutingService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

type StartContext = Parameters<
  ProviderAccountRouting.ProviderAccountRoutingService["Service"]["route"]
>[0]["projection"];
const first = ProviderInstanceId.make("personal");
const second = ProviderInstanceId.make("work");
const now = DateTime.makeUnsafe("2026-10-09T12:00:00Z");
const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

function snapshot(
  instanceId: ProviderInstanceId,
  usedPercent: number,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId === first ? "Personal" : "Work",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-09T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    continuation: { groupKey: "shared-home", pooled: true },
    usageLimits: {
      checkedAt: "2026-10-09T12:00:00Z",
      windows: [
        { id: "session", kind: "session", label: "Session", usedPercent, windowDurationMins: 300 },
      ],
    },
    ...overrides,
  };
}

function startContext(driver: ProviderDriverKind, live = false): StartContext {
  const threadId = ThreadId.make("pooled-conversation");
  const providerThreadId = ProviderThreadId.make("pooled-native-conversation");
  const runId = RunId.make("pooled-turn");
  const rootNodeId = NodeId.make("pooled-root");
  const attemptId = RunAttemptId.make("pooled-attempt");
  const run: StartContext["runs"][number] = {
    id: runId,
    threadId,
    ordinal: live ? 2 : 1,
    providerInstanceId: first,
    modelSelection: {
      instanceId: first,
      model: "selected-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    providerThreadId,
    userMessageId: MessageId.make("pooled-message"),
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("pooled-project"),
      title: "Account routing",
      providerInstanceId: first,
      modelSelection: run.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
    },
    runs: [
      ...(live
        ? [{ ...run, id: RunId.make("previous-turn"), ordinal: 1, status: "completed" as const }]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: first,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: first,
        providerSessionId: ProviderSessionId.make("original-session"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: live
          ? { driver, nativeId: "original-native-conversation", strength: "strong" }
          : null,
        nativeConversationHeadRef: live
          ? { driver, nativeId: "last-native-turn", strength: "strong" }
          : null,
        nativeMetadata: { itemIdentityVersion: 2 },
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: run.ordinal,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerSessions: live
      ? [
          {
            id: ProviderSessionId.make("original-session"),
            driver,
            providerInstanceId: first,
            status: "ready",
            cwd: "/repo",
            model: "selected-model",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        ]
      : [],
    nodes: [],
    subagents: [],
    providerTurns: [],
    messages: [],
    checkpointScopes: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    hasConversation: live,
  };
}

function harness(input: {
  readonly driver?: ProviderDriverKind;
  readonly live?: boolean;
  readonly snapshots?: readonly ServerProvider[];
  readonly incompatibleMetadata?: boolean;
  readonly committed?: boolean;
}) {
  const driver = input.driver ?? ProviderDriverKind.make("codex");
  let projection = startContext(driver, input.live);
  const snapshots = input.snapshots ?? [
    snapshot(first, 80, { driver }),
    snapshot(second, 20, { driver }),
  ];
  const instances = snapshots.map(
    (provider) =>
      ({
        instanceId: provider.instanceId,
        snapshot: { getSnapshot: Effect.succeed(provider) },
      }) as ProviderInstance,
  );
  const writes: Array<Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]> = [];
  const writeIfRunCurrent = vi.fn(
    (write: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]) =>
      Effect.sync(() => {
        writes.push(write);
        if (input.committed === false) return { committed: false, storedEvents: [] };
        for (const event of write.events) {
          expect(isDomainEvent(event)).toBe(true);
          projection = Object.assign(
            {},
            projection,
            ProjectionStore.applyToProjection(
              Object.assign({}, projection, {
                runtimeRequests: [],
                checkpoints: [],
                plans: [],
                visibleTurnItems: [],
                updatedAt: now,
              }),
              event,
            ),
          );
        }
        return { committed: true, storedEvents: [] };
      }),
  );
  const layer = ProviderAccountRouting.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => Effect.sync(() => projection),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
          listInstances: Effect.succeed(instances),
        }),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          getMetadata: (instanceId) =>
            Effect.succeed({
              driver,
              continuationKey:
                input.incompatibleMetadata === true && instanceId === second
                  ? "other-home"
                  : "shared-home",
              enabled: true,
              capabilities: {
                ...CodexProviderCapabilitiesV2,
                sessions: {
                  ...CodexProviderCapabilitiesV2.sessions,
                  supportsMultipleProviderThreadsPerSession: driver === "codex",
                },
              },
            }),
        }),
      ),
    ),
  );
  const route = (context = projection) =>
    Effect.flatMap(ProviderAccountRouting.ProviderAccountRoutingService, (service) =>
      service.route({ projection: context, runId: context.runs.at(-1)!.id }),
    ).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    route,
    writes,
    projection: () => projection,
    initial: projection,
    update: (update: (current: StartContext) => StartContext) => {
      projection = update(projection);
    },
  };
}

describe.each(["codex", "claudeAgent"] as const)("%s pooled turn routing", (driverName) => {
  const driver = ProviderDriverKind.make(driverName);

  it("balances the first turn and persists the selected account without changing model options", async () => {
    const test = harness({ driver });
    const routed = await test.route();
    expect(routed?.thread.modelSelection).toEqual({
      ...test.initial.thread.modelSelection,
      instanceId: second,
    });
    expect(test.projection().runs.at(-1)?.providerInstanceId).toBe(second);
    expect(test.projection().attempts[0]?.providerInstanceId).toBe(second);
    expect(routed?.providerThreads[0]?.nativeThreadRef).toBeNull();
    expect(routed?.providerThreads[0]?.id).toBe(test.initial.providerThreads[0]?.id);
    expect(routed?.providerThreads[0]?.providerSessionId).not.toBe(
      test.initial.providerThreads[0]?.providerSessionId,
    );
    expect(test.writes[0]?.events.some((event) => event.type === "thread.provider-switched")).toBe(
      true,
    );
    expect(routed?.turnItems).toHaveLength(0);
  });

  it("keeps a live account until its quota is exhausted", async () => {
    const test = harness({ driver, live: true });
    expect(await test.route()).toBe(test.initial);
    expect(test.writes).toHaveLength(0);
  });

  it("swaps an exhausted account while retaining native history and scheduling only its session detach", async () => {
    const test = harness({
      driver,
      live: true,
      snapshots: [snapshot(first, 100, { driver }), snapshot(second, 20, { driver })],
    });
    const routed = await test.route();
    expect(routed?.providerThreads[0]?.nativeThreadRef).toEqual(
      test.initial.providerThreads[0]?.nativeThreadRef,
    );
    expect(routed?.providerThreads[0]?.nativeConversationHeadRef).toEqual(
      test.initial.providerThreads[0]?.nativeConversationHeadRef,
    );
    expect(routed?.providerThreads[0]?.nativeMetadata).toEqual(
      test.initial.providerThreads[0]?.nativeMetadata,
    );
    expect(routed?.runs[0]?.providerInstanceId).toBe(first);
    expect(routed?.runs.at(-1)?.providerInstanceId).toBe(second);
    expect(routed?.providerSessions).toHaveLength(0);
    expect(routed?.turnItems).toMatchObject([
      {
        type: "system_notice",
        title: "Switched to Work",
        message: "Personal reached its usage limit. Continuing this conversation with Work.",
      },
    ]);
    expect(test.writes).toHaveLength(1);
    expect(test.writes[0]?.effects).toMatchObject([
      {
        request: {
          type: "provider-session.detach",
          providerSessionId: test.initial.providerSessions[0]?.id,
        },
      },
    ]);
    expect(test.writes[0]?.activeAttemptId).toBe(test.initial.attempts[0]?.id);
    expect(test.writes[0]?.expectedStatus).toBe("starting");
    expect((await test.route(routed!))?.runs.at(-1)?.providerInstanceId).toBe(second);
    expect(test.writes).toHaveLength(1);
  });

  it("does not swap when every account is exhausted", async () => {
    const test = harness({
      driver,
      live: true,
      snapshots: [snapshot(first, 100, { driver }), snapshot(second, 100, { driver })],
    });
    expect(await test.route()).toBe(test.initial);
    expect(test.writes).toHaveLength(0);
  });
});

it("does not route an instance that opted out", async () => {
  const test = harness({
    snapshots: [
      snapshot(first, 90, { continuation: { groupKey: "shared-home", pooled: false } }),
      snapshot(second, 0),
    ],
  });
  expect(await test.route()).toBe(test.initial);
  expect(test.writes).toHaveLength(0);
});

it("does not cross account pool groups", async () => {
  const test = harness({
    snapshots: [
      snapshot(first, 90),
      snapshot(second, 0, { continuation: { groupKey: "other-home", pooled: true } }),
    ],
  });
  expect(await test.route()).toBe(test.initial);
  expect(test.writes).toHaveLength(0);
});

it("checks canonical continuation compatibility before moving a conversation", async () => {
  const test = harness({ incompatibleMetadata: true });
  expect(await test.route()).toBe(test.initial);
  expect(test.writes).toHaveLength(0);
});

it("does not continue startup when its attempt loses the guarded write", async () => {
  const test = harness({ committed: false });
  expect(await test.route()).toBeNull();
  expect(test.projection()).toBe(test.initial);
});

it("does not share single-thread Claude sessions between conversations", async () => {
  const test = harness({ driver: ProviderDriverKind.make("claudeAgent") });
  const routed = await test.route();
  expect(routed?.providerThreads[0]?.providerSessionId).not.toBe(
    await Effect.map(IdAllocator.IdAllocatorV2, (ids) =>
      ids.derive.providerSession({ providerInstanceId: second }),
    ).pipe(Effect.provide(IdAllocator.layer), Effect.runPromise),
  );
});

it("preserves thread edits made after the initial startup projection was read", async () => {
  const test = harness({});
  test.update((current) => ({
    ...current,
    thread: { ...current.thread, title: "Renamed during startup" },
  }));
  expect((await test.route(test.initial))?.thread.title).toBe("Renamed during startup");
  expect(test.projection().thread.title).toBe("Renamed during startup");
});

it("does not route a turn stopped after the initial startup projection was read", async () => {
  const test = harness({});
  test.update((current) => ({
    ...current,
    runs: current.runs.map((run) => ({ ...run, status: "interrupted" })),
  }));
  expect(await test.route(test.initial)).toBeNull();
  expect(test.writes).toHaveLength(0);
});
