import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, ApiError, loginHere, needsLogin } from "./api";
import { signInEnabled } from "./auth";
import { cannotAfford, refreshCredits, useCredits } from "./credits";
import { Icon } from "./Icon";

/**
 * Download a design's machine file. Without sign-in it is a plain link to the API. With sign-in,
 * the file is in private Storage: a click asks the API for a signed link that works for a short
 * time (storage.signed_url_ttl_s) and opens it. No public file address exists.
 */
/** The zero-credit message: plain words, a link to the plans, never colour alone. */
export function NoCredits() {
  return (
    <p className="no-credits" role="status">
      <Icon name="i-alert" /><span>You don't have enough credits for this. <Link to="/pricing">See plans</Link></span>
    </p>
  );
}

export function DownloadLink({ designId, format, className, children }: {
  designId: string; format: string; className: string; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const account = useCredits();
  if (!signInEnabled) {
    return <a className={className} href={api.downloadUrl(designId, format)} download>{children}</a>;
  }
  const blocked = cannotAfford(account, "export");
  const go = () => {
    setBusy(true);
    setError(null);
    setShort(false);
    api.downloadLink(designId, format).then(
      (link) => { setBusy(false); void refreshCredits(); window.location.assign(link.url); },
      (err) => {
        setBusy(false);
        if (needsLogin(err)) window.location.assign(loginHere());
        else if (err instanceof ApiError && err.status === 402) { setShort(true); void refreshCredits(); }
        else setError(err instanceof ApiError ? err.message : "The download could not start. Try again.");
      },
    );
  };
  return (
    <>
      <button className={className} type="button" onClick={go} disabled={busy || blocked} aria-busy={busy || undefined}>{children}</button>
      {(blocked || short) && <NoCredits />}
      {error && <span className="download-error" role="alert">{error}</span>}
    </>
  );
}
