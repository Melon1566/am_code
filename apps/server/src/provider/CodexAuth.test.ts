import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCodexAuth, type CodexAuth, type CodexLoginClient } from "./CodexAuth.ts";

const instanceId = ProviderInstanceId.make("codex_personal");
const owner = "t3-session-owner";
const otherOwner = "t3-session-other";
const authUrl = "https://auth.openai.com/oauth/authorize?state=test";
const verificationUrl = "https://auth.openai.com/codex/device";

class TransportClosed extends Data.TaggedError("TransportClosed") {}

type LoginCompleted = CodexSchema.V2AccountLoginCompletedNotification;
type CompletionHandler = (
  payload: LoginCompleted,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;

const phase = (auth: CodexAuth, value: ProviderAuthState["phase"], sessionId = owner) =>
  auth.controller.subscribe(sessionId).pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fn("makeCodexAuthHarness")(function* (
  options: { readonly failStart?: boolean } = {},
) {
  const events: string[] = [];
  const clientClosed = yield* Deferred.make<void>();
  let completion: CompletionHandler | undefined;
  let authenticated = 0;
  let signedOut = 0;

  // The fake answers the two login requests the controller makes; everything
  // else is out of scope, so the cast is confined to the harness.
  const request = (method: string, payload: unknown): Effect.Effect<unknown, TransportClosed> =>
    Effect.gen(function* () {
      events.push(method);
      if (method === "account/login/start") {
        if (options.failStart) {
          return yield* new TransportClosed();
        }
        const type = (payload as { type: string }).type;
        return type === "chatgptDeviceCode"
          ? { type, loginId: "login-1", userCode: "ABCD-1234", verificationUrl }
          : { type, loginId: "login-1", authUrl };
      }
      return {};
    });
  const handleServerNotification = (method: string, handler: CompletionHandler) =>
    Effect.sync(() => {
      if (method === "account/login/completed") completion = handler;
    });
  const client = {
    request,
    handleServerNotification,
  } as unknown as CodexLoginClient;

  const auth = yield* makeCodexAuth({
    instanceId,
    openClient: Effect.gen(function* () {
      events.push("process-open");
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          events.push("process-close");
          yield* Deferred.succeed(clientClosed, undefined);
        }),
      );
      return client;
    }),
    onAuthenticated: Effect.sync(() => {
      authenticated += 1;
    }),
    onSignedOut: Effect.sync(() => {
      signedOut += 1;
    }),
  });

  return {
    auth,
    events,
    clientClosed,
    authenticated: () => authenticated,
    signedOut: () => signedOut,
    complete: (payload: LoginCompleted) =>
      Effect.suspend(() =>
        completion ? completion(payload) : Effect.die("completion handler not registered"),
      ),
  };
});

it.layer(NodeServices.layer)("CodexAuth", (it) => {
  it.effect("browser sign-in publishes the URL and succeeds on the completion notice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.auth.controller.start(owner);
      assert.equal(started.phase, "starting");

      const waiting = yield* phase(harness.auth, "waiting");
      assert.equal(waiting.authorizationUrl, authUrl);
      assert.equal(waiting.userCode, null);
      assert.deepEqual(harness.events, ["process-open", "account/login/start"]);

      yield* harness.complete({ success: true, loginId: "login-1" });
      const done = yield* phase(harness.auth, "succeeded");
      assert.equal(done.authorizationUrl, null);
      assert.equal(harness.authenticated(), 1);
      yield* Deferred.await(harness.clientClosed);
    }),
  );

  it.effect("device-code sign-in publishes the code and verification page", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner, undefined, { method: "deviceCode" });
      const waiting = yield* phase(harness.auth, "waiting");
      assert.equal(waiting.authorizationUrl, verificationUrl);
      assert.equal(waiting.userCode, "ABCD-1234");
    }),
  );

  it.effect("a failed completion notice ends in failed with a generic message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* harness.complete({ success: false, error: "token leak http://secret" });
      const failed = yield* phase(harness.auth, "failed");
      assert.equal(failed.message, "Codex sign-in failed. Start sign-in again.");
      assert.equal(harness.authenticated(), 0);
    }),
  );

  it.effect("a start failure ends in failed without leaking detail", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failStart: true });
      yield* harness.auth.controller.start(owner);
      const failed = yield* phase(harness.auth, "failed");
      assert.equal(failed.message, "Codex could not start sign-in. Try again.");
    }),
  );

  it.effect("cancel closes the app-server and reports cancelled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      const cancelled = yield* harness.auth.controller.cancel(owner, started.flowId!);
      assert.equal(cancelled.phase, "cancelled");
      yield* Deferred.await(harness.clientClosed);
    }),
  );

  it.effect("another client sees neither the URL nor the code", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner, undefined, { method: "deviceCode" });
      const waiting = yield* phase(harness.auth, "waiting", otherOwner);
      assert.equal(waiting.authorizationUrl, null);
      assert.equal(waiting.userCode, null);
      assert.equal(waiting.message, "Sign-in is in progress in another client.");
    }),
  );

  it.effect("logout sends account/logout and returns to idle", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.logout(Effect.void);
      assert.equal(state.phase, "idle");
      assert.equal(state.message, "Signed out of Codex.");
      assert.equal(harness.signedOut(), 1);
      assert.deepEqual(harness.events, ["process-open", "account/logout", "process-close"]);
    }),
  );

  it.effect("complete is not supported", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.auth.controller
        .complete(owner, { flowId: "x", callbackUrl: "http://127.0.0.1/" })
        .pipe(Effect.flip);
      assert.equal(result.operation, "complete");
    }),
  );
});
