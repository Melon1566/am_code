import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const draft: ServerProviderDraft = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("withInstanceIdentity", () => {
  it("marks a pooled instance on its continuation", () => {
    const snapshot = withInstanceIdentity({
      instanceId: ProviderInstanceId.make("codex_personal"),
      driverKind: ProviderDriverKind.make("codex"),
      displayName: undefined,
      accentColor: undefined,
      continuationGroupKey: "codex:home:/shared",
      pooled: true,
    })(draft);
    expect(snapshot.continuation).toEqual({ groupKey: "codex:home:/shared", pooled: true });
  });

  it("omits the pooled marker when the instance is not pooled", () => {
    const snapshot = withInstanceIdentity({
      instanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      displayName: undefined,
      accentColor: undefined,
      continuationGroupKey: "codex:home:/shared",
      pooled: false,
    })(draft);
    expect(snapshot.continuation).toEqual({ groupKey: "codex:home:/shared" });
  });
});
