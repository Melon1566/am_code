import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthMethod,
  ProviderDriverKind,
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
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

interface ProviderSignInSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  /** Undefined until the environment publishes the instance's first snapshot. */
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}

interface SignInCopy {
  readonly product: string;
  readonly account: string;
  readonly accountDescription: string;
  readonly idle: string;
  readonly signIn: string;
  /** Codex offers a device code; Claude's CLI has one flow. */
  readonly deviceCode: boolean;
  /** Claude asks for the code Anthropic shows after the browser sign-in. */
  readonly pasteCode: boolean;
}

const COPY: Record<"codex" | "claudeAgent", SignInCopy> = {
  codex: {
    product: "Codex",
    account: "ChatGPT account",
    accountDescription: "The subscription this instance spends.",
    idle: "Sign in with your ChatGPT account.",
    signIn: "Sign in with ChatGPT",
    deviceCode: true,
    pasteCode: false,
  },
  claudeAgent: {
    product: "Claude",
    account: "Claude account",
    accountDescription:
      "Signing in stores a long-lived token on this instance, so it keeps its own account.",
    idle: "Sign in with your Claude subscription.",
    signIn: "Sign in with Claude",
    deviceCode: false,
    pasteCode: true,
  },
};

export function providerSignInCopy(driver: ProviderDriverKind): SignInCopy | undefined {
  if (driver === "codex") return COPY.codex;
  if (driver === "claudeAgent") return COPY.claudeAgent;
  return undefined;
}

/**
 * Sign in to or out of the account behind one provider instance. Used on the
 * instance card and as the last step of the add-provider wizard. The browser
 * flow finishes on the host; a device code or pasted code works from any
 * device.
 */
export function ProviderSignInSection(props: ProviderSignInSectionProps) {
  const labels = providerSignInCopy(props.driver);
  if (labels === undefined) return null;
  return (
    <section aria-label={`${labels.product} sign-in`} className="divide-y divide-border/50 text-xs">
      {props.readOnly ? (
        <SettingsRow title="Setup unavailable" description="Provider setup is read-only." />
      ) : props.provider === undefined ? (
        <SettingsRow
          title={labels.account}
          description={`Preparing the instance on ${props.environmentLabel}.`}
        />
      ) : props.provider.setup === undefined ? (
        <SettingsRow
          title="Update required"
          description={`Update this environment to sign in to ${labels.product} from T3 Code.`}
        />
      ) : (
        <ProviderSignInActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          labels={labels}
        />
      )}
    </section>
  );
}

function ProviderSignInActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  labels,
}: Pick<ProviderSignInSectionProps, "environmentId" | "environmentLabel" | "instanceId"> & {
  readonly provider: ServerProvider;
  readonly labels: SignInCopy;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const auth = authQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const [pastedCode, setPastedCode] = useState({ flowId: null as string | null, value: "" });
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
        ? (auth.message ?? `${labels.product} sign-in is in progress.`)
        : authenticated
          ? account
            ? `Signed in as ${account}.`
            : "Signed in."
          : auth.phase === "idle" && auth.message
            ? auth.message
            : labels.idle;
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
          setError(
            failure instanceof Error ? failure.message : `${labels.product} sign-in failed.`,
          );
        }
        return false;
      }
      return true;
    } catch {
      setError(`${labels.product} sign-in failed. Try again.`);
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
        what === "code" ? `${labels.product} sign-in code` : `${labels.product} sign-in link`,
      );
      setCopied({ flowId: auth?.flowId ?? null, what });
      setError(null);
    } catch {
      setError(`Could not copy the ${what}.`);
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Sign out of ${provider.displayName ?? labels.product} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    );
    if (confirmed) {
      await runCommand("Signing out", () => logoutAuth(target));
    }
  }

  const copiedLabel = (what: "link" | "code") =>
    copied?.what === what && copied.flowId === (auth?.flowId ?? null);
  const codeValue = pastedCode.flowId === (auth?.flowId ?? null) ? pastedCode.value : "";

  async function submitPastedCode() {
    const flowId = auth?.flowId;
    if (!flowId || auth.phase !== "waiting" || codeValue.trim().length === 0) return;
    const accepted = await runCommand("Sending code", () =>
      completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl: codeValue.trim() } }),
    );
    if (accepted) setPastedCode({ flowId: null, value: "" });
  }

  return (
    <>
      <SettingsRow
        title={labels.account}
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        description={labels.accountDescription}
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
                    {retry ? "Retry sign-in" : labels.signIn}
                  </Button>
                  {labels.deviceCode ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={actionsDisabled || auth === null || !provider.installed}
                      onClick={() => void signIn("deviceCode")}
                    >
                      Use a code instead
                    </Button>
                  ) : null}
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
        ) : authorizationUrl && labels.pasteCode ? (
          <form
            className="grid gap-2 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPastedCode();
            }}
          >
            <label
              htmlFor={`provider-sign-in-code-${instanceId}`}
              className="text-muted-foreground"
            >
              Sign in on the page, copy the code it shows, and paste it here. Works from any device.
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={`provider-sign-in-code-${instanceId}`}
                size="sm"
                autoComplete="off"
                spellCheck={false}
                className="bg-background sm:flex-1"
                placeholder="Paste the code"
                value={codeValue}
                maxLength={512}
                disabled={actionsDisabled}
                onChange={(event) =>
                  setPastedCode({ flowId: auth?.flowId ?? null, value: event.target.value })
                }
              />
              <Button
                size="sm"
                variant="outline"
                type="submit"
                disabled={actionsDisabled || codeValue.trim().length === 0}
              >
                Continue
              </Button>
            </div>
          </form>
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
