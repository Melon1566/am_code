import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  proxyUrl?: string,
) {
  if ((!environment || environment.length === 0) && !proxyUrl) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  if (proxyUrl) {
    // Set both cases: CLI HTTP clients disagree on which takes precedence.
    // Keep local callbacks and local tool servers out of the remote proxy.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY"]) {
      next[name] = proxyUrl;
      next[name.toLowerCase()] = proxyUrl;
    }
    next.NO_PROXY = "localhost,127.0.0.1,::1";
    next.no_proxy = next.NO_PROXY;
  }
  return next;
});
