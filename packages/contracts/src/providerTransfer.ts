import * as Schema from "effect/Schema";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

export const PROVIDER_TRANSFER_MAX_BYTES = 4 * 1024 * 1024;

export const ProviderTransferEntry = Schema.Struct({
  id: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  // Opaque grouping preserves Codex account pools without using source paths on import.
  homeGroup: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  credentials: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["codex", "claudeAgent"]),
      content: Schema.String.check(Schema.isMaxLength(256 * 1024)),
    }),
  ),
});
export type ProviderTransferEntry = typeof ProviderTransferEntry.Type;

export const ProviderTransferBundle = Schema.Struct({
  format: Schema.Literal("t3-provider-export"),
  version: Schema.Literal(1),
  instances: Schema.Array(ProviderTransferEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  warnings: Schema.Array(Schema.String),
});
export type ProviderTransferBundle = typeof ProviderTransferBundle.Type;

export const ProviderTransferImportInput = Schema.Struct({ bundle: ProviderTransferBundle });
export const ProviderTransferImportResult = Schema.Struct({
  instances: Schema.Array(
    Schema.Struct({ sourceId: ProviderInstanceId, instanceId: ProviderInstanceId }),
  ),
  warnings: Schema.Array(Schema.String),
});

export class ProviderTransferError extends Schema.TaggedError<ProviderTransferError>()(
  "ProviderTransferError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
