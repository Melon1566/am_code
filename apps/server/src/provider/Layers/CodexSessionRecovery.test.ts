import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe } from "vite-plus/test";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type CodexSessionRuntimeSendTurnInput,
} from "./CodexSessionRuntime.ts";
import {
  isRetryableCodexTurnError,
  makeRecoveringCodexSessionRuntime,
} from "./CodexSessionRecovery.ts";

const threadId = ThreadId.make("recovery-thread");
const options: CodexSessionRuntimeOptions = {
  threadId,
  binaryPath: "test-codex",
  cwd: "/project",
  homePath: "/codex-home",
  runtimeMode: "approval-required",
  model: "original-model",
};

const transportError = new CodexErrors.CodexAppServerTransportError({
  operation: "read-process-exit-status",
  cause: new Error("SIGKILL"),
});

const makeHarness = Effect.fn("makeHarness")(function* () {
  const observed = yield* Queue.unbounded<ProviderEvent>();
  const starting = yield* Deferred.make<void>();
  const allowStart = yield* Deferred.make<void>();
  const peers: Array<{
    options: CodexSessionRuntimeOptions;
    inputs: Array<CodexSessionRuntimeSendTurnInput>;
    emit: (method: string, payload?: unknown) => Effect.Effect<void>;
    closed: number;
    failSend: boolean;
  }> = [];
  let failStarts = false;
  let holdStarts = false;
  let constructionCount = 0;
  const factory = Effect.fn("fakeCodex")(function* (runtimeOptions: CodexSessionRuntimeOptions) {
    constructionCount += 1;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const index = peers.length;
    let serial = 0;
    let session: ProviderSession = {
      provider: ProviderDriverKind.make("codex"),
      threadId,
      status: "ready",
      runtimeMode: runtimeOptions.runtimeMode,
      cwd: runtimeOptions.cwd,
      model: runtimeOptions.model ?? "original-model",
      resumeCursor: runtimeOptions.resumeCursor ?? { threadId: "saved-native-thread" },
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    };
    const emit = (method: string, payload?: unknown) =>
      Queue.offer(events, {
        id: EventId.make(`event-${index}-${serial++}`),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        kind: "notification",
        createdAt: "2026-09-22T00:00:00.000Z",
        method,
        ...(method === "turn/started" ? { turnId: TurnId.make(`turn-${index}`) } : {}),
        ...(payload !== undefined ? { payload } : {}),
      }).pipe(Effect.asVoid);
    const peer = {
      options: runtimeOptions,
      inputs: [] as Array<CodexSessionRuntimeSendTurnInput>,
      emit,
      closed: 0,
      failSend: false,
    };
    peers.push(peer);
    return {
      start: () =>
        Effect.gen(function* () {
          if (failStarts) return yield* transportError;
          if (holdStarts) {
            yield* Deferred.succeed(starting, undefined);
            yield* Deferred.await(allowStart);
          }
          yield* emit("session/ready");
          return session;
        }),
      getSession: Effect.sync(() => session),
      sendTurn: (input) =>
        Effect.gen(function* () {
          if (peer.failSend) return yield* transportError;
          peer.inputs.push(input);
          session = { ...session, status: "running", activeTurnId: TurnId.make(`turn-${index}`) };
          yield* emit("turn/started");
          return { threadId, turnId: session.activeTurnId! };
        }),
      close: Effect.sync(() => {
        peer.closed += 1;
      }),
      interruptTurn: () =>
        emit("turn/completed", {
          threadId: "saved-native-thread",
          turn: { id: `turn-${index}`, items: [], status: "interrupted", error: null },
        }),
      compactThread: Effect.void,
      readThread: Effect.succeed({ threadId: "saved-native-thread", turns: [] }),
      rollbackThread: () => Effect.succeed({ threadId: "saved-native-thread", turns: [] }),
      uploadFeedback: () => Effect.succeed({ threadId: "saved-native-thread" }),
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      events: Stream.fromQueue(events),
    } satisfies CodexSessionRuntimeShape;
  });
  const runtime = yield* makeRecoveringCodexSessionRuntime(options, factory);
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(observed, event)),
    Effect.forkScoped,
  );
  yield* runtime.start();
  const next = Effect.fn("nextEvent")(function* (method: string) {
    while (true) {
      const event = yield* Queue.take(observed);
      if (event.method === method) return event;
    }
  });
  return {
    runtime,
    peers,
    next,
    starting: Deferred.await(starting),
    allowStart: Deferred.succeed(allowStart, undefined),
    holdStarts: () => {
      holdStarts = true;
    },
    failStarts: () => {
      failStarts = true;
    },
    get constructionCount() {
      return constructionCount;
    },
  };
});

