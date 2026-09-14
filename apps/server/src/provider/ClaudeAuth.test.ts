import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { PtyExitEvent, PtyProcess } from "../terminal/PtyAdapter.ts";
import { makeClaudeAuth, type ClaudeAuth } from "./ClaudeAuth.ts";
import {
  findClaudeAuthorizationUrl,
  findClaudeSetupToken,
  stripAnsi,
} from "./claudeSetupTokenOutput.ts";

const instanceId = ProviderInstanceId.make("claude_personal");
const owner = "t3-session-owner";
const otherOwner = "t3-session-other";
const authUrl =
  "https://platform.claude.com/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference";
const token = `sk-ant-oat01-${"x".repeat(40)}`;

describe("claudeSetupTokenOutput", () => {
  it("strips terminal escapes and finds the sign-in URL across chunks", () => {
    const first = stripAnsi(
      "\x1b[1mBrowser didn't open? Use the url below\x1b[0m\r\n\x1b[36mhttps://platform.claude.com/oauth/auth",
    );
    const second = stripAnsi("orize?code=true&client_id=abc\x1b[0m\r\n");
    assert.strictEqual(findClaudeAuthorizationUrl(first), undefined);
    assert.strictEqual(
      findClaudeAuthorizationUrl(first + second),
      "https://platform.claude.com/oauth/authorize?code=true&client_id=abc",
    );
  });

  it("waits for a delimiter before trusting a token, unless the process is done", () => {
    const partial = `Your OAuth token: ${token.slice(0, 30)}`;
    assert.strictEqual(findClaudeSetupToken(partial), undefined);
    assert.strictEqual(findClaudeSetupToken(`${partial}${token.slice(30)}\n`), token);
    assert.strictEqual(
      findClaudeSetupToken(`${partial}${token.slice(30)}`, { final: true }),
      token,
    );
    assert.strictEqual(findClaudeSetupToken("sk-ant-oat01-short \n"), undefined);
  });
});

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  killed = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}
  kill(): void {
    this.killed += 1;
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

const phase = (auth: ClaudeAuth, value: ProviderAuthState["phase"], sessionId = owner) =>
  auth.controller.subscribe(sessionId).pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fn("makeClaudeAuthHarness")(function* (
  options: { readonly hasStoredToken?: boolean } = {},
) {
  const pty = new FakePty();
  const stored: string[] = [];
  const spawns: Array<{ shell: string; args: string[] | undefined; env: NodeJS.ProcessEnv }> = [];
  let removed = 0;
  const auth = yield* makeClaudeAuth({
    instanceId,
    binaryPath: "/usr/local/bin/claude",
    cwd: "/repo",
    environment: { CLAUDE_CONFIG_DIR: "/home/alex/.claude", CLAUDE_CODE_OAUTH_TOKEN: "old" },
    spawn: (input) =>
      Effect.sync(() => {
        spawns.push({ shell: input.shell, args: input.args, env: input.env });
        return pty;
      }),
    storeToken: (value) =>
      Effect.sync(() => {
        stored.push(value);
      }),
    removeToken: Effect.sync(() => {
      removed += 1;
      return options.hasStoredToken === true;
    }),
  });
  return { auth, pty, stored, spawns, removed: () => removed };
});

it.layer(NodeServices.layer)("ClaudeAuth", (it) => {
  it.effect("surfaces the sign-in link, forwards the pasted code, and stores the token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.auth.controller.start(owner);
      assert.strictEqual(started.phase, "starting");
      yield* Effect.yieldNow;
      assert.strictEqual(harness.spawns.length, 1);
      assert.deepStrictEqual(harness.spawns[0]?.args, ["setup-token"]);
      assert.strictEqual(harness.spawns[0]?.env.CLAUDE_CONFIG_DIR, "/home/alex/.claude");
      assert.strictEqual(harness.spawns[0]?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

      harness.pty.emit(
        `Use the url below to sign in:\r\n${authUrl}\r\nPaste code here if prompted > `,
      );
      const waiting = yield* phase(harness.auth, "waiting");
      assert.strictEqual(waiting.authorizationUrl, authUrl);

      const verifying = yield* harness.auth.controller.complete(owner, {
        flowId: started.flowId!,
        callbackUrl: "  abc123#state  ",
      });
      assert.strictEqual(verifying.phase, "verifying");
      assert.deepStrictEqual(harness.pty.writes, ["abc123#state\r"]);

      harness.pty.emit(`\r\nYour OAuth token is:\r\n${token}\r\n`);
      const done = yield* phase(harness.auth, "succeeded");
      assert.strictEqual(done.authorizationUrl, null);
      assert.deepStrictEqual(harness.stored, [token]);
      assert.ok(harness.pty.killed >= 1);
    }),
  );

  it.effect("fails safely when Claude exits before printing a token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner);
      yield* Effect.yieldNow;
      harness.pty.emit(`${authUrl}\r\n`);
      yield* phase(harness.auth, "waiting");
      harness.pty.emit("Error: invalid code sk-ant-oat01-notreallyatoken\r\n");
      harness.pty.exit(1);
      const failed = yield* phase(harness.auth, "failed");
      assert.strictEqual(failed.message, "Claude exited without issuing a token.");
      assert.deepStrictEqual(harness.stored, []);
    }),
  );

  it.effect("rejects a code before the link is shown and a blank code afterwards", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.auth.controller.start(owner);
      yield* Effect.yieldNow;
      const early = yield* harness.auth.controller
        .complete(owner, { flowId: started.flowId!, callbackUrl: "abc" })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(early));
      harness.pty.emit(`${authUrl}\r\n`);
      yield* phase(harness.auth, "waiting");
      const blank = yield* harness.auth.controller
        .complete(owner, { flowId: started.flowId!, callbackUrl: "   " })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(blank));
      assert.deepStrictEqual(harness.pty.writes, []);
    }),
  );

  it.effect("cancel kills the process and another client sees no link", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* harness.auth.controller.start(owner);
      yield* Effect.yieldNow;
      harness.pty.emit(`${authUrl}\r\n`);
      const other = yield* phase(harness.auth, "waiting", otherOwner);
      assert.strictEqual(other.authorizationUrl, null);
      const cancelled = yield* harness.auth.controller.cancel(owner, started.flowId!);
      assert.strictEqual(cancelled.phase, "cancelled");
      assert.ok(harness.pty.killed >= 1);
    }),
  );

  it.effect("logout removes a stored token, and explains when there is none", () =>
    Effect.gen(function* () {
      const withToken = yield* makeHarness({ hasStoredToken: true });
      const state = yield* withToken.auth.controller.logout(Effect.void);
      assert.strictEqual(state.phase, "idle");
      assert.strictEqual(withToken.removed(), 1);

      const withoutToken = yield* makeHarness();
      const result = yield* withoutToken.auth.controller.logout(Effect.void).pipe(Effect.result);
      assert.ok(Result.isFailure(result));
      assert.ok(Schema.is(ProviderSetupError)(result.failure));
      assert.ok(result.failure.detail.includes("claude auth logout"));
    }),
  );
});
