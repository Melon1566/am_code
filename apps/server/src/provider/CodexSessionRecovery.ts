import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const RETRY_DELAYS = [5, 15, 30, 60, 120] as const;

export function isCodexTransportFailure(error: { readonly _tag: string }): boolean {
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
  if (!info) return false;
  const status =
    "httpConnectionFailed" in info
      ? info.httpConnectionFailed.httpStatusCode
      : "responseStreamConnectionFailed" in info
        ? info.responseStreamConnectionFailed.httpStatusCode
        : "responseStreamDisconnected" in info
          ? info.responseStreamDisconnected.httpStatusCode
          : "responseTooManyFailedAttempts" in info
            ? info.responseTooManyFailedAttempts.httpStatusCode
            : undefined;
  return (
    status !== undefined && (status === null || status === 408 || status === 429 || status >= 500)
  );
}

export const makeCodexSessionRecovery = Effect.fn("makeCodexSessionRecovery")(function* <
  Failure,
>(options: {
  readonly isActive: (key: string) => Effect.Effect<boolean>;
  readonly recover: (key: string) => Effect.Effect<void, Failure>;
  readonly isRetryable: (failure: Failure) => boolean;
  readonly retrying: (key: string, attempt: number, delay: number) => Effect.Effect<void>;
  readonly failed: (key: string, failure?: Failure) => Effect.Effect<void>;
}) {
  const scope = yield* Scope.Scope;
  const attempts = new Map<
    string,
    { count: number; fiber?: Fiber.Fiber<void> | undefined; requested: boolean }
  >();
  let closed = false;
  const cancel = Effect.fn("CodexSessionRecovery.cancel")(function* (key: string) {
    const attempt = attempts.get(key);
    attempts.delete(key);
    if (attempt?.fiber !== undefined) yield* Fiber.interrupt(attempt.fiber);
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* Effect.forEach([...attempts.keys()], cancel, { discard: true });
    }),
  );
  const schedule = Effect.fn("CodexSessionRecovery.schedule")(function* (key: string) {
    if (closed || !(yield* options.isActive(key))) return;
    const attempt = attempts.get(key) ?? { count: 0, requested: false };
    if (attempt.fiber !== undefined) {
      attempt.requested = true;
      return;
    }
    attempts.set(key, attempt);
    attempt.fiber = yield* Effect.gen(function* () {
      while (true) {
        if (closed || attempts.get(key) !== attempt || !(yield* options.isActive(key))) return;
        const delay = RETRY_DELAYS[attempt.count];
        if (delay === undefined) {
          yield* options.failed(key);
          return;
        }
        attempt.count += 1;
        yield* options.retrying(key, attempt.count, delay);
        yield* Effect.sleep(`${delay} seconds`);
        if (closed || attempts.get(key) !== attempt || !(yield* options.isActive(key))) return;
        attempt.requested = false;
        const result = yield* options.recover(key).pipe(Effect.result);
        if (result._tag === "Success") {
          if (attempt.requested) continue;
          return;
        }
        if (!options.isRetryable(result.failure)) {
          yield* options.failed(key, result.failure);
          return;
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          attempt.fiber = undefined;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const complete = (key: string) =>
    Effect.sync(() => {
      attempts.delete(key);
    });
  return { schedule, cancel, complete };
});

export const makeRecoveringCodexClient = Effect.fn("makeRecoveringCodexClient")(function* <
  Failure,
>(options: {
  readonly open: (
    onTermination: Effect.Effect<void>,
  ) => Effect.Effect<CodexClient.CodexAppServerClient["Service"], Failure, Scope.Scope>;
}) {
  const registrations: Array<
    (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<void>
  > = [];
  const restartPermit = yield* Semaphore.make(1);
  let current:
    | {
        client: CodexClient.CodexAppServerClient["Service"];
        scope: Scope.Closeable;
        termination: Deferred.Deferred<never, CodexErrors.CodexAppServerProcessExitedError>;
      }
    | undefined;
  let closed = false;
  let dead = false;
  let openingScope: Scope.Closeable | undefined;
  let transportClosed = false;
  let onTermination: Effect.Effect<void> = Effect.void;
  const dispose = Effect.gen(function* () {
    const previous = current;
    current = undefined;
    if (previous !== undefined) {
      yield* Deferred.fail(
        previous.termination,
        new CodexErrors.CodexAppServerProcessExitedError({}),
      );
      yield* Scope.close(previous.scope, Exit.void);
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* dispose;
    }),
  );
  const open = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const termination = yield* Deferred.make<never, CodexErrors.CodexAppServerProcessExitedError>();
    openingScope = scope;
    let terminated = false;
    const result = yield* options
      .open(
        Effect.suspend(() => {
          if (closed || terminated || (current?.scope !== scope && openingScope !== scope))
            return Effect.void;
          terminated = true;
          transportClosed = true;
          dead = true;
          return Deferred.fail(
            termination,
            new CodexErrors.CodexAppServerProcessExitedError({}),
          ).pipe(Effect.andThen(onTermination));
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
        Effect.ensuring(
          Effect.sync(() => {
            openingScope = undefined;
          }),
        ),
        Effect.result,
      );
    if (result._tag === "Failure") {
      yield* Scope.close(scope, Exit.void);
      return yield* Effect.fail(result.failure);
    }
    current = { client: result.success, scope, termination };
    dead = terminated;
    transportClosed = terminated;
    yield* Effect.forEach(registrations, (register) => register(result.success), { discard: true });
  });
  yield* open;
  const use = Effect.suspend(() =>
    current !== undefined && !closed
      ? Effect.succeed(current.client)
      : Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({})),
  );
  const runWithClient = <Success, RequestFailure>(
    operation: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => Effect.Effect<Success, RequestFailure>,
  ) =>
    Effect.suspend(() => {
      const selected = current;
      if (selected === undefined || closed || transportClosed)
        return Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({}));
      return operation(selected.client).pipe(
        Effect.raceFirst(Deferred.await(selected.termination)),
      );
    });
  const register = (
    registration: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      registrations.push(registration);
      if (current !== undefined) yield* registration(current.client);
    });
  const client = CodexClient.CodexAppServerClient.of({
    request: (method, payload) => runWithClient((client) => client.request(method, payload)),
    notify: (method, payload) => runWithClient((client) => client.notify(method, payload)),
    raw: {
      notifications: Stream.unwrap(
        use.pipe(
          Effect.orDie,
          Effect.map((client) => client.raw.notifications),
        ),
      ),
      requests: Stream.unwrap(
        use.pipe(
          Effect.orDie,
          Effect.map((client) => client.raw.requests),
        ),
      ),
      request: (method, payload) => runWithClient((client) => client.raw.request(method, payload)),
      notify: (method, payload) => runWithClient((client) => client.raw.notify(method, payload)),
      respond: (id, payload) => runWithClient((client) => client.raw.respond(id, payload)),
      respondError: (id, payload) =>
        runWithClient((client) => client.raw.respondError(id, payload)),
    },
    handleServerNotification: (method, handler) =>
      register((client) =>
        client.handleServerNotification(method, (payload) =>
          Effect.suspend(() =>
            current?.client === client && !closed ? handler(payload) : Effect.void,
          ),
        ),
      ),
    handleServerRequest: (method, handler) =>
      register((client) =>
        client.handleServerRequest(method, (payload) =>
          Effect.suspend(() =>
            current?.client === client && !closed
              ? handler(payload)
              : Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({})),
          ),
        ),
      ),
    handleUnknownServerNotification: (handler) =>
      register((client) =>
        client.handleUnknownServerNotification((method, payload) =>
          Effect.suspend(() =>
            current?.client === client && !closed ? handler(method, payload) : Effect.void,
          ),
        ),
      ),
    handleUnknownServerRequest: (handler) =>
      register((client) =>
        client.handleUnknownServerRequest((method, payload) =>
          Effect.suspend(() =>
            current?.client === client && !closed
              ? handler(method, payload)
              : Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({})),
          ),
        ),
      ),
  });
  return {
    client,
    isTransportClosed: Effect.sync(() => transportClosed || current === undefined),
    restart: restartPermit.withPermit(
      Effect.gen(function* () {
        if (!dead || closed) return;
        yield* dispose;
        yield* open;
      }),
    ),
    invalidate: Effect.suspend(() => {
      if (closed) return Effect.void;
      dead = true;
      return onTermination;
    }),
    onTermination: (handler: Effect.Effect<void>) =>
      Effect.sync(() => {
        onTermination = handler;
      }),
  };
});
