import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { CodexAppServerClient } from "effect-codex-app-server/client";

import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";

const FAILED_MESSAGE = "Codex sign-in failed. Start sign-in again.";

export type CodexLoginClient = Pick<
  CodexAppServerClient["Service"],
  "request" | "handleServerNotification"
>;

export interface CodexAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly credentialBinding?: NonNullable<ProviderAuthController["credentialBinding"]>;
  readonly openClient: Effect.Effect<CodexLoginClient, ProviderSetupError, Scope.Scope>;
  readonly onAuthenticated: Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
}

export interface CodexAuth {
  readonly controller: ProviderAuthController;
}

export const makeCodexAuth = Effect.fn("makeCodexAuth")(function* (options: CodexAuthOptions) {
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: options.credentialBinding ?? {
      owner: "provider",
      key: `codex:instance:${options.instanceId}`,
    },
    defaultMethodId: "browser",
    timeoutMs: 10 * 60_000,
    methods: Effect.succeed([
      {
        id: "browser",
        name: "ChatGPT in browser",
        description: "Finish sign-in on the environment's machine.",
        type: "agent" as const,
      },
      {
        id: "deviceCode",
        name: "ChatGPT with device code",
        description: "Sign in from any device, including remote clients.",
        type: "agent" as const,
      },
    ]),
    authenticate: Effect.fn("CodexAuth.authenticate")(function* (methodId, context) {
      const client = yield* options.openClient;
      const completed = yield* Deferred.make<void, ProviderSetupError>();
      let loginId: string | undefined;
      yield* client.handleServerNotification("account/login/completed", (payload) =>
        Effect.gen(function* () {
          if (loginId !== undefined && payload.loginId && payload.loginId !== loginId) return;
          if (payload.success) {
            yield* Deferred.succeed(completed, undefined);
          } else {
            yield* Deferred.fail(completed, setupError("start", FAILED_MESSAGE));
          }
        }),
      );
      const started = yield* client
        .request(
          "account/login/start",
          methodId === "deviceCode" ? { type: "chatgptDeviceCode" } : { type: "chatgpt" },
        )
        .pipe(
          Effect.mapError(() => setupError("start", "Codex could not start sign-in. Try again.")),
        );
      switch (started.type) {
        case "chatgpt":
          loginId = started.loginId;
          yield* context.setInteraction({
            id: context.flowId,
            type: "browser",
            url: started.authUrl,
            requiresConsent: false,
          });
          break;
        case "chatgptDeviceCode":
          loginId = started.loginId;
          yield* context.setInteraction({
            id: context.flowId,
            type: "deviceCode",
            url: started.verificationUrl,
            userCode: started.userCode,
          });
          break;
        default:
          return yield* setupError("start", "Codex did not start a ChatGPT sign-in.");
      }
      yield* Deferred.await(completed);
      yield* context.verifying;
      yield* options.onAuthenticated;
    }),
    logout: Effect.scoped(
      Effect.gen(function* () {
        const client = yield* options.openClient;
        yield* client
          .request("account/logout", undefined)
          .pipe(Effect.mapError(() => setupError("logout", "Codex sign-out failed. Try again.")));
        yield* options.onSignedOut;
        return "Signed out of Codex.";
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () => Effect.fail(setupError("logout", "Codex sign-out timed out. Try again.")),
      }),
    ),
  });
  return {
    controller: {
      ...controller,
      isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
    },
  } satisfies CodexAuth;
});
