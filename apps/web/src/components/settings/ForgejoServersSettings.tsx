import {
  normalizeForgejoServerUrl,
  type EnvironmentId,
  type ForgejoServerConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSearchTarget } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Access tokens per Forgejo or Gitea server, stored on the environment's
 * server. A stored token only ever reaches this form as a redaction marker, so
 * the field shows a placeholder until the user types a replacement. Servers
 * supplied by environment variables are read-only until overridden.
 */
export function ForgejoServersSettings({
  environmentId,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSaved: () => void;
}) {
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.forgejoServers);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const setting = searchableSetting("forgejo-servers");
  const [drafts, setDrafts] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right));
  const disabled = !canWrite || saving;

  async function save(url: string, accessToken: string | null) {
    if (!canWrite || pending.current) return false;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: { forgejoServers: { [url]: accessToken === null ? null : { accessToken } } },
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save the Forgejo server.");
        return false;
      }
      onSaved();
      return true;
    } catch {
      setError("Could not save the Forgejo server. Check the connection and try again.");
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <SettingsSearchTarget id={setting.id} className="grid gap-3">
      <div className="min-w-0 space-y-1">
        <span className="text-xs font-medium text-foreground">{setting.title}</span>
        <p className="text-2xs leading-normal text-muted-foreground">
          Access tokens let T3 Code talk to a server without the fj or tea CLI. Tokens are kept on
          this environment's server and never shown again. Give the token read and write access to
          repositories, issues, and pull requests, plus read access to your user.
        </p>
      </div>
      <div className="grid gap-2">
        {entries.map(([url, server]) => (
          <ForgejoServerRow
            key={url}
            url={url}
            server={server}
            disabled={disabled}
            onSave={(accessToken) => save(url, accessToken)}
            onRemove={() => void save(url, null)}
          />
        ))}
        {drafts.map((draftId) => (
          <NewForgejoServerRow
            key={draftId}
            existingUrls={entries.map(([url]) => url)}
            disabled={disabled}
            onSave={async (url, accessToken) => {
              if (await save(url, accessToken)) {
                setDrafts((current) => current.filter((id) => id !== draftId));
              }
            }}
            onCancel={() => setDrafts((current) => current.filter((id) => id !== draftId))}
          />
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setDrafts((current) => [...current, `draft-${Date.now()}`])}
        >
          Add server
        </Button>
      </div>
    </SettingsSearchTarget>
  );
}

const STORED_TOKEN_PLACEHOLDER = "Stored token, enter a new value to replace";

function ForgejoServerRow({
  url,
  server,
  disabled,
  onSave,
  onRemove,
}: {
  readonly url: string;
  readonly server: ForgejoServerConfig;
  readonly disabled: boolean;
  readonly onSave: (accessToken: string) => Promise<boolean>;
  readonly onRemove: () => void;
}) {
  const fromEnvironment = server.fromEnvironment === true;
  const [overriding, setOverriding] = useState(false);
  const [token, setToken] = useState("");
  const editable = !disabled && (!fromEnvironment || overriding);
  const hasStoredToken = server.accessToken.length > 0;
  const canSave = editable && token.trim().length > 0;

  return (
    <div className="grid gap-2 rounded-lg bg-card px-3 py-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 truncate text-xs text-foreground">{url}</code>
        {fromEnvironment ? (
          <Badge variant="secondary" size="sm">
            From environment
          </Badge>
        ) : null}
        {!fromEnvironment ? (
          <div className="ml-auto">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Remove ${url}`}
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="sm:flex-1">
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Access token for ${url}`}
            placeholder={
              fromEnvironment && !overriding
                ? "Token supplied by the server environment"
                : hasStoredToken
                  ? STORED_TOKEN_PLACEHOLDER
                  : "Access token"
            }
            value={token}
            disabled={!editable}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        {fromEnvironment && !overriding ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setOverriding(true)}
          >
            Override
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canSave}
            onClick={async () => {
              if (await onSave(token.trim())) {
                setToken("");
                setOverriding(false);
              }
            }}
          >
            Save token
          </Button>
        )}
      </div>
    </div>
  );
}

function NewForgejoServerRow({
  existingUrls,
  disabled,
  onSave,
  onCancel,
}: {
  readonly existingUrls: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onSave: (url: string, accessToken: string) => void;
  readonly onCancel: () => void;
}) {
  const [rawUrl, setRawUrl] = useState("");
  const [token, setToken] = useState("");
  const [attempted, setAttempted] = useState(false);
  const normalized = normalizeForgejoServerUrl(rawUrl);
  const urlError =
    rawUrl.trim().length === 0
      ? "Enter the server URL."
      : normalized === null
        ? "Use a full http or https URL, for example https://codeberg.org."
        : existingUrls.includes(normalized)
          ? "This server is already configured. Edit its row instead."
          : null;
  const tokenError = token.trim().length === 0 ? "Enter an access token." : null;
  const error = urlError ?? tokenError;

  return (
    <div className="grid gap-2 rounded-lg bg-card px-3 py-3 ring-1 ring-primary/40 dark:bg-white/3">
      <Input
        size="sm"
        type="url"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-label="Forgejo server URL"
        placeholder="https://forge.example.com"
        value={rawUrl}
        aria-invalid={attempted && urlError !== null}
        onChange={(event) => setRawUrl(event.target.value)}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="sm:flex-1">
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-label="Forgejo access token"
            placeholder="Access token"
            value={token}
            aria-invalid={attempted && tokenError !== null}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setAttempted(true);
            if (error !== null || normalized === null) return;
            onSave(normalized, token.trim());
          }}
        >
          Save server
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {attempted && error ? <p className="text-2xs text-destructive">{error}</p> : null}
    </div>
  );
}
