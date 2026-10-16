import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );
});

describe("provider proxy environment", () => {
  it.effect(
    "routes HTTP and streaming traffic through the configured proxy without mutating the host",
    () =>
      Effect.gen(function* () {
        const base = { PATH: "/bin", https_proxy: "http://old:80", NO_PROXY: "*" };
        const env = yield* mergeProviderInstanceEnvironment(
          [{ name: "HTTPS_PROXY", value: "http://other:80", sensitive: false }],
          base,
          "https://proxy.example.com:8443",
        );
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY"]) {
          expect(env[key]).toBe("https://proxy.example.com:8443");
          expect(env[key.toLowerCase()]).toBe("https://proxy.example.com:8443");
        }
        expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
        expect(env.no_proxy).toBe(env.NO_PROXY);
        expect(env.PATH).toBe("/bin");
        expect(base).toEqual({ PATH: "/bin", https_proxy: "http://old:80", NO_PROXY: "*" });
      }),
  );

  it.effect("restores inherited routing when the proxy setting is cleared", () =>
    Effect.gen(function* () {
      const base = { HTTPS_PROXY: "http://inherited:80", NO_PROXY: "internal.example.com" };
      expect(yield* mergeProviderInstanceEnvironment([], base, "")).toEqual(base);
      expect(yield* mergeProviderInstanceEnvironment([], base)).toEqual(base);
    }),
  );
});
