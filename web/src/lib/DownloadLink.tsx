import { useState, type ReactNode } from "react";

import { api, ApiError, loginHere, needsLogin } from "./api";
import { signInEnabled } from "./auth";

/**
 * Download a design's machine file. Without sign-in it is a plain link to the API. With sign-in,
 * the file is in private Storage: a click asks the API for a signed link that works for a short
 * time (storage.signed_url_ttl_s) and opens it. No public file address exists.
 */
export function DownloadLink({ designId, format, className, children }: {
  designId: string; format: string; className: string; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!signInEnabled) {
    return <a className={className} href={api.downloadUrl(designId, format)} download>{children}</a>;
  }
  const go = () => {
    setBusy(true);
    setError(null);
    api.downloadLink(designId, format).then(
      (link) => { setBusy(false); window.location.assign(link.url); },
      (err) => {
        setBusy(false);
        if (needsLogin(err)) window.location.assign(loginHere());
        else setError(err instanceof ApiError ? err.message : "The download could not start. Try again.");
      },
    );
  };
  return (
    <>
      <button className={className} type="button" onClick={go} disabled={busy} aria-busy={busy || undefined}>{children}</button>
      {error && <span className="download-error" role="alert">{error}</span>}
    </>
  );
}
