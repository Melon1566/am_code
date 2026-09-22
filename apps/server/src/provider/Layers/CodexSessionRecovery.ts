import {
  EventId,
  ProviderDriverKind,
  type ProviderEvent,
  type ProviderSession,
  type TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  CodexResumeCursorSchema,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  makeCodexSessionRuntime,
} from "./CodexSessionRuntime.ts";

const RETRY_DELAYS = [5, 15, 30, 60, 120] as const;
const isCompleted = Schema.is(CodexSchema.V2TurnCompletedNotification);
const isResumeCursor = Schema.is(CodexResumeCursorSchema);

function isTransportFailure(error: { readonly _tag: string }): boolean {
  return (
    error._tag === "CodexAppServerTransportError" ||
    error._tag === "CodexAppServerProcessExitedError" ||
    error._tag === "CodexAppServerSpawnError" ||
    error._tag === "CodexAppServerInputStreamEndedError"
  );
}

export function isRetryableCodexTurnError(
  info: CodexSchema.V2TurnCompletedNotification__CodexErrorInfo | null | undefined,
): boolean {
  if (typeof info === "string") {
    return ["serverOverloaded", "internalServerError", "rateLimitExceeded"].includes(info);
  }
  if (!info || "activeTurnNotSteerable" in info) return false;
  const status =
    "httpConnectionFailed" in info
      ? info.httpConnectionFailed.httpStatusCode
      : "responseStreamConnectionFailed" in info
        ? info.responseStreamConnectionFailed.httpStatusCode
        : "responseStreamDisconnected" in info
          ? info.responseStreamDisconnected.httpStatusCode
          : info.responseTooManyFailedAttempts.httpStatusCode;
  return status == null || status === 408 || status === 429 || status >= 500;
}

/**
 * Keeps recovery inside the Codex boundary. Each attempt owns a separate process
 * scope; replacing it preserves the event stream and the saved native thread.
 */
