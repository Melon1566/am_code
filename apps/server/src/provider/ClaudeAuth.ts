import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import type { PtyAdapter } from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import {
  findClaudeAuthorizationUrl,
  findClaudeSetupToken,
  stripAnsi,
} from "./claudeSetupTokenOutput.ts";

export const CLAUDE_OAUTH_TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";
const MAX_OUTPUT_CHARS = 64_000;
const MAX_CODE_LENGTH = 512;

export interface ClaudeAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawn: PtyAdapter["Service"]["spawn"];
  readonly storeToken: (token: string) => Effect.Effect<void, ProviderSetupError>;
  readonly removeToken: Effect.Effect<boolean, ProviderSetupError>;
}

export interface ClaudeAuth {
  readonly controller: ProviderAuthController;
}

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: ClaudeAuthOptions) {
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "t3", key: `claude:instance:${options.instanceId}` },
    defaultMethodId: "browser",
    timeoutMs: 10 * 60_000,
    methods: Effect.succeed([
      {
        id: "browser",
        name: "Claude subscription",
        description: "Open the sign-in page and paste the code Anthropic shows.",
        type: "agent" as const,
      },
    ]),
    authenticate: Effect.fn("ClaudeAuth.authenticate")(function* (_methodId, context) {
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
      const removeDataListener = pty.onData((chunk) => {
        output = (output + stripAnsi(chunk)).slice(-MAX_OUTPUT_CHARS);
        const url = findClaudeAuthorizationUrl(output);
        if (url) Deferred.doneUnsafe(urlSeen, Effect.succeed(url));
        const found = findClaudeSetupToken(output);
        if (found) Deferred.doneUnsafe(token, Effect.succeed(found));
      });
      const removeExitListener = pty.onExit(() => {
        const found = findClaudeSetupToken(output, { final: true });
        if (found) Deferred.doneUnsafe(token, Effect.succeed(found));
        Deferred.doneUnsafe(exited, Effect.void);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removeDataListener();
          removeExitListener();
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
          duration: 60_000,
          orElse: () => Effect.fail(setupError("start", "Claude did not show a sign-in link.")),
        }),
      );
      let codeSent = false;
      const sendCode = Effect.fn("ClaudeAuth.sendCode")(function* (value: string) {
        if (codeSent)
          return yield* setupError(
            "complete",
            "The code was already sent. Wait for Claude to finish.",
          );
        const code = value.trim();
        if (code.length === 0 || code.length > MAX_CODE_LENGTH || /\s/.test(code))
          return yield* setupError("complete", "Paste the code exactly as Anthropic shows it.");
        codeSent = true;
        yield* Effect.sync(() => pty.write(`${code}\r`));
        yield* context.verifying;
      });
      yield* context.setInteraction(
        { id: context.flowId, type: "browser", url, requiresConsent: false, acceptsCallback: true },
        undefined,
        sendCode,
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
      yield* context.verifying;
      yield* options.storeToken(value);
    }),
    logout: Effect.gen(function* () {
      if (!(yield* options.removeToken))
        return yield* setupError(
          "logout",
          "This instance uses the machine's Claude login. Sign out with `claude auth logout` on the environment's machine.",
        );
      return "Removed this instance's Claude token.";
    }),
  });
  return {
    controller: {
      ...controller,
      isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
    },
  } satisfies ClaudeAuth;
});
