import * as NodeAssert from "node:assert/strict";
import * as CodexClient from "effect-codex-app-server/client";
import { it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import {
  isCodexTransportFailure,
  isRetryableCodexTurnError,
  makeCodexSessionRecovery,
  makeRecoveringCodexClient,
} from "./CodexSessionRecovery.ts";

const makeHarness = Effect.fn("makeRecoveryHarness")(function* () {
  const retrying = yield* Queue.unbounded<{ attempt: number; delay: number }>();
  const recovered = yield* Queue.unbounded<string>();
  const failed = yield* Deferred.make<void>();
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let active = true;
  let failing = false;
  let permanent = false;
  let held = false;
  let recoveries = 0;
  const recovery = yield* makeCodexSessionRecovery({
    isActive: () => Effect.sync(() => active),
    recover: (key) =>
      Effect.gen(function* () {
        recoveries += 1;
        if (held) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        if (failing) return yield* Effect.fail(permanent ? "permanent" : "transport");
        yield* Queue.offer(recovered, key);
      }),
    isRetryable: (failure) => failure === "transport",
    retrying: (_key, attempt, delay) =>
      Queue.offer(retrying, { attempt, delay }).pipe(Effect.asVoid),
    failed: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
  });
  return {
    ...recovery,
    retrying,
    recovered,
    failed,
    entered,
    release,
    recoveries: () => recoveries,
    setFailing: (value: boolean, isPermanent = false) => {
      failing = value;
      permanent = isPermanent;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    hold: () => {
      held = true;
    },
  };
});

describe("recovering Codex client", () => {
  it.effect.each(["typed", "raw"])(
    "fails an in-flight %s request on process exit even when stdout remains open",
    (kind) =>
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<void>();
        const interrupted = yield* Deferred.make<void>();
        let terminate: Effect.Effect<void> = Effect.void;
        const pending = Effect.gen(function* () {
          yield* Queue.offer(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
        const native = CodexClient.CodexAppServerClient.of({
          request: () => pending,
          notify: () => Effect.void,
          raw: {
            notifications: Stream.never,
            requests: Stream.never,
            request: () => pending,
            notify: () => Effect.void,
            respond: () => Effect.void,
            respondError: () => Effect.void,
          },
          handleServerNotification: () => Effect.void,
          handleServerRequest: () => Effect.void,
          handleUnknownServerNotification: () => Effect.void,
          handleUnknownServerRequest: () => Effect.void,
        });
        const connection = yield* makeRecoveringCodexClient<never>({
          open: (onTermination) => {
            terminate = onTermination;
            return Effect.succeed(native);
          },
        });
        const request =
          kind === "typed"
            ? connection.client.request("account/logout", undefined)
            : connection.client.raw.request("account/logout", undefined);
        const waiting = yield* request.pipe(Effect.forkChild);
        yield* Queue.take(entered);
        yield* terminate;
        const result = yield* Fiber.join(waiting).pipe(Effect.result);
        NodeAssert.ok(Result.isFailure(result));
        NodeAssert.equal(result.failure._tag, "CodexAppServerProcessExitedError");
        yield* Deferred.await(interrupted);
        NodeAssert.equal(yield* connection.isTransportClosed, true);
      }).pipe(Effect.scoped),
  );
});

describe("Codex session recovery", () => {
  it.effect("retries transport failures five times with bounded backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.setFailing(true);
      yield* harness.schedule("run");
      for (const [index, delay] of [5, 15, 30, 60, 120].entries()) {
        NodeAssert.deepEqual(yield* Queue.take(harness.retrying), { attempt: index + 1, delay });
        yield* TestClock.adjust(`${delay} seconds`);
      }
      yield* Deferred.await(harness.failed);
      yield* TestClock.adjust("1 hour");
      NodeAssert.equal(harness.recoveries(), 5);
    }).pipe(Effect.scoped),
  );

  it.effect("does not reset the budget when a recovered process repeatedly crashes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const [index, delay] of [5, 15, 30, 60, 120].entries()) {
        yield* harness.schedule("run");
        NodeAssert.deepEqual(yield* Queue.take(harness.retrying), { attempt: index + 1, delay });
        yield* TestClock.adjust(`${delay} seconds`);
        NodeAssert.equal(yield* Queue.take(harness.recovered), "run");
      }
      yield* harness.schedule("run");
      yield* Deferred.await(harness.failed);
      NodeAssert.equal(harness.recoveries(), 5);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a queued retry on Stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.schedule("run");
      yield* Queue.take(harness.retrying);
      yield* harness.cancel("run");
      harness.setActive(false);
      yield* TestClock.adjust("1 hour");
      yield* harness.schedule("run");
      NodeAssert.equal(harness.recoveries(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a recovery already waiting on the replacement process", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.hold();
      yield* harness.schedule("run");
      yield* Queue.take(harness.retrying);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(harness.entered);
      yield* harness.cancel("run");
      yield* Deferred.succeed(harness.release, undefined);
      yield* TestClock.adjust("1 hour");
      NodeAssert.equal(harness.recoveries(), 1);
      NodeAssert.equal(yield* Queue.size(harness.recovered), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not restart a completed turn while its retry is queued", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.schedule("run");
      yield* Queue.take(harness.retrying);
      harness.setActive(false);
      yield* harness.complete("run");
      yield* TestClock.adjust("1 hour");
      NodeAssert.equal(harness.recoveries(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry a permanent resume failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.setFailing(true, true);
      yield* harness.schedule("run");
      yield* Queue.take(harness.retrying);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(harness.failed);
      yield* TestClock.adjust("1 hour");
      NodeAssert.equal(harness.recoveries(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("never restarts after the owner scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* harness.schedule("run");
      yield* Queue.take(harness.retrying);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 hour");
      yield* harness.schedule("run");
      NodeAssert.equal(harness.recoveries(), 0);
    }),
  );

  it("classifies only transport failures and transient provider responses as recoverable", () => {
    for (const tag of [
      "CodexAppServerTransportError",
      "CodexAppServerProcessExitedError",
      "CodexAppServerSpawnError",
      "CodexAppServerInputStreamEndedError",
    ]) {
      NodeAssert.equal(isCodexTransportFailure({ _tag: tag }), true);
    }
    NodeAssert.equal(isCodexTransportFailure({ _tag: "CodexAppServerRequestError" }), false);
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
    for (const info of [
      "usageLimitExceeded",
      "contextWindowExceeded",
      "unauthorized",
      "other",
    ] as const) {
      NodeAssert.equal(isRetryableCodexTurnError(info), false);
    }
    NodeAssert.equal(isRetryableCodexTurnError("serverOverloaded"), true);
  });
});
