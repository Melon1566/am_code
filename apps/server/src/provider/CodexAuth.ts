/**
 * In-app sign-in for one Codex instance. Drives `account/login/start` on a
 * scoped `codex app-server` whose `CODEX_HOME` is the instance's effective
 * home, so an auth-overlay instance signs into its own shadow `auth.json`.
 * The process lives for the whole flow: Codex's localhost OAuth callback
 * server runs inside it, and `account/login/completed` arrives on the same
 * connection.
 *
 * Two ChatGPT methods: `browser` returns a URL that finishes on the host
 * machine; `deviceCode` returns a short code the user enters anywhere, which
 * is the path for phones and remote browsers.
 *
 * @module provider/CodexAuth
 */
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CodexAppServerClient } from "effect-codex-app-server/client";

import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

/** Device-code sign-ins wait on a human typing a code somewhere else. */
const AUTH_TIMEOUT_MS = 10 * 60_000;
const LOGOUT_TIMEOUT = "90 seconds";
const FAILED_MESSAGE = "Codex sign-in failed. Start sign-in again.";
const EXPIRED_MESSAGE = "Codex sign-in expired. Start sign-in again.";
const isSetupError = Schema.is(ProviderSetupError);

/** The slice of the app-server client a sign-in needs; tests supply a fake. */
export type CodexLoginClient = Pick<
  CodexAppServerClient["Service"],
  "request" | "handleServerNotification"
>;

export interface CodexAuthOptions {
  readonly instanceId: ProviderInstanceId;
  /** Scoped: the app-server is killed when the scope closes. */
  readonly openClient: Effect.Effect<CodexLoginClient, ProviderSetupError, Scope.Scope>;
  /** Runs after Codex reports a successful login; re-probe the instance here. */
  readonly onAuthenticated: Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
}

export interface CodexAuth {
  readonly controller: ProviderAuthController;
}

interface AuthFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly expiresAtMillis: number;
  state: ProviderAuthState;
  fiber: Fiber.Fiber<void, never> | undefined;
}

interface AuthSnapshot {
  readonly ownerSessionId: string | null;
  readonly state: ProviderAuthState;
}

function visibleSnapshot(snapshot: AuthSnapshot, ownerSessionId: string): ProviderAuthState {
  if (snapshot.ownerSessionId === null || snapshot.ownerSessionId === ownerSessionId) {
    return snapshot.state;
  }
  const busy = ["starting", "waiting", "verifying"].includes(snapshot.state.phase);
  return {
    ...snapshot.state,
    flowId: null,
    authorizationUrl: null,
    userCode: null,
    expiresAt: null,
    ...(busy ? { message: "Sign-in is in progress in another client." } : {}),
  };
}

/** Never surfaces Codex's own error text, which can carry URLs or account detail. */
function safeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && isSetupError(error.value)) return error.value.detail;
  return FAILED_MESSAGE;
}

