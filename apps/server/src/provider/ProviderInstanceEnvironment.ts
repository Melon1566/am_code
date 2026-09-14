import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  proxyUrl?: string,
): NodeJS.ProcessEnv {
  if ((!environment || environment.length === 0) && !proxyUrl) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
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
}
