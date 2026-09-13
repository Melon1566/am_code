import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectPooledInstance } from "./providerAccountPool.ts";

const now = Date.parse("2026-01-01T12:00:00.000Z");
const later = "2026-01-01T15:00:00.000Z";
const earlier = "2026-01-01T09:00:00.000Z";

interface WindowInput {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

function provider(input: {
  readonly id: string;
  readonly pooled?: boolean;
  readonly groupKey?: string;
  readonly session?: WindowInput;
  readonly weekly?: WindowInput;
  readonly status?: ServerProvider["status"];
  readonly auth?: ServerProvider["auth"]["status"];
  readonly availability?: ServerProvider["availability"];
  readonly noLimits?: boolean;
}): ServerProvider {
  const windows: ServerProviderUsageWindow[] = [];
  if (input.session) {
    windows.push({
      id: "primary",
      kind: "session",
      label: "Session",
      usedPercent: input.session.usedPercent,
      windowDurationMins: 300,
      ...(input.session.resetsAt ? { resetsAt: input.session.resetsAt } : {}),
    });
  }
  if (input.weekly) {
    windows.push({
      id: "secondary",
      kind: "weekly",
      label: "Weekly",
      usedPercent: input.weekly.usedPercent,
      windowDurationMins: 10080,
      ...(input.weekly.resetsAt ? { resetsAt: input.weekly.resetsAt } : {}),
    });
  }
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make("codex"),
    continuation: {
      groupKey: input.groupKey ?? "codex:home:/shared",
      ...(input.pooled === false ? {} : { pooled: true }),
    },
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: input.auth ?? "authenticated" },
    checkedAt: "2026-01-01T11:00:00.000Z",
    ...(input.availability ? { availability: input.availability } : {}),
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.noLimits ? {} : { usageLimits: { checkedAt: "2026-01-01T11:00:00.000Z", windows } }),
  };
}

const id = (value: string) => ProviderInstanceId.make(value);

describe("selectPooledInstance", () => {
  it("returns the requested instance when it is not pooled", () => {
    const providers = [
      provider({ id: "a", pooled: false, session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", session: { usedPercent: 0 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("a"));
  });

  it("returns the requested instance when the pool has one member", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", groupKey: "codex:home:/other", session: { usedPercent: 0 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("a"));
  });

  it("starts a new thread on the member with the most session quota left", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 60 }, weekly: { usedPercent: 10 } }),
      provider({ id: "b", session: { usedPercent: 20 }, weekly: { usedPercent: 80 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("b"));
  });

  it("breaks a session tie on weekly quota, then keeps the requested instance", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 40 }, weekly: { usedPercent: 50 } }),
      provider({ id: "b", session: { usedPercent: 40 }, weekly: { usedPercent: 20 } }),
      provider({ id: "c", session: { usedPercent: 40 }, weekly: { usedPercent: 20 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("c"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("c"));
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("b"));
  });

  it("keeps a live session on its instance while it has quota", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 90 } }),
      provider({ id: "b", session: { usedPercent: 0 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("a"));
  });

  it("keeps a live session even when the client asks for another pooled instance", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 90 } }),
      provider({ id: "b", session: { usedPercent: 0 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("b"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("a"));
  });

  it("moves a live session when its instance is exhausted", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", session: { usedPercent: 30 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("b"));
  });

  it("treats an exhausted weekly window as exhausted", () => {
    const providers = [
      provider({
        id: "a",
        session: { usedPercent: 10 },
        weekly: { usedPercent: 100, resetsAt: later },
      }),
      provider({ id: "b", session: { usedPercent: 30 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("b"));
  });

  it("keeps the live instance when every member is exhausted", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", session: { usedPercent: 100, resetsAt: later } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("a"));
  });

  it("counts a window whose reset has passed as restored", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: earlier } }),
      provider({ id: "b", session: { usedPercent: 30 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("a"));
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("b"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("a"));
  });

  it("ranks members without usage data below members with known quota", () => {
    const providers = [
      provider({ id: "a", noLimits: true }),
      provider({ id: "b", session: { usedPercent: 95 } }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: undefined,
        now,
      }),
    ).toBe(id("b"));
  });

  it("falls back to a member without usage data when the live instance is exhausted", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", noLimits: true }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("b"));
  });

  it("ignores members that are unavailable, unauthenticated, or errored", () => {
    const providers = [
      provider({ id: "a", session: { usedPercent: 100, resetsAt: later } }),
      provider({ id: "b", session: { usedPercent: 0 }, availability: "unavailable" }),
      provider({ id: "c", session: { usedPercent: 0 }, auth: "unauthenticated" }),
      provider({ id: "d", session: { usedPercent: 0 }, status: "error" }),
    ];
    expect(
      selectPooledInstance({
        providers,
        requestedInstanceId: id("a"),
        liveInstanceId: id("a"),
        now,
      }),
    ).toBe(id("a"));
  });
});