export const makeRecoveringCodexSessionRuntime = Effect.fn("makeRecoveringCodexSessionRuntime")(
  function* (
    options: CodexSessionRuntimeOptions,
    createRuntime: (
      options: CodexSessionRuntimeOptions,
    ) => Effect.Effect<
      CodexSessionRuntimeShape,
      CodexSessionRuntimeError,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
    > = makeCodexSessionRuntime,
  ) {
    const ownerScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const mutex = yield* Semaphore.make(1);
    let current: { runtime: CodexSessionRuntimeShape; scope: Scope.Closeable } | undefined;
    let recovery: Fiber.Fiber<void> | undefined;
    let recoveryRequested = false;
    let closed = false;
    let dead = false;
    let working = false;
    let interrupted = false;
    let attempts = 0;
    let resumeCursor = options.resumeCursor;
    let turnOptions: CodexSessionRuntimeSendTurnInput = {};
    let pendingInput: CodexSessionRuntimeSendTurnInput | undefined;
    let lastSession: ProviderSession;

    const emit = Effect.fn("CodexSessionRecovery.emit")(function* (
      method: string,
      message: string,
    ) {
      yield* Queue.offer(events, {
        id: EventId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new CodexErrors.CodexAppServerIdentifierGenerationError({
                  purpose: "provider-event",
                  cause,
                }),
            ),
          ),
        ),
        provider: ProviderDriverKind.make("codex"),
        ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
        threadId: options.threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        kind: "notification",
        method,
        message,
      });
    });

    const dispose = Effect.fn("CodexSessionRecovery.dispose")(function* () {
      const previous = current;
      current = undefined;
      if (previous) {
        yield* previous.runtime.close;
        yield* Scope.close(previous.scope, Exit.void);
      }
    });

    const open = Effect.fn("CodexSessionRecovery.open")(function* (
      recovering: boolean,
    ): Effect.fn.Return<CodexSessionRuntimeShape, CodexSessionRuntimeError> {
      const scope = yield* Scope.make();
      const runtime = yield* createRuntime({
        ...options,
        ...(recovering && resumeCursor ? { resumeCursor, requireResume: true } : {}),
        ...(turnOptions.model ? { model: turnOptions.model } : {}),
        ...(turnOptions.serviceTier ? { serviceTier: turnOptions.serviceTier } : {}),
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const instance = { runtime, scope };
      current = instance;
      dead = recovering;
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (current !== instance || closed) return;
            if (event.method === "turn/started") {
              pendingInput = undefined;
              working = !interrupted;
            }
            yield* Queue.offer(events, event);
            if (current !== instance || closed) return;
            if (event.method === "session/exited") {
              dead = true;
              if (working) yield* scheduleRecovery();
            } else if (event.method === "turn/completed" && isCompleted(event.payload)) {
              if (
                working &&
                event.payload.turn.status === "failed" &&
                isRetryableCodexTurnError(event.payload.turn.error?.codexErrorInfo)
              ) {
                yield* scheduleRecovery();
              } else {
                working = false;
                if (event.payload.turn.status === "completed") attempts = 0;
              }
            }
          }),
        ),
        Effect.forkIn(scope),
      );
      return runtime;
    });

    const rememberSession = Effect.fn("CodexSessionRecovery.rememberSession")(function* (
      runtime: CodexSessionRuntimeShape,
    ) {
      const session = yield* runtime.getSession;
      if (isResumeCursor(session.resumeCursor)) resumeCursor = session.resumeCursor;
      lastSession = session;
      return session;
    });

    const resume = Effect.fn("CodexSessionRecovery.resume")(function* () {
      if (!resumeCursor) {
        return yield* new CodexErrors.CodexAppServerRequestError({
          code: -32600,
          errorMessage: "Cannot recover Codex without a saved conversation.",
        });
      }
      yield* dispose();
      const runtime = yield* open(true);
      yield* runtime.start().pipe(Effect.onError(dispose));
      dead = false;
      yield* rememberSession(runtime);
      return runtime;
    });

    const scheduleRecovery = Effect.fn("CodexSessionRecovery.schedule")(
      function* (): Effect.fn.Return<void> {
        if (closed || interrupted || !working) return;
        if (recovery) {
          recoveryRequested = true;
          return;
        }
        recovery = yield* Effect.gen(function* () {
          while (working) {
            if (closed || interrupted) return;
            recoveryRequested = false;
            const delay = RETRY_DELAYS[attempts];
            if (delay === undefined) {
              working = false;
              yield* emit(
                "error",
                "Codex could not recover after 5 attempts. Send a message to try again.",
              );
              return;
            }
            attempts += 1;
            yield* emit("session/connecting", "Recovering the interrupted Codex session.");
            yield* emit(
              "process/stderr",
              `Codex was interrupted. Resuming the saved conversation in ${delay} seconds (attempt ${attempts}/5).`,
            );
            yield* Effect.sleep(`${delay} seconds`);
            const result = yield* mutex
              .withPermit(
                Effect.gen(function* () {
                  if (closed || interrupted || !working) return;
                  const runtime = yield* resume();
                  // An accepted turn is already in the saved conversation. An empty
                  // input continues it without repeating its user prompt or tools.
                  yield* runtime.sendTurn(pendingInput ?? turnOptions);
                  pendingInput = undefined;
                  yield* rememberSession(runtime);
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: "60 seconds",
                    orElse: () =>
                      Effect.fail(
                        new CodexErrors.CodexAppServerTransportError({
                          operation: "read-input-stream",
                          cause: new Error("Timed out restarting the Codex session."),
                        }),
                      ),
                  }),
                  Effect.onError(dispose),
                ),
              )
              .pipe(Effect.result);
            if (result._tag === "Success") {
              if (recoveryRequested) continue;
              return;
            }
            if (!isTransportFailure(result.failure)) {
              working = false;
              yield* emit("error", `Codex recovery stopped: ${result.failure.message}`);
              return;
            }
          }
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Codex recovery failed", { cause })),
          Effect.ensuring(
            Effect.gen(function* () {
              recovery = undefined;
              if (recoveryRequested) yield* scheduleRecovery();
            }),
          ),
          Effect.forkIn(ownerScope),
        );
      },
    );

    const cancelRecovery = Effect.gen(function* () {
      interrupted = true;
      working = false;
      recoveryRequested = false;
      const fiber = recovery;
      recovery = undefined;
      if (fiber) yield* Fiber.interrupt(fiber);
    });

    lastSession = yield* (yield* open(false)).getSession;
    const requireRuntime = Effect.suspend(() =>
      current
        ? Effect.succeed(current.runtime)
        : Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({})),
    );
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      yield* cancelRecovery;
      yield* dispose();
      yield* emit("session/closed", "Session stopped").pipe(Effect.ignore);
      yield* Queue.shutdown(events);
    });
    yield* Effect.addFinalizer(() => close);

    return {
      start: () =>
        requireRuntime.pipe(
          Effect.flatMap((runtime) =>
            runtime.start().pipe(Effect.tap(() => rememberSession(runtime))),
          ),
        ),
      getSession: Effect.suspend(() =>
        (current ? rememberSession(current.runtime) : Effect.succeed(lastSession)).pipe(
          Effect.map((session) =>
            recovery && (dead || session.status !== "running")
              ? { ...session, status: "connecting" as const, activeTurnId: undefined }
              : closed || dead || !current
                ? { ...session, status: "closed" as const, activeTurnId: undefined }
                : session,
          ),
        ),
      ),
      sendTurn: (input) =>
        Effect.gen(function* () {
          if (closed) return yield* new CodexErrors.CodexAppServerProcessExitedError({});
          yield* cancelRecovery;
          interrupted = false;
          attempts = 0;
          working = true;
          pendingInput = input;
          const { input: _text, attachments: _attachments, ...settings } = input;
          turnOptions = { ...turnOptions, ...settings };
          return yield* mutex
            .withPermit(
              Effect.gen(function* () {
                if (closed) return yield* new CodexErrors.CodexAppServerProcessExitedError({});
                const runtime = dead || !current ? yield* resume() : current.runtime;
                const result = yield* runtime.sendTurn(input);
                pendingInput = undefined;
                yield* rememberSession(runtime);
                return result;
              }),
            )
            .pipe(
              Effect.tapError((error) =>
                isTransportFailure(error)
                  ? scheduleRecovery()
                  : Effect.sync(() => {
                      working = false;
                    }),
              ),
            );
        }),
      interruptTurn: (turnId?: TurnId) =>
        Effect.gen(function* () {
          const wasRecovering = recovery !== undefined;
          yield* cancelRecovery;
          if (current && !dead) yield* current.runtime.interruptTurn(turnId);
          if (wasRecovering) yield* emit("session/ready", "Codex recovery canceled.");
        }),
      compactThread: requireRuntime.pipe(Effect.flatMap((runtime) => runtime.compactThread)),
      readThread: requireRuntime.pipe(Effect.flatMap((runtime) => runtime.readThread)),
      rollbackThread: (count) =>
        requireRuntime.pipe(Effect.flatMap((runtime) => runtime.rollbackThread(count))),
      uploadFeedback: (reason?: string) =>
        requireRuntime.pipe(Effect.flatMap((runtime) => runtime.uploadFeedback(reason))),
      respondToRequest: (id, decision) =>
        requireRuntime.pipe(Effect.flatMap((runtime) => runtime.respondToRequest(id, decision))),
      respondToUserInput: (id, answers) =>
        requireRuntime.pipe(Effect.flatMap((runtime) => runtime.respondToUserInput(id, answers))),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  },
);
