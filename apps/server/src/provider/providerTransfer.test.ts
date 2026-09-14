import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderDriverKind, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ProviderTransferBundle } from "@t3tools/contracts";
import { ServerSettingsService, layerTest } from "../serverSettings.ts";
import { makeProviderTransfer } from "./providerTransfer.ts";

const decodeBundle = Schema.decodeUnknownEffect(ProviderTransferBundle);

it.layer(NodeServices.layer)("provider transfer", (it) => {
  it.effect("preserves provider edits made while an import prepares credential files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const settings = yield* ServerSettingsService;
      const editedId = ProviderInstanceId.make("edited-during-import");
      const transfer = yield* makeProviderTransfer({
        stateDir: root,
        homeDirectory: root,
        environment: {},
      }).pipe(
        Effect.provideService(ServerSettingsService, {
          ...settings,
          updateSettings: (patch, options) =>
            settings
              .updateSettings({
                providerInstances: {
                  [editedId]: {
                    driver: ProviderDriverKind.make("codex"),
                    displayName: "Concurrent edit",
                  },
                },
              })
              .pipe(Effect.andThen(settings.updateSettings(patch, options))),
        }),
      );
      const bundle = yield* decodeBundle({
        format: "t3-provider-export",
        version: 1,
        warnings: [],
        instances: [{ id: "personal", instance: { driver: "codex", config: {} } }],
      });
      const result = yield* transfer.importProviders({ bundle });
      const finalSettings = yield* settings.getSettings;
      expect(finalSettings.providerInstances[editedId]?.displayName).toBe("Concurrent edit");
      expect(finalSettings.providerInstances[result.instances[0]!.instanceId]).toBeDefined();
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("serializes simultaneous imports so both sets of accounts survive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const transfer = yield* makeProviderTransfer({
        stateDir: root,
        homeDirectory: root,
        environment: {},
      });
      const bundle = yield* decodeBundle({
        format: "t3-provider-export",
        version: 1,
        warnings: [],
        instances: [
          {
            id: "personal",
            instance: { driver: "codex", config: {} },
            credentials: { kind: "codex", content: '{"OPENAI_API_KEY":"example"}' },
          },
        ],
      });
      const results = yield* Effect.all(
        [transfer.importProviders({ bundle }), transfer.importProviders({ bundle })],
        { concurrency: "unbounded" },
      );
      const settings = yield* (yield* ServerSettingsService).getSettings;
      const ids = results.map((result) => result.instances[0]!.instanceId);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        const config = settings.providerInstances[id]!.config as { shadowHomePath: string };
        expect(yield* fs.readFileString(`${config.shadowHomePath}/auth.json`)).toContain("example");
      }
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("retains prepared credentials if settings persistence cannot be confirmed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const settings = yield* ServerSettingsService;
      let credentialPath: string | undefined;
      const transfer = yield* makeProviderTransfer({
        stateDir: root,
        homeDirectory: root,
        environment: {},
      }).pipe(
        Effect.provideService(ServerSettingsService, {
          ...settings,
          updateSettings: (patch) => {
            const instance = Object.values(patch.providerInstances ?? {})[0];
            credentialPath = `${(instance!.config as { shadowHomePath: string }).shadowHomePath}/auth.json`;
            return Effect.fail(
              new ServerSettingsError({
                settingsPath: root,
                operation: "write-file",
                cause: "test failure",
              }),
            );
          },
        }),
      );
      const bundle = yield* decodeBundle({
        format: "t3-provider-export",
        version: 1,
        warnings: [],
        instances: [
          {
            id: "personal",
            instance: { driver: "codex", config: {} },
            credentials: { kind: "codex", content: '{"OPENAI_API_KEY":"example"}' },
          },
        ],
      });
      const result = yield* transfer.importProviders({ bundle }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("Check Providers before retrying");
      expect(credentialPath).toBeDefined();
      expect(yield* fs.readFileString(credentialPath!)).toContain("example");
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("round trips pooled accounts and secrets into new isolated instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/account-a`);
      yield* fs.makeDirectory(`${root}/account-b`);
      yield* fs.writeFileString(`${root}/account-a/auth.json`, '{"tokens":{"refresh_token":"a"}}');
      yield* fs.writeFileString(`${root}/account-b/auth.json`, '{"tokens":{"refresh_token":"b"}}');
      const source = yield* makeProviderTransfer({
        stateDir: `${root}/source`,
        homeDirectory: root,
        environment: {},
      }).pipe(
        Effect.provide(
          layerTest({
            providerInstances: {
              [ProviderInstanceId.make("personal")]: {
                driver: ProviderDriverKind.make("codex"),
                displayName: "Personal",
                config: {
                  homePath: `${root}/shared`,
                  shadowHomePath: `${root}/account-a`,
                  proxyUrl: "http://proxy:3128",
                  accountPooling: true,
                },
              },
              [ProviderInstanceId.make("work")]: {
                driver: ProviderDriverKind.make("codex"),
                config: {
                  homePath: `${root}/shared`,
                  shadowHomePath: `${root}/account-b`,
                  accountPooling: true,
                },
              },
              [ProviderInstanceId.make("claude")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [
                  {
                    name: "CLAUDE_CODE_OAUTH_TOKEN",
                    value: "secret-token",
                    sensitive: true,
                    valueRedacted: true,
                  },
                ],
                config: { accountPooling: true },
              },
              [ProviderInstanceId.make("claude-work")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [
                  { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "other-token", sensitive: true },
                ],
                config: { accountPooling: true },
              },
            },
          }),
        ),
      );
      const bundle = yield* source.exportProviders;
      expect(
        bundle.instances.find((entry) => entry.id === "personal")?.credentials?.content,
      ).toContain('"a"');
      expect(
        bundle.instances.find((entry) => entry.id === "claude")?.instance.environment?.[0]?.value,
      ).toBe("secret-token");
      expect(
        bundle.instances.find((entry) => entry.id === "claude")?.instance.environment?.[0]
          ?.valueRedacted,
      ).toBeUndefined();
      yield* Effect.gen(function* () {
        const destination = yield* makeProviderTransfer({
          stateDir: `${root}/destination`,
          homeDirectory: root,
          environment: {},
        });
        const result = yield* destination.importProviders({ bundle });
        const settings = yield* (yield* ServerSettingsService).getSettings;
        expect(settings.providerInstances[ProviderInstanceId.make("personal")]?.displayName).toBe(
          "Existing",
        );
        const importedId = result.instances.find(
          (entry) => entry.sourceId === "personal",
        )!.instanceId;
        expect(importedId).not.toBe("personal");
        const a = settings.providerInstances[importedId]!.config as {
          homePath: string;
          shadowHomePath: string;
          proxyUrl: string;
        };
        const bId = result.instances.find((entry) => entry.sourceId === "work")!.instanceId;
        const b = settings.providerInstances[bId]!.config as typeof a;
        expect(a.homePath).toBe(b.homePath);
        expect(a.shadowHomePath).not.toBe(b.shadowHomePath);
        expect(a.shadowHomePath).toContain(`${root}/destination/`);
        expect(a.proxyUrl).toBe("http://proxy:3128");
        expect(yield* fs.readFileString(`${a.shadowHomePath}/auth.json`)).toContain('"a"');
        expect(yield* fs.readFileString(`${b.shadowHomePath}/auth.json`)).toContain('"b"');
        const claudeId = result.instances.find((entry) => entry.sourceId === "claude")!.instanceId;
        expect(settings.providerInstances[claudeId]?.environment?.[0]?.value).toBe("secret-token");
        const claudeWorkId = result.instances.find(
          (entry) => entry.sourceId === "claude-work",
        )!.instanceId;
        expect(settings.providerInstances[claudeWorkId]?.environment?.[0]?.value).toBe(
          "other-token",
        );
        expect(settings.providerInstances[claudeId]?.config).toEqual(
          settings.providerInstances[claudeWorkId]?.config,
        );
        if ((yield* HostProcessPlatform) !== "win32") {
          expect((yield* fs.stat(`${a.shadowHomePath}/auth.json`)).mode & 0o777).toBe(0o600);
        }
      }).pipe(
        Effect.provide(
          layerTest({
            providerInstances: {
              [ProviderInstanceId.make("personal")]: {
                driver: ProviderDriverKind.make("codex"),
                displayName: "Existing",
              },
            },
          }),
        ),
      );
    }),
  );

  it.effect(
    "includes legacy configs and reports external logins without exporting other server settings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const transfer = yield* makeProviderTransfer({
          stateDir: root,
          homeDirectory: root,
          environment: {},
        });
        const bundle = yield* transfer.exportProviders;
        expect(
          bundle.instances.find((entry) => entry.id === "codex")?.instance.config,
        ).toMatchObject({ proxyUrl: "http://proxy:3128" });
        expect(
          bundle.warnings.some(
            (warning) => warning.includes("codex") && warning.includes("auth.json"),
          ),
        ).toBe(true);
        expect(bundle).not.toHaveProperty("forgejoServers");
        expect(yield* fs.readDirectory(root)).toEqual([]);
      }).pipe(
        Effect.provide(layerTest({ providers: { codex: { proxyUrl: "http://proxy:3128" } } })),
      ),
  );

  it.effect(
    "imports shared Claude credential files once and keeps independent homes separate",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const transfer = yield* makeProviderTransfer({
          stateDir: root,
          homeDirectory: root,
          environment: {},
        });
        const entry = {
          instance: { driver: "claudeAgent", config: {} },
          credentials: {
            kind: "claudeAgent",
            content: '{"claudeAiOauth":{"refreshToken":"token"}}',
          },
        };
        const bundle = yield* decodeBundle({
          format: "t3-provider-export",
          version: 1,
          warnings: [],
          instances: [
            { ...entry, id: "one", homeGroup: "same" },
            { ...entry, id: "two", homeGroup: "same" },
            { ...entry, id: "three", homeGroup: "../elsewhere" },
          ],
        });
        const result = yield* transfer.importProviders({ bundle });
        const settings = yield* (yield* ServerSettingsService).getSettings;
        const homes = result.instances.map(
          (entry) =>
            (settings.providerInstances[entry.instanceId]!.config as { homePath: string }).homePath,
        );
        expect(homes[0]).toBe(homes[1]);
        expect(homes[0]).not.toBe(homes[2]);
        expect(homes[2]).toContain(`${root}/provider-imports/`);
        expect(yield* fs.readFileString(`${homes[0]}/.credentials.json`)).toContain("refreshToken");
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    "rejects malformed credentials and redacted secrets without leaking their contents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const transfer = yield* makeProviderTransfer({
          stateDir: root,
          homeDirectory: root,
          environment: {},
        });
        for (const instance of [
          {
            id: "bad",
            instance: { driver: "codex" },
            credentials: { kind: "codex", content: "secret-invalid-json" },
          },
          {
            id: "bad",
            instance: {
              driver: "codex",
              environment: [{ name: "KEY", value: "", sensitive: true, valueRedacted: true }],
            },
          },
        ]) {
          const bundle = yield* decodeBundle({
            format: "t3-provider-export",
            version: 1,
            warnings: [],
            instances: [instance],
          });
          const result = yield* transfer.importProviders({ bundle }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.message).not.toContain("secret-invalid-json");
        }
        expect(yield* fs.readDirectory(root)).toEqual([]);
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    "rejects duplicate IDs and mismatched credentials before creating files or settings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const transfer = yield* makeProviderTransfer({
          stateDir: root,
          homeDirectory: root,
          environment: {},
        });
        const entry = {
          id: "example",
          instance: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
          credentials: { kind: "codex", content: "{}" },
        };
        const bundle = yield* decodeBundle({
          format: "t3-provider-export",
          version: 1,
          instances: [entry],
          warnings: [],
        });
        expect((yield* transfer.importProviders({ bundle }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* fs.readDirectory(root)).toEqual([]);
        const duplicates = yield* decodeBundle({
          ...bundle,
          instances: [
            { ...entry, credentials: undefined },
            { ...entry, credentials: undefined },
          ],
        });
        expect(
          (yield* transfer.importProviders({ bundle: duplicates }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* fs.readDirectory(root)).toEqual([]);
      }).pipe(Effect.provide(layerTest())),
  );
});
