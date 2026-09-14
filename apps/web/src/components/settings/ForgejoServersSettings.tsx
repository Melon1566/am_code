import { normalizeForgejoServerUrl, type ForgejoServerConfig } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSearchTarget } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Access tokens per Forgejo or Gitea server, stored on the environment's
 * server. A stored token only ever reaches this form as a redaction marker, so
 * the field shows a placeholder until the user types a replacement. Servers
 * supplied by environment variables are read-only until overridden.
 */
export function ForgejoServersSettings() {
  const servers = useScopedSettings((settings) => settings.forgejoServers);
  const updateSettings = useUpdateScopedSettings();
  const setting = searchableSetting("forgejo-servers");
  const [drafts, setDrafts] = useState<ReadonlyArray<string>>([]);
  const entries = Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right));

  return (
    <SettingsSearchTarget id={setting.id} className="grid gap-3">
      <div className="min-w-0 space-y-1">
        <span className="text-xs font-medium text-foreground">{setting.title}</span>
        <p className="text-[11px] leading-[1.45] text-muted-foreground">
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
            onSave={(accessToken) => updateSettings({ forgejoServers: { [url]: { accessToken } } })}
            onRemove={() => updateSettings({ forgejoServers: { [url]: null } })}
          />
        ))}
        {drafts.map((draftId) => (
          <NewForgejoServerRow
            key={draftId}
            existingUrls={entries.map(([url]) => url)}
            onSave={(url, accessToken) => {
              updateSettings({ forgejoServers: { [url]: { accessToken } } });
              setDrafts((current) => current.filter((id) => id !== draftId));
            }}
            onCancel={() => setDrafts((current) => current.filter((id) => id !== draftId))}
          />
        ))}
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
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
  onSave,
  onRemove,
}: {
  readonly url: string;
  readonly server: ForgejoServerConfig;
  readonly onSave: (accessToken: string) => void;
  readonly onRemove: () => void;
}) {
  const fromEnvironment = server.fromEnvironment === true;
  const [overriding, setOverriding] = useState(false);
  const [token, setToken] = useState("");
  const editable = !fromEnvironment || overriding;
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
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="ml-auto"
            aria-label={`Remove ${url}`}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="bg-background sm:flex-1"
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
        {fromEnvironment && !overriding ? (
          <Button size="sm" variant="outline" onClick={() => setOverriding(true)}>
            Override
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canSave}
            onClick={() => {
              onSave(token.trim());
              setToken("");
              setOverriding(false);
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
  onSave,
  onCancel,
}: {
  readonly existingUrls: ReadonlyArray<string>;
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
        className="bg-background"
        aria-label="Forgejo server URL"
        placeholder="https://forge.example.com"
        value={rawUrl}
        aria-invalid={attempted && urlError !== null}
        onChange={(event) => setRawUrl(event.target.value)}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="bg-background sm:flex-1"
          aria-label="Forgejo access token"
          placeholder="Access token"
          value={token}
          aria-invalid={attempted && tokenError !== null}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAttempted(true);
            if (error !== null || normalized === null) return;
            onSave(normalized, token.trim());
          }}
        >
          Save server
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {attempted && error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
