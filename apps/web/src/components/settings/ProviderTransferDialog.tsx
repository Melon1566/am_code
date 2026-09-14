import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderTransferBundle,
  PROVIDER_TRANSFER_MAX_BYTES,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

const bundleJson = Schema.fromJsonString(ProviderTransferBundle);

export function ProviderTransferDialog({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const exportProviders = useAtomCommand(serverEnvironment.exportProviders, {
    reportFailure: false,
  });
  const importProviders = useAtomCommand(serverEnvironment.importProviders, {
    reportFailure: false,
  });
  const [mode, setMode] = useState<"import" | "export" | null>(null);
  const [bundle, setBundle] = useState<ProviderTransferBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pending = useRef(false);

  function open(next: "import" | "export") {
    setBundle(null);
    setError(null);
    setSuccess(null);
    setMode(next);
  }

  async function prepareExport() {
    if (pending.current) return;
    pending.current = true;
    open("export");
    setBusy(true);
    try {
      const result = await exportProviders({ environmentId, input: undefined });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not export providers. Update the server and try again.",
        );
      } else setBundle(result.value);
    } catch {
      setError("Could not export providers. Check the connection and try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function readFile(file: File | undefined) {
    setBundle(null);
    setError(null);
    if (!file) return;
    pending.current = true;
    setBusy(true);
    try {
      if (file.size > PROVIDER_TRANSFER_MAX_BYTES) {
        setError("Choose a provider export smaller than 4 MB.");
        return;
      }
      setBundle(Schema.decodeUnknownSync(bundleJson)(await file.text()));
    } catch {
      setError("This is not a supported T3 provider export file.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function download() {
    if (!bundle) return;
    const url = URL.createObjectURL(
      new Blob([Schema.encodeSync(bundleJson)(bundle)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "t3-providers.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function importBundle() {
    if (!bundle || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await importProviders({ environmentId, input: { bundle } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not import providers. Update the server and try again.",
        );
      } else {
        setSuccess(
          `Imported ${result.value.instances.length} provider configurations into ${environmentLabel}. They are ready to review in Providers.`,
        );
        setBundle(null);
      }
    } catch {
      setError("The import could not be confirmed. Check Providers before retrying.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy}
        onClick={() => open("import")}
        aria-label="Import providers"
      >
        <UploadIcon />
        <span className="hidden sm:inline">Import</span>
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy}
        onClick={() => void prepareExport()}
        aria-label="Export providers"
      >
        <DownloadIcon />
        <span className="hidden sm:inline">Export</span>
      </Button>
      <Dialog
        open={mode !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !pending.current) {
            setMode(null);
            setBundle(null);
          }
        }}
      >
        <DialogPopup showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{mode === "export" ? "Export providers" : "Import providers"}</DialogTitle>
            <DialogDescription>
              {mode === "export"
                ? `Transfer provider configurations and credentials from ${environmentLabel}.`
                : `Add provider configurations and credentials to ${environmentLabel}. Existing providers are kept.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Export files contain unencrypted API keys and login tokens. Keep the file private and
              delete it after transferring it to your other machine.
            </p>
            {mode === "import" && !success && (
              <label className="block space-y-2">
                <span>Provider export file</span>
                <input
                  className="block w-full text-sm"
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(event) => void readFile(event.target.files?.[0])}
                />
              </label>
            )}
            {busy && (
              <p role="status">
                {mode === "export" ? "Preparing export…" : "Reading or importing providers…"}
              </p>
            )}
            {bundle && (
              <>
                <p>{bundle.instances.length} provider configurations</p>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-muted-foreground">
                  {bundle.instances.map((entry) => (
                    <li key={entry.id}>
                      {entry.instance.displayName ?? entry.id}{" "}
                      <span className="text-xs">({entry.instance.driver})</span>
                    </li>
                  ))}
                </ul>
                {bundle.warnings.length > 0 && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <p className="font-medium">Credentials to check</p>
                    <ul className="space-y-2 text-xs text-muted-foreground">
                      {[...new Set(bundle.warnings)].map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {mode === "import" && (
                  <p className="text-xs text-muted-foreground">
                    Codex and Claude receive new credential directories on this machine. Their CLI
                    binaries must be installed. Review any other machine-specific paths before
                    starting a thread.
                  </p>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {success && <p role="status">{success}</p>}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMode(null);
                setBundle(null);
              }}
            >
              Close
            </Button>
            {bundle && (
              <Button
                disabled={busy}
                onClick={mode === "export" ? download : () => void importBundle()}
              >
                {mode === "export" ? "Download export" : "Import providers"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
