/**
 * Access tokens configured for Forgejo and Gitea servers, from Settings or the
 * `T3CODE_FORGEJO_URL` / `T3CODE_FORGEJO_ACCESS_TOKEN` environment pair. The
 * Forgejo client consults this ahead of `fj` and `tea` logins, so a server can
 * be used without either CLI installed. Optional for the client: without this
 * service in scope it behaves as if nothing were configured.
 *
 * @module sourceControl/ForgejoServerTokens
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";

export interface ConfiguredForgejoServer {
  /** Normalized server URL: scheme, host with port, optional mount path, no trailing slash. */
  readonly url: string;
  readonly accessToken: string;
  readonly fromEnvironment: boolean;
}

export class ForgejoServerTokens extends Context.Service<
  ForgejoServerTokens,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConfiguredForgejoServer>>;
  }
>()("t3/sourceControl/ForgejoServerTokens") {}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const list = settings.getSettings.pipe(
    Effect.map((current) =>
      Object.entries(current.forgejoServers)
        .filter(([, server]) => server.accessToken.length > 0)
        .map(([url, server]) => ({
          url,
          accessToken: server.accessToken,
          fromEnvironment: server.fromEnvironment === true,
        })),
    ),
    // Settings that fail to load must not turn into a Forgejo auth failure;
    // the CLI paths remain available.
    Effect.orElseSucceed((): ReadonlyArray<ConfiguredForgejoServer> => []),
  );
  return ForgejoServerTokens.of({ list });
});

export const layer = Layer.effect(ForgejoServerTokens, make);
