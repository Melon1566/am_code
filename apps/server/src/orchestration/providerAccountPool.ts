/**
 * Picks which pooled provider instance serves a thread. Instances that opted
 * into pooling and share a continuation group can resume each other's threads,
 * so the reactor may start or move a thread between them. A live session stays
 * where it is until its account runs dry; a thread without a session starts on
 * the account with the most quota left.
 *
 * @module orchestration/providerAccountPool
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";

interface PoolMember {
  readonly instanceId: ProviderInstanceId;
  /** Remaining share per window kind, or null when the account reports none. */
  readonly session: number | null;
  readonly weekly: number | null;
  readonly exhausted: boolean;
}

/** Quota left once a passed reset is honored; the snapshot may predate the reset. */
function effectiveRemaining(window: ServerProviderUsageWindow, now: number): number {
  if (window.resetsAt !== undefined) {
    const resetsAt = Date.parse(window.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt <= now) return 100;
  }
  return remainingPercent(window);
}

function isEligible(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.availability !== "unavailable" &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status === "authenticated"
  );
}

function toMember(provider: ServerProvider, now: number): PoolMember {
  const limits = provider.usageLimits;
  const windows = limits && !limits.unavailable ? limits.windows : [];
  let session: number | null = null;
  let weekly: number | null = null;
  let exhausted = false;
  for (const window of windows) {
    const remaining = effectiveRemaining(window, now);
    if (remaining <= 0) exhausted = true;
    if (window.kind === "session") session = Math.min(session ?? 100, remaining);
    if (window.kind === "weekly") weekly = Math.min(weekly ?? 100, remaining);
  }
  return { instanceId: provider.instanceId, session, weekly, exhausted };
}

/** Sorts more remaining quota first; unknown quota sorts below any known amount. */
function compareMembers(a: PoolMember, b: PoolMember): number {
  const bySession = (b.session ?? -1) - (a.session ?? -1);
  if (bySession !== 0) return bySession;
  return (b.weekly ?? -1) - (a.weekly ?? -1);
}

/**
 * The instance a turn should run on. Returns `requestedInstanceId` untouched
 * when it is not pooled or has no eligible pool mates.
 */
export function selectPooledInstance(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly requestedInstanceId: ProviderInstanceId;
  readonly liveInstanceId: ProviderInstanceId | undefined;
  readonly now: number;
}): ProviderInstanceId {
  const requested = input.providers.find(
    (provider) => provider.instanceId === input.requestedInstanceId,
  );
  const groupKey = requested?.continuation?.groupKey;
  if (!requested || requested.continuation?.pooled !== true || groupKey === undefined) {
    return input.requestedInstanceId;
  }
  const members = input.providers
    .filter(
      (provider) =>
        provider.driver === requested.driver &&
        provider.continuation?.groupKey === groupKey &&
        provider.continuation.pooled === true &&
        isEligible(provider),
    )
    .map((provider) => toMember(provider, input.now));
  if (members.length < 2) return input.requestedInstanceId;

  if (input.liveInstanceId !== undefined) {
    const live = members.find((member) => member.instanceId === input.liveInstanceId);
    if (live === undefined || !live.exhausted) return input.liveInstanceId;
    const fallback = members
      .filter((member) => member.instanceId !== input.liveInstanceId && !member.exhausted)
      .sort(compareMembers)[0];
    return fallback?.instanceId ?? input.liveInstanceId;
  }

  const best = [...members].sort(compareMembers)[0];
  if (best === undefined) return input.requestedInstanceId;
  const anchor = members.find((member) => member.instanceId === input.requestedInstanceId);
  // Ties keep the requested instance so the picker never moves for nothing.
  if (anchor !== undefined && compareMembers(best, anchor) === 0) return input.requestedInstanceId;
  return best.instanceId;
}
