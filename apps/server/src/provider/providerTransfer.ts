import * as NodeOS from "node:os";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTransferBundle,
  ProviderTransferError,
  PROVIDER_TRANSFER_MAX_BYTES,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderTransferEntry,
  type ProviderTransferImportInput,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerSettingsService } from "../serverSettings.ts";

function allInstances(settings: ServerSettings): Record<string, ProviderInstanceConfig> {
  const instances: Record<string, ProviderInstanceConfig> = {};
  for (const [driver, config] of Object.entries(settings.providers)) {
    instances[driver] = { driver: ProviderDriverKind.make(driver), config };
  }
  return { ...instances, ...settings.providerInstances };
}

const transferError = (detail: string) => new ProviderTransferError({ detail });
const decodeCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeBundle = Schema.decodeUnknownEffect(ProviderTransferBundle);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(ProviderTransferBundle));
const importLock = Semaphore.makeUnsafe(1);

/** Transfer provider settings and portable login files without reading histories or writing to existing CLI homes. */
export const makeProviderTransfer = Effect.fn("makeProviderTransfer")(function* (options: {
  readonly stateDir: string;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const home = options.homeDirectory ?? NodeOS.homedir();
  const baseEnv = options.environment ?? process.env;
  const resolveHome = (value: string | undefined, fallback: string) => {
    const input = value?.trim() || fallback;
    return path.resolve(
      input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input,
    );
  };
  const readCredentials = Effect.fn("ProviderTransfer.readCredentials")(function* (
    filename: string,
  ) {
    const stat = yield* fs
      .stat(filename)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(transferError("Could not read a provider credential file.")),
        ),
      );
    if (!stat) return undefined;
    if (Number(stat.size) > 256 * 1024)
      return yield* transferError("A provider credential file is too large to export.");
    const content = yield* fs
      .readFileString(filename)
      .pipe(Effect.mapError(() => transferError("Could not read a provider credential file.")));
    yield* decodeCredentials(content).pipe(
      Effect.mapError(() => transferError("A provider credential file is not valid JSON.")),
    );
    return content;
  });

  const exportProviders = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => transferError("Could not read provider settings and secrets.")),
    );
    const instances: ProviderTransferEntry[] = [];
    const warnings: string[] = [];
    const groups = new Map<string, string>();
    for (const [id, original] of Object.entries(allInstances(current))) {
      const instance = {
        ...original,
        ...(original.environment
          ? {
              environment: original.environment.map(
                ({ valueRedacted: _redacted, ...variable }) => variable,
              ),
            }
          : {}),
      };
      const env = {
        ...baseEnv,
        ...Object.fromEntries(instance.environment?.map((v) => [v.name, v.value]) ?? []),
      };
      let credentials: ProviderTransferEntry["credentials"];
      let homeGroup: string | undefined;
      if (instance.driver === "codex") {
        const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
          Effect.mapError(() => transferError(`Invalid Codex settings for ${id}.`)),
        );
        const sharedHome = resolveHome(config.homePath, path.join(home, ".codex"));
        const authHome = config.shadowHomePath
          ? resolveHome(config.shadowHomePath, sharedHome)
          : config.homePath
            ? sharedHome
            : resolveHome(env.CODEX_HOME, sharedHome);
        if (!groups.has(sharedHome)) groups.set(sharedHome, String(groups.size));
        homeGroup = groups.get(sharedHome);
        const content = yield* readCredentials(path.join(authHome, "auth.json"));
        if (content !== undefined) credentials = { kind: "codex", content };
        else if (resolveProviderInstanceEnabled(instance))
          warnings.push(
            `${instance.displayName ?? id}: no auth.json was found. Keychain-only or external logins need sign-in on the destination.`,
          );
      } else if (instance.driver === "claudeAgent") {
        const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
          Effect.mapError(() => transferError(`Invalid Claude settings for ${id}.`)),
        );
        const authHome = resolveHome(
          config.homePath || env.CLAUDE_CONFIG_DIR,
          path.join(home, ".claude"),
        );
        const groupKey = `claude:${authHome}`;
        if (!groups.has(groupKey)) groups.set(groupKey, String(groups.size));
        homeGroup = groups.get(groupKey);
        if (
          !instance.environment?.some(
            (v) =>
              ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].includes(
                v.name,
              ) && v.value,
          )
        ) {
          const content = yield* readCredentials(path.join(authHome, ".credentials.json"));
          if (content !== undefined) credentials = { kind: "claudeAgent", content };
          else if (resolveProviderInstanceEnabled(instance))
            warnings.push(
              `${instance.displayName ?? id}: no portable Claude login was found. Sign in through T3 before exporting to include a token.`,
            );
        }
      } else if (resolveProviderInstanceEnabled(instance)) {
        warnings.push(
          `${instance.displayName ?? id}: saved settings and environment secrets are included; external CLI logins and credential files must be set up on the destination.`,
        );
      }
      instances.push({
        id: ProviderInstanceId.make(id),
        instance,
        ...(homeGroup !== undefined ? { homeGroup } : {}),
        ...(credentials ? { credentials } : {}),
      });
    }
    const bundle = { format: "t3-provider-export", version: 1, instances, warnings } as const;
    const encoded = yield* encodeBundle(bundle).pipe(
      Effect.mapError(() => transferError("Provider settings cannot be exported in this format.")),
    );
    if (Buffer.byteLength(encoded) > PROVIDER_TRANSFER_MAX_BYTES)
      return yield* transferError("Provider export exceeds the 4 MB limit.");
    return yield* decodeBundle(bundle).pipe(
      Effect.mapError(() => transferError("Provider settings cannot be exported in this format.")),
    );
  });

  const importProviders = Effect.fn("ProviderTransfer.importProviders")(function* (
    input: typeof ProviderTransferImportInput.Type,
  ) {
    const bundle = yield* decodeBundle(input.bundle).pipe(
      Effect.mapError(() => transferError("Invalid provider export file.")),
    );
    const encoded = yield* encodeBundle(bundle).pipe(
      Effect.mapError(() => transferError("Invalid provider export file.")),
    );
    if (Buffer.byteLength(encoded) > PROVIDER_TRANSFER_MAX_BYTES)
      return yield* transferError("Provider export exceeds the 4 MB limit.");
    const ids = new Set<string>();
    for (const entry of bundle.instances) {
      if (ids.has(entry.id))
        return yield* transferError("The export contains duplicate provider IDs.");
      ids.add(entry.id);
      if (entry.instance.environment?.some((v) => v.valueRedacted))
        return yield* transferError(
          "The export contains redacted secrets. Export it again from Settings → Providers.",
        );
      if (entry.credentials) {
        if (entry.credentials.kind !== entry.instance.driver)
          return yield* transferError("A credential does not match its provider.");
        yield* decodeCredentials(entry.credentials.content).pipe(
          Effect.mapError(() => transferError("The export contains an invalid credential file.")),
        );
      }
    }
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => transferError("Could not read destination provider settings.")),
    );
    const usedIds = new Set(Object.keys(allInstances(current)));
    const next: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
    const imported: { sourceId: ProviderInstanceId; instanceId: ProviderInstanceId }[] = [];
    const importId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => transferError("Could not prepare the provider import.")),
    );
    const root = path.join(options.stateDir, "provider-imports", importId);
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const groups = new Map<string, string>();
    for (const entry of bundle.instances) {
      let id: string = entry.id;
      let suffix = 1;
      while (usedIds.has(id)) id = `${entry.id.slice(0, 48)}-imported-${suffix++}`;
      usedIds.add(id);
      const instanceId = ProviderInstanceId.make(id);
      let instance = entry.instance;
      const instanceHome = path.join(root, "accounts", id);
      if (instance.driver === "codex" || instance.driver === "claudeAgent") {
        const invalidSettings = () => transferError(`Invalid settings for ${entry.id}.`);
        const config =
          instance.driver === "codex"
            ? yield* decodeCodexSettings(instance.config ?? {}).pipe(
                Effect.mapError(invalidSettings),
              )
            : yield* decodeClaudeSettings(instance.config ?? {}).pipe(
                Effect.mapError(invalidSettings),
              );
        const environment =
          instance.environment?.filter(
            (v) => v.name !== "CODEX_HOME" && v.name !== "CLAUDE_CONFIG_DIR",
          ) ?? [];
        const groupKey = `${instance.driver}:${entry.homeGroup === undefined ? `instance:${entry.id}` : `group:${entry.homeGroup}`}`;
        if (!groups.has(groupKey))
          groups.set(groupKey, path.join(root, "pools", String(groups.size)));
        const sharedHome = groups.get(groupKey)!;
        directories.add(sharedHome);
        const authHome = instance.driver === "codex" ? instanceHome : sharedHome;
        if (instance.driver === "codex") {
          instance = {
            ...instance,
            environment,
            config: {
              ...config,
              binaryPath: "codex",
              homePath: sharedHome,
              shadowHomePath: instanceHome,
            },
          };
        } else {
          instance = {
            ...instance,
            environment,
            config: { ...config, binaryPath: "claude", homePath: authHome },
          };
        }
        directories.add(authHome);
        if (entry.credentials) {
          const filename = path.join(
            authHome,
            instance.driver === "codex" ? "auth.json" : ".credentials.json",
          );
          const previous = files.get(filename);
          if (previous !== undefined && previous !== entry.credentials.content)
            return yield* transferError(
              "Providers sharing a credential directory contain different credentials.",
            );
          files.set(filename, entry.credentials.content);
        }
      }
      next[instanceId] = instance;
      imported.push({ sourceId: entry.id, instanceId });
    }
    // Publish settings only after every account file exists. New homes make failure cleanup safe.
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      for (const directory of directories)
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      for (const [filename, content] of files)
        yield* fs.writeFileString(filename, content, { mode: 0o600, flag: "wx" });
    }).pipe(
      Effect.mapError(() =>
        transferError("Could not write imported credentials. No provider settings were changed."),
      ),
      Effect.onError(() => fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore)),
      Effect.uninterruptible,
    );
    // Settings can fail after publishing (for example while rereading the secret store).
    // Keep the prepared files on that failure so a published instance still has its login.
    yield* settings
      .updateSettings({ providerInstances: next }, { addProviderInstances: true })
      .pipe(
        Effect.mapError(() =>
          transferError(
            "Could not confirm the imported settings. Check Providers before retrying; prepared credential files were retained.",
          ),
        ),
        Effect.uninterruptible,
      );
    return { instances: imported, warnings: bundle.warnings };
  }, importLock.withPermits(1));

  return { exportProviders, importProviders };
});