export const makeCodexAuth = Effect.fn("makeCodexAuth")(function* (
  options: CodexAuthOptions,
): Effect.fn.Return<CodexAuth, never, Crypto.Crypto | Scope.Scope> {
  const crypto = yield* Crypto.Crypto;
  const instanceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void>();
  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    userCode: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make<AuthSnapshot>({
    ownerSessionId: null,
    state: emptyState,
  });
  let activeFlow: AuthFlow | undefined;
  let operation: "idle" | "auth" | "logout" | "cancel" | "closed" = "idle";

  const setupError = (name: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: name, detail });
  const publishFlow = (flow: AuthFlow, state: ProviderAuthState) => {
    flow.state = state;
    return SubscriptionRef.set(snapshot, { ownerSessionId: flow.ownerSessionId, state });
  };

  const finishFlow = (flow: AuthFlow, result: Exit.Exit<void, unknown>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeFlow !== flow) return;
        activeFlow = undefined;
        operation = "idle";
        yield* publishFlow(flow, {
          ...flow.state,
          phase: Exit.isSuccess(result) ? "succeeded" : "failed",
          authorizationUrl: null,
          userCode: null,
          expiresAt: null,
          message: Exit.isSuccess(result) ? "Signed in to Codex." : safeFailure(result.cause),
        });
      }),
    );

  const runSignIn = (
    flow: AuthFlow,
    stopSessions: Effect.Effect<void, ProviderSetupError>,
    method: ProviderAuthMethod,
  ) =>
    Effect.gen(function* () {
      yield* stopSessions;
      const client = yield* options.openClient;
      const completed = yield* Deferred.make<void, ProviderSetupError>();
      let loginId: string | undefined;
      yield* client.handleServerNotification("account/login/completed", (payload) =>
        Effect.gen(function* () {
          if (loginId !== undefined && payload.loginId && payload.loginId !== loginId) return;
          if (payload.success) {
            yield* Deferred.succeed(completed, undefined);
            return;
          }
          yield* Effect.logWarning("codex sign-in reported a failure", {
            instanceId: options.instanceId,
            error: payload.error ?? null,
          });
          yield* Deferred.fail(completed, setupError("start", FAILED_MESSAGE));
        }),
      );
      const started = yield* client
        .request(
          "account/login/start",
          method === "deviceCode" ? { type: "chatgptDeviceCode" } : { type: "chatgpt" },
        )
        .pipe(
          Effect.mapError((cause) => {
            void cause;
            return setupError("start", "Codex could not start sign-in. Try again.");
          }),
        );
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow) return;
          switch (started.type) {
            case "chatgpt":
              loginId = started.loginId;
              yield* publishFlow(flow, {
                ...flow.state,
                phase: "waiting",
                authorizationUrl: started.authUrl,
                userCode: null,
                message: "Open the sign-in page to continue in your browser.",
              });
              return;
            case "chatgptDeviceCode":
              loginId = started.loginId;
              yield* publishFlow(flow, {
                ...flow.state,
                phase: "waiting",
                authorizationUrl: started.verificationUrl,
                userCode: started.userCode,
                message: "Open the verification page and enter the code.",
              });
              return;
            default:
              return yield* setupError("start", "Codex started an unexpected sign-in type.");
          }
        }),
      );
      yield* Deferred.await(completed);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow) return;
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            userCode: null,
            message: "Checking the Codex account.",
          });
        }),
      );
      yield* options.onAuthenticated;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: AUTH_TIMEOUT_MS,
        orElse: () => Effect.fail(setupError("start", EXPIRED_MESSAGE)),
      }),
      Effect.exit,
      Effect.flatMap((result) => finishFlow(flow, result)),
    );

  const stopFlow = (flow: AuthFlow, phase: "cancelled" | "failed", message: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const detached = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (activeFlow !== flow) return false;
            activeFlow = undefined;
            operation = "cancel";
            yield* publishFlow(flow, {
              ...flow.state,
              phase,
              authorizationUrl: null,
              userCode: null,
              expiresAt: null,
              message,
            });
            return true;
          }),
        );
        if (!detached) return;
        // Interrupting the flow closes its scope, which kills the app-server
        // and with it Codex's pending login.
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* lock.withPermits(1)(
          Effect.sync(() => {
            if (operation === "cancel") operation = "idle";
          }),
        );
      }),
    );

  const requireFlow = (ownerSessionId: string, flowId: string, name: string) =>
    Effect.gen(function* () {
      const flow = activeFlow;
      if (!flow || flow.id !== flowId || flow.ownerSessionId !== ownerSessionId) {
        return yield* setupError(name, "This sign-in is no longer active in this client.");
      }
      const now = yield* Clock.currentTimeMillis;
      if (now >= flow.expiresAtMillis) {
        return yield* setupError(name, EXPIRED_MESSAGE);
      }
      return flow;
    });

  const controller: ProviderAuthController = {
    start: (ownerSessionId, stopSessions = Effect.void, startOptions) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (activeFlow?.ownerSessionId === ownerSessionId && operation === "auth") {
              return activeFlow.state;
            }
            if (operation !== "idle") {
              return yield* setupError(
                "start",
                "Codex sign-in or sign-out is already in progress.",
              );
            }
            const flowId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() =>
                setupError("start", "Could not start Codex sign-in. Try again."),
              ),
            );
            const expiresAtMillis = (yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS;
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
              message: "Starting Codex sign-in.",
            };
            const flow: AuthFlow = {
              id: flowId,
              ownerSessionId,
              expiresAtMillis,
              state,
              fiber: undefined,
            };
            activeFlow = flow;
            operation = "auth";
            yield* publishFlow(flow, state);
            flow.fiber = yield* runSignIn(
              flow,
              stopSessions,
              startOptions?.method ?? "browser",
            ).pipe(Effect.interruptible, Effect.forkIn(instanceScope));
            return state;
          }),
        ),
      ),
    complete: (_ownerSessionId, _input) =>
      Effect.fail(
        setupError(
          "complete",
          "Codex sign-in finishes in the browser or with the code. There is no redirect URL to paste.",
        ),
      ),
    cancel: Effect.fn("CodexAuth.cancel")(function* (ownerSessionId, flowId) {
      const flow = yield* lock.withPermits(1)(requireFlow(ownerSessionId, flowId, "cancel"));
      yield* stopFlow(flow, "cancelled", "Codex sign-in was cancelled.");
      return flow.state;
    }),
    logout: Effect.fn("CodexAuth.logout")(function* (stopSessions) {
      const task = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (operation !== "idle" && operation !== "auth") {
                return yield* setupError("logout", "Codex sign-out is already in progress.");
              }
              operation = "logout";
              const currentFlow = activeFlow;
              activeFlow = undefined;
              if (currentFlow) {
                yield* publishFlow(currentFlow, {
                  ...currentFlow.state,
                  phase: "cancelled",
                  authorizationUrl: null,
                  userCode: null,
                  expiresAt: null,
                  message: "Codex sign-in was cancelled by sign-out.",
                });
              }
              return currentFlow;
            }),
          );
          const result = yield* restore(
            Effect.gen(function* () {
              if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
              yield* stopSessions;
              const client = yield* options.openClient;
              yield* client
                .request("account/logout", undefined)
                .pipe(
                  Effect.mapError(() => setupError("logout", "Codex sign-out failed. Try again.")),
                );
              yield* options.onSignedOut;
            }).pipe(
              Effect.scoped,
              Effect.timeoutOrElse({
                duration: LOGOUT_TIMEOUT,
                orElse: () => Effect.fail(setupError("logout", "Codex sign-out timed out.")),
              }),
            ),
          ).pipe(Effect.exit);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              operation = "idle";
              yield* SubscriptionRef.set(snapshot, {
                ownerSessionId: null,
                state: {
                  ...emptyState,
                  phase: Exit.isSuccess(result) ? "idle" : "failed",
                  message: Exit.isSuccess(result)
                    ? "Signed out of Codex."
                    : "Codex sign-out failed. Try again.",
                },
              });
            }),
          );
          if (Exit.isFailure(result)) {
            const failure = Cause.findErrorOption(result.cause);
            return yield* Option.isSome(failure) && isSetupError(failure.value)
              ? failure.value
              : setupError("logout", "Codex sign-out failed. Try again.");
          }
          return (yield* SubscriptionRef.get(snapshot)).state;
        }),
      );
      const worker = yield* task.pipe(Effect.forkIn(instanceScope));
      return yield* Fiber.await(worker).pipe(Effect.flatMap((result) => result));
    }),
    subscribe: (ownerSessionId) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((value) => visibleSnapshot(value, ownerSessionId)),
        Stream.interruptWhen(Deferred.await(closed)),
      ),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = activeFlow;
      activeFlow = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* Deferred.succeed(closed, undefined);
    }),
  );

  return { controller };
});
