import { assert, it } from "@effect/vitest";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import { ForgejoServerTokens, type ConfiguredForgejoServer } from "./ForgejoServerTokens.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** Git answers with the origin remote; every forge CLI is absent. */
const noCliProcess = Layer.mock(VcsProcess.VcsProcess)({
  run: (input) =>
    input.command === "git"
      ? Effect.succeed(processOutput("https://forgejo.test/maria/project.git"))
      : Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        ),
});

const noKeysFile = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
);

const tokensFor = (servers: ReadonlyArray<ConfiguredForgejoServer>) =>
  Layer.succeed(ForgejoServerTokens, ForgejoServerTokens.of({ list: Effect.succeed(servers) }));

const makeFetch = (requests: Array<{ url: string; authorization: string | null }>) =>
  Object.assign(
    async (...[input, init]: Parameters<Context.Service.Shape<typeof FetchHttpClient.Fetch>>) => {
      const request = new Request(input instanceof Request ? input.url : String(input), init);
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });
      return new Response('{"login":"maria"}', { status: 200 });
    },
    { preconnect: () => undefined },
  );

it.effect("uses a configured access token ahead of fj and tea", () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const repository = yield* cli.resolveRepository({ cwd: "/repo" });
    assert.deepStrictEqual(repository, {
      command: "token",
      login: "https://forgejo.test",
      repository: "maria/project",
      baseUrl: "https://forgejo.test",
    });

    const user = yield* cli.api({ cwd: "/repo", path: "user" });
    assert.strictEqual(user.stdout, '{"login":"maria"}');
    assert.deepStrictEqual(requests, [
      { url: "https://forgejo.test/api/v1/user", authorization: "token secret-token" },
    ]);

    const account = yield* cli.getAccount!({ cwd: "/repo", baseUrl: "https://forgejo.test/" });
    assert.strictEqual(account, "maria");
  }).pipe(
    Effect.provideService(FetchHttpClient.Fetch, makeFetch(requests)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(
      Layer.mergeAll(
        noKeysFile,
        noCliProcess,
        tokensFor([
          { url: "https://forgejo.test", accessToken: "secret-token", fromEnvironment: false },
        ]),
      ),
    ),
  );
});

it.effect("falls through to the CLI path when no configured server matches the remote", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli.resolveRepository({ cwd: "/repo" }).pipe(Effect.result);
    assert.ok(Result.isFailure(result));
    assert.strictEqual(result.failure.reason, "missing-cli");
  }).pipe(
    Effect.provideService(FetchHttpClient.Fetch, makeFetch([])),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(
      Layer.mergeAll(
        noKeysFile,
        noCliProcess,
        tokensFor([
          { url: "https://other.test", accessToken: "other-token", fromEnvironment: false },
        ]),
      ),
    ),
  ),
);

it.effect("behaves as before when the tokens service is absent", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli.resolveRepository({ cwd: "/repo" }).pipe(Effect.result);
    assert.ok(Result.isFailure(result));
    assert.strictEqual(result.failure.reason, "missing-cli");
  }).pipe(
    Effect.provideService(FetchHttpClient.Fetch, makeFetch([])),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(Layer.mergeAll(noKeysFile, noCliProcess)),
  ),
);