const completed = (
  errorInfo: CodexSchema.V2TurnCompletedNotification__CodexErrorInfo | null = null,
) => ({
  threadId: "saved-native-thread",
  turn: {
    id: "turn-0",
    status: errorInfo ? "failed" : "completed",
    items: [],
    error: errorInfo
      ? { message: "Request failed", codexErrorInfo: errorInfo, additionalDetails: null }
      : null,
  },
});

describe("Codex unattended recovery", () => {
  it.effect("resumes an accepted turn without another message or replaying attachments", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({
        input: "Finish the task",
        attachments: [{ type: "image", url: "data:image/png;base64,AA==" }],
        model: "selected-model",
        effort: "high",
        serviceTier: "fast",
        interactionMode: "plan",
      });
      yield* h.next("turn/started");
      yield* h.peers[0]!.emit("session/exited");
      yield* h.next("process/stderr");
      NodeAssert.equal((yield* h.runtime.getSession).status, "connecting");
      yield* TestClock.adjust("5 seconds");
      yield* h.next("turn/started");
      NodeAssert.equal(h.peers.length, 2);
      NodeAssert.equal(h.peers[0]!.closed, 1);
      NodeAssert.deepEqual(h.peers[1]!.options, {
        ...options,
        model: "selected-model",
        serviceTier: "fast",
        requireResume: true,
        resumeCursor: { threadId: "saved-native-thread" },
      });
      NodeAssert.deepEqual(h.peers[1]!.inputs, [
        {
          model: "selected-model",
          effort: "high",
          serviceTier: "fast",
          interactionMode: "plan",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a failed network turn after Codex exhausts its own attempts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      yield* h.peers[0]!.emit(
        "turn/completed",
        completed({
          responseTooManyFailedAttempts: { httpStatusCode: 503 },
        }),
      );
      yield* h.next("process/stderr");
      yield* TestClock.adjust("5 seconds");
      yield* h.next("turn/started");
      NodeAssert.deepEqual(h.peers[1]!.inputs, [{}]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const action of ["interrupt", "close"] as const) {
    it.effect(`${action} cancels pending recovery`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.sendTurn({ input: "Finish the task" });
        yield* h.next("turn/started");
        yield* h.peers[0]!.emit("session/exited");
        yield* h.next("process/stderr");
        yield* action === "interrupt" ? h.runtime.interruptTurn() : h.runtime.close;
        yield* TestClock.adjust("10 minutes");
        NodeAssert.equal(h.peers.length, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("does not resurrect an idle or completed conversation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.peers[0]!.emit("session/exited");
      yield* h.next("session/exited");
      yield* TestClock.adjust("10 minutes");
      NodeAssert.equal(h.peers.length, 1);
      yield* h.runtime.sendTurn({ input: "New work" });
      yield* h.next("turn/started");
      NodeAssert.equal(h.peers.length, 2);
      yield* h.peers[1]!.emit("turn/completed", completed());
      yield* h.next("turn/completed");
      yield* h.peers[1]!.emit("session/exited");
      yield* h.next("session/exited");
      yield* TestClock.adjust("10 minutes");
      NodeAssert.equal(h.peers.length, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops after five attempts even when each replacement process exits", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      for (const delay of [5, 15, 30, 60, 120]) {
        yield* h.peers.at(-1)!.emit("session/exited");
        const warning = yield* h.next("process/stderr");
        NodeAssert.match(warning.message!, new RegExp(`in ${delay} seconds`));
        yield* TestClock.adjust(`${delay} seconds`);
        yield* h.next("turn/started");
      }
      yield* h.peers.at(-1)!.emit("session/exited");
      const failure = yield* h.next("error");
      NodeAssert.match(failure.message!, /after 5 attempts/);
      yield* TestClock.adjust("1 hour");
      NodeAssert.equal(h.peers.length, 6);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries failed process startup with bounded delays and closes each attempt", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      h.failStarts();
      yield* h.peers[0]!.emit("session/exited");
      for (const delay of [5, 15, 30, 60, 120]) {
        yield* h.next("process/stderr");
        yield* TestClock.adjust(`${delay} seconds`);
      }
      yield* h.next("error");
      NodeAssert.equal(h.constructionCount, 6);
      NodeAssert.ok(h.peers.every((peer) => peer.closed === 1));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers a send rejected by a dead transport without losing the pending message", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.peers[0]!.failSend = true;
      const result = yield* h.runtime.sendTurn({ input: "New request" }).pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      yield* h.next("process/stderr");
      yield* TestClock.adjust("5 seconds");
      yield* h.next("turn/started");
      NodeAssert.deepEqual(h.peers[1]!.inputs, [{ input: "New request" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a new user message replaces pending recovery without a duplicate continuation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      yield* h.peers[0]!.emit("session/exited");
      yield* h.next("process/stderr");
      yield* h.runtime.sendTurn({ input: "Use the revised requirements" });
      yield* h.next("turn/started");
      yield* TestClock.adjust("10 minutes");
      NodeAssert.equal(h.peers.length, 2);
      NodeAssert.deepEqual(h.peers[1]!.inputs, [{ input: "Use the revised requirements" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("Stop cancels an in-flight resume and releases its replacement process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      h.holdStarts();
      yield* h.peers[0]!.emit("session/exited");
      yield* h.next("process/stderr");
      yield* TestClock.adjust("5 seconds");
      yield* h.starting;
      yield* h.runtime.interruptTurn();
      yield* h.allowStart;
      yield* TestClock.adjust("10 minutes");
      NodeAssert.equal(h.peers.length, 2);
      NodeAssert.equal(h.peers[1]!.closed, 1);
      NodeAssert.deepEqual(h.peers[1]!.inputs, []);
      NodeAssert.equal((yield* h.runtime.getSession).status, "closed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("times out an unresponsive replacement instead of waiting forever", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.sendTurn({ input: "Finish the task" });
      yield* h.next("turn/started");
      h.holdStarts();
      yield* h.peers[0]!.emit("session/exited");
      yield* h.next("process/stderr");
      yield* TestClock.adjust("5 seconds");
      yield* h.starting;
      yield* TestClock.adjust("60 seconds");
      const retry = yield* h.next("process/stderr");
      NodeAssert.match(retry.message!, /attempt 2\/5/);
      NodeAssert.equal(h.peers[1]!.closed, 1);
      NodeAssert.deepEqual(h.peers[1]!.inputs, []);
      yield* h.runtime.interruptTurn();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects late sends after the session was closed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.close;
      const result = yield* h.runtime.sendTurn({ input: "Late message" }).pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(h.peers.length, 1);
      NodeAssert.equal(h.peers[0]!.closed, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const info of [
    "unauthorized",
    "usageLimitExceeded",
    "contextWindowExceeded",
    "sandboxError",
  ] as const) {
    it.effect(`leaves ${info} for user attention`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.sendTurn({ input: "Finish the task" });
        yield* h.next("turn/started");
        yield* h.peers[0]!.emit("turn/completed", completed(info));
        yield* h.next("turn/completed");
        yield* TestClock.adjust("10 minutes");
        NodeAssert.equal(h.peers.length, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});

describe("Codex retry classification", () => {
  it("only retries transient transport and server errors", () => {
    for (const status of [null, 408, 429, 500, 502, 503]) {
      NodeAssert.equal(
        isRetryableCodexTurnError({ httpConnectionFailed: { httpStatusCode: status } }),
        true,
      );
    }
    for (const status of [400, 401, 403, 404]) {
      NodeAssert.equal(
        isRetryableCodexTurnError({ responseStreamDisconnected: { httpStatusCode: status } }),
        false,
      );
    }
    NodeAssert.equal(isRetryableCodexTurnError("serverOverloaded"), true);
    NodeAssert.equal(isRetryableCodexTurnError("other"), false);
  });
});
