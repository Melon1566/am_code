/**
 * Upsert or remove one environment variable on a provider instance's
 * settings. Sensitive values land in the secret store through the usual
 * settings persistence, and the registry rebuilds the instance when its
 * environment changes.
 *
 * @module provider/instanceEnvironmentSettings
 */
import {
  ProviderSetupError,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";

type SettingsAccess = Pick<
  ServerSettingsService["Service"],
  "getSettings" | "updateProviderInstance"
>;

/**
 * Returns whether anything changed. `null` removes the variable. Values are
 * always stored as sensitive; this helper exists for credentials.
 */
export const setInstanceEnvironmentVariable = (
  settings: SettingsAccess,
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
    readonly value: string | null;
    readonly defaultInstance?: ProviderInstanceConfig;
  },
): Effect.Effect<boolean, ProviderSetupError> =>
  Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const configured = current.providerInstances[input.instanceId];
    const instance = configured ?? input.defaultInstance;
    if (instance === undefined) {
      return yield* new ProviderSetupError({
        instanceId: input.instanceId,
        operation: input.value === null ? "logout" : "start",
        detail: "This provider instance is no longer configured.",
      });
    }
    const existing = instance.environment ?? [];
    const others = existing.filter((variable) => variable.name !== input.name);
    const previous = existing.find((variable) => variable.name === input.name);
    if (input.value === null) {
      if (previous === undefined) return false;
    } else if (previous?.value === input.value && previous.sensitive) {
      return false;
    }
    const environment: ProviderInstanceEnvironmentVariable[] =
      input.value === null
        ? others
        : [...others, { name: input.name, value: input.value, sensitive: true }];
    const nextInstance: ProviderInstanceConfig = {
      ...instance,
      ...(environment.length > 0 ? { environment } : {}),
    };
    if (environment.length === 0) delete (nextInstance as { environment?: unknown }).environment;
    yield* settings.updateProviderInstance({
      operation: configured ? "upsert" : "create",
      instanceId: input.instanceId,
      instance: nextInstance,
    });
    return true;
  }).pipe(
    Effect.catchTags({
      ServerSettingsError: (cause) =>
        Effect.fail(
          new ProviderSetupError({
            instanceId: input.instanceId,
            operation: input.value === null ? "logout" : "start",
            detail: `Could not save the instance's credentials: ${cause.operation}.`,
          }),
        ),
    }),
  );
