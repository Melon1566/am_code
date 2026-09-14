import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthMethod,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

interface CodexSignInSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  /** Undefined until the environment publishes the instance's first snapshot. */
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}

/**
 * Sign in to or out of the ChatGPT account behind one Codex instance. Used on
 * the instance card and as the last step of the add-provider wizard. The
 * browser flow finishes on the host; the code flow works from any device.
 */
export function CodexSignInSection(props: CodexSignInSectionProps) {
  return (
    <section aria-label="Codex sign-in" className="divide-y divide-border/50 text-xs">
      {props.readOnly ? (
        <SettingsRow title="Setup unavailable" description="Provider setup is read-only." />
      ) : props.provider === undefined ? (
        <SettingsRow
          title="ChatGPT account"
          description={`Preparing the instance on ${props.environmentLabel}.`}
        />
      ) : props.provider.setup === undefined ? (
        <SettingsRow
          title="Update required"
          description="Update this environment to sign in to Codex from T3 Code."
        />
      ) : (
        <CodexSignInActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
        />
      )}
    </section>
  );
}

function CodexSignInActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
}: Pick<CodexSignInSectionProps, "environmentId" | "environmentLabel" | "instanceId"> & {
  readonly provider: ServerProvider;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const auth = authQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ flowId: string | null; what: "link" | "code" } | null>(
    null,
  );

  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const authenticated = provider.auth.status === "authenticated";
  const account = [provider.auth.email, provider.auth.label].filter(Boolean).join(" · ");
  const statusMessage =
    auth === null
      ? "Reading sign-in status."
      : authActive || auth.phase === "failed" || auth.phase === "cancelled"
        ? (auth.message ?? "Codex sign-in is in progress.")
        : authenticated
          ? account
            ? `Signed in as ${account}.`
            : "Signed in."
          : auth.phase === "idle" && auth.message
            ? auth.message
            : "Sign in with your ChatGPT account.";
  const authorizationUrl = auth?.phase === "waiting" ? auth.authorizationUrl : null;
  const userCode = auth?.phase === "waiting" ? (auth.userCode ?? null) : null;
  const queryError = authQuery.error === null ? null : String(authQuery.error);
  const actionsDisabled = pendingLabel !== null || queryError !== null;
  const canSignIn = !authActive && !authenticated && provider.setup?.canAuthenticate === true;
  const retry = auth?.phase === "failed" || auth?.phase === "cancelled";

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Codex sign-in failed.");
        }
        return false;
      }
      return true;
    } catch {
      setError("Codex sign-in failed. Try again.");
      return false;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  const signIn = (method: ProviderAuthMethod) =>
    runCommand("Starting sign-in", () =>
      startAuth({ environmentId, input: { instanceId, method } }),
    );

  async function openSignInPage() {
    if (!authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
      setError(null);
    } catch {
      setError("Could not open the page. Copy the link and open it in your browser.");
    }
  }

  async function copy(what: "link" | "code") {
    const value = what === "code" ? userCode : authorizationUrl;
    if (!value) return;
    try {
      await writeTextToClipboard(
        value,
        what === "code" ? "Codex sign-in code" : "Codex sign-in link",
      );
      setCopied({ flowId: auth?.flowId ?? null, what });
      setError(null);
    } catch {
      setError(`Could not copy the ${what}.`);
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out of ChatGPT for ${provider.displayName ?? "Codex"} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    );
    if (confirmed) {
      await runCommand("Signing out", () => logoutAuth(target));
    }
  }

  const copiedLabel = (what: "link" | "code") =>
    copied?.what === what && copied.flowId === (auth?.flowId ?? null);

  return (
    <>
      <SettingsRow
        title="ChatGPT account"
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        description="The subscription this instance spends."
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:max-w-72 sm:items-end sm:text-right">
            <p role="status" className="text-muted-foreground [overflow-wrap:anywhere]">
              {statusMessage}
            </p>
            {userCode ? (
              <p className="font-mono text-base tracking-widest text-foreground select-all">
                {userCode}
              </p>
            ) : null}
            {authorizationUrl ? (
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button size="sm" variant="outline" onClick={() => void openSignInPage()}>
                  {userCode ? "Open verification page" : "Open sign-in page"}
                </Button>
                {userCode ? (
                  <Button size="sm" variant="ghost" onClick={() => void copy("code")}>
                    {copiedLabel("code") ? "Code copied" : "Copy code"}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void copy("link")}>
                  {copiedLabel("link") ? "Link copied" : "Copy link"}
                </Button>
              </div>
            ) : auth?.phase === "waiting" ? (
              <p className="text-muted-foreground">
                Sign-in is open in another client. Complete or cancel it there.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {authActive && auth?.flowId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actionsDisabled}
                  onClick={() => {
                    const flowId = auth.flowId;
                    if (!flowId) return;
                    void runCommand("Cancelling sign-in", () =>
                      cancelAuth({ environmentId, input: { instanceId, flowId } }),
                    );
                  }}
                >
                  Cancel sign-in
                </Button>
              ) : null}
              {canSignIn ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionsDisabled || auth === null || !provider.installed}
                    onClick={() => void signIn("browser")}
                  >
                    {retry ? "Retry sign-in" : "Sign in with ChatGPT"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionsDisabled || auth === null || !provider.installed}
                    onClick={() => void signIn("deviceCode")}
                  >
                    Use a code instead
                  </Button>
                </>
              ) : null}
              {!authActive && authenticated && provider.setup?.canAuthenticate ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionsDisabled || auth === null}
                  onClick={() => void signOut()}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        {userCode ? (
          <p className="pb-2 text-muted-foreground">
            Enter the code on the verification page from any device. The sign-in finishes on{" "}
            {environmentLabel}.
          </p>
        ) : authorizationUrl ? (
          <p className="pb-2 text-muted-foreground">
            The sign-in page finishes on {environmentLabel}. From a phone or another computer,
            cancel and use a code instead.
          </p>
        ) : null}
      </SettingsRow>
      <p className="sr-only" role="status">
        {pendingLabel ? `${pendingLabel}.` : null}
      </p>
      {error || queryError ? (
        <p role="alert" className="px-3 py-3 text-destructive [overflow-wrap:anywhere] sm:px-4">
          {error ?? queryError}
        </p>
      ) : null}
    </>
  );
}
