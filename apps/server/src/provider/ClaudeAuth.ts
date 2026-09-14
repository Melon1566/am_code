/**
 * In-app sign-in for one Claude instance. Neither the Claude Agent SDK nor
 * the CLI has a programmatic login, so this drives `claude setup-token` in a
 * pseudo-terminal: it surfaces the OAuth URL the CLI prints, forwards the
 * code the user pastes, and stores the long-lived token the CLI prints as the
 * instance's `CLAUDE_CODE_OAUTH_TOKEN`. An environment token outranks the
 * machine's Keychain login, so each instance keeps its own account while
 * sharing one config directory.
 *
 * @module provider/ClaudeAuth
 */
import {
  ProviderSetupError,
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

import type { PtyAdapter, PtyProcess } from "../terminal/PtyAdapter.ts";
import {
  findClaudeAuthorizationUrl,
  findClaudeSetupToken,
  stripAnsi,
} from "./claudeSetupTokenOutput.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

export const CLAUDE_OAUTH_TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";
const AUTH_TIMEOUT_MS = 10 * 60_000;
const URL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_CODE_LENGTH = 512;
const FAILED_MESSAGE = "Claude sign-in failed. Start sign-in again.";
const EXPIRED_MESSAGE = "Claude sign-in expired. Start sign-in again.";
const isSetupError = Schema.is(ProviderSetupError);

export interface ClaudeAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  /** Instance environment including its config directory; any stored token is dropped. */
  readonly environment: NodeJS.ProcessEnv;
  readonly spawn: PtyAdapter["Service"]["spawn"];
  /** Persist the token on the instance; the registry rebuilds it afterwards. */
  readonly storeToken: (token: string) => Effect.Effect<void, ProviderSetupError>;
  /** Remove a stored token; resolves false when there was none. */
  readonly removeToken: Effect.Effect<boolean, ProviderSetupError>;
}

export interface ClaudeAuth {
  readonly controller: ProviderAuthController;
}

interface AuthFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly expiresAtMillis: number;
  state: ProviderAuthState;
  fiber: Fiber.Fiber<void, never> | undefined;
  pty: PtyProcess | undefined;
  codeSent: boolean;
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

function safeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && isSetupError(error.value)) return error.value.detail;
  return FAILED_MESSAGE;
}

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (
  options: ClaudeAuthOptions,
): Effect.fn.Return<ClaudeAuth, never, Crypto.Crypto | Scope.Scope> {
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
          message: Exit.isSuccess(result)
            ? "Signed in to Claude. The instance is restarting with the new account."
            : safeFailure(result.cause),
        });
      }),
    );

  const runSignIn = (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) =>
    Effect.gen(function* () {
      yield* stopSessions;
      const { [CLAUDE_OAUTH_TOKEN_VARIABLE]: _stored, ...environment } = options.environment;
      const pty = yield* options
        .spawn({
          shell: options.binaryPath,
          args: ["setup-token"],
          cwd: options.cwd,
          cols: 120,
          rows: 40,
          env: { ...environment, TERM: environment.TERM ?? "xterm-256color" },
        })
        .pipe(
          Effect.mapError(() =>
            setupError("start", "Could not start Claude for sign-in. Check the binary path."),
          ),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => pty.kill()));
      const token = yield* Deferred.make<string>();
      const exited = yield* Deferred.make<void>();
      const urlSeen = yield* Deferred.make<string>();
      let output = "";
      pty.onData((chunk) => {
        output = (output + stripAnsi(chunk)).slice(-MAX_OUTPUT_CHARS);
        const url = findClaudeAuthorizationUrl(output);
        if (url) Deferred.doneUnsafe(urlSeen, Effect.succeed(url));
        const found = findClaudeSetupToken(output);
        if (found) Deferred.doneUnsafe(token, Effect.succeed(found));
      });
      pty.onExit(() => {
        const found = findClaudeSetupToken(output, { final: true });
        if (found) Deferred.doneUnsafe(token, Effect.succeed(found));
        Deferred.doneUnsafe(exited, Effect.void);
      });
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (activeFlow === flow) flow.pty = pty;
        }),
      );

      const url = yield* Deferred.await(urlSeen).pipe(
        Effect.raceFirst(
          Deferred.await(exited).pipe(
            Effect.flatMap(() =>
              Effect.fail(setupError("start", "Claude exited before showing a sign-in link.")),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: URL_TIMEOUT_MS,
          orElse: () => Effect.fail(setupError("start", "Claude did not show a sign-in link.")),
        }),
      );
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow) return;
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "waiting",
            authorizationUrl: url,
            userCode: null,
            message: "Open the sign-in page, then paste the code Anthropic shows you here.",
          });
        }),
      );

      const value = yield* Deferred.await(token).pipe(
        Effect.raceFirst(
          Deferred.await(exited).pipe(
            Effect.flatMap(() =>
              Effect.fail(setupError("start", "Claude exited without issuing a token.")),
            ),
          ),
        ),
      );
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow) return;
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            message: "Saving the account to this instance.",
          });
        }),
      );
      yield* options.storeToken(value);
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
        // Interrupting the flow closes its scope, which kills the pty.
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
    start: (ownerSessionId, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (activeFlow?.ownerSessionId === ownerSessionId && operation === "auth") {
              return activeFlow.state;
            }
            if (operation !== "idle") {
              return yield* setupError(
                "start",
                "Claude sign-in or sign-out is already in progress.",
              );
            }
            const flowId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() =>
                setupError("start", "Could not start Claude sign-in. Try again."),
              ),
            );
            const expiresAtMillis = (yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS;
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
              message: "Starting Claude sign-in.",
            };
            const flow: AuthFlow = {
              id: flowId,
              ownerSessionId,
              expiresAtMillis,
              state,
              fiber: undefined,
              pty: undefined,
              codeSent: false,
            };
            activeFlow = flow;
            operation = "auth";
            yield* publishFlow(flow, state);
            flow.fiber = yield* runSignIn(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(instanceScope),
            );
            return state;
          }),
        ),
      ),
    // `callbackUrl` carries the code Anthropic shows after the browser sign-in.
    complete: Effect.fn("ClaudeAuth.complete")(function* (ownerSessionId, input) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const flow = yield* requireFlow(ownerSessionId, input.flowId, "complete");
          const code = input.callbackUrl.trim();
          if (flow.state.phase !== "waiting" || flow.pty === undefined) {
            return yield* setupError(
              "complete",
              "Wait for the sign-in link before pasting a code.",
            );
          }
          if (flow.codeSent) {
            return yield* setupError(
              "complete",
              "The code was already sent. Wait for Claude to finish.",
            );
          }
          if (code.length === 0 || code.length > MAX_CODE_LENGTH || /\s/.test(code)) {
            return yield* setupError("complete", "Paste the code exactly as Anthropic shows it.");
          }
          flow.codeSent = true;
          flow.pty.write(`${code}\r`);
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            message: "Waiting for Claude to confirm the code.",
          });
          return flow.state;
        }),
      );
    }),
    cancel: Effect.fn("ClaudeAuth.cancel")(function* (ownerSessionId, flowId) {
      const flow = yield* lock.withPermits(1)(requireFlow(ownerSessionId, flowId, "cancel"));
      yield* stopFlow(flow, "cancelled", "Claude sign-in was cancelled.");
      return flow.state;
    }),
    logout: Effect.fn("ClaudeAuth.logout")(function* (stopSessions) {
      const task = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (operation !== "idle" && operation !== "auth") {
                return yield* setupError("logout", "Claude sign-out is already in progress.");
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
                  message: "Claude sign-in was cancelled by sign-out.",
                });
              }
              return currentFlow;
            }),
          );
          const result = yield* restore(
            Effect.gen(function* () {
              if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
              yield* stopSessions;
              const removed = yield* options.removeToken;
              if (!removed) {
                return yield* setupError(
                  "logout",
                  "This instance uses the machine's Claude login. Sign out with `claude auth logout` on the environment's machine.",
                );
              }
            }),
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
                    ? "Removed this instance's Claude token."
                    : safeFailure(result.cause),
                },
              });
            }),
          );
          if (Exit.isFailure(result)) {
            const failure = Cause.findErrorOption(result.cause);
            return yield* Option.isSome(failure) && isSetupError(failure.value)
              ? failure.value
              : setupError("logout", "Claude sign-out failed. Try again.");
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
