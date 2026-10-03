import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError, planRequired, type Exports as ExportsData } from "../lib/api";
import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { count, useCredits, usePlans } from "../lib/credits";
import { DownloadLink } from "../lib/DownloadLink";
import { Pager, UpgradeNote, fileSize, TIME } from "../lib/UsageParts";
import { SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/pricing.css";

// /exports: the signed-in user's finished exports, newest first (Pro and Business). A file is
// downloaded again through the normal download, which asks for a fresh short-lived link; that is
// a new export and costs credits like any other.

type State = { data: ExportsData } | { upgrade: string } | { error: string } | null;

export default function Exports() {
  usePage("Export history · Stitchbook", "exports-page");
  const { ready, session } = useSession();
  const account = useCredits();
  const { plans } = usePlans();
  const [page, setPage] = useState(1);
  const [state, setState] = useState<State>(null);
  useEffect(() => {
    if (!signInEnabled || !ready) return;
    if (!session) { location.assign(loginPath("/exports")); return; }
    let live = true;
    api.exports(page).then((data) => live && setState({ data }), (err) => {
      if (!live) return;
      const plan = planRequired(err);
      if (plan !== null) setState({ upgrade: plan });
      else setState({ error: err instanceof ApiError ? err.message : "Your export history could not be loaded. Try again." });
    });
    return () => { live = false; };
  }, [ready, session, page]);

  const cost = account && account.enabled ? account.costs.export : null;
  let body;
  if (!signInEnabled) body = <p>Sign-in is not set up on this server, so there is no export history here.</p>;
  else if (!state) body = <p role="status">Loading your exports…</p>;
  else if ("upgrade" in state) body = <UpgradeNote what="Export history" plan={state.upgrade} plans={plans} />;
  else if ("error" in state) body = <p className="billing__error" role="alert">{state.error}</p>;
  else if (!state.data.enabled) body = <p>Export history is not used on this server.</p>;
  else if (state.data.items.length === 0 && page === 1) {
    body = <p className="billing__notice">No exports yet. When you download a machine file, it is listed here.</p>;
  } else {
    body = (
      <>
        <div className="billing__table-wrap" tabIndex={0} role="region" aria-label="Your exports">
          <table className="billing__table billing__table--stack">
            <thead><tr><th scope="col">Design</th><th scope="col">Format</th><th scope="col">Size</th><th scope="col">Credits</th><th scope="col">Date</th><th scope="col"><span className="visually-hidden">Download</span></th></tr></thead>
            <tbody>
              {state.data.items.map((row) => (
                <tr key={row.job_id}>
                  <td data-label="Design">{row.design_id ? <Link to={`/preview/${row.design_id}`}>{row.design_name ?? "Design"}</Link> : "Deleted design"}</td>
                  <td data-label="Format">{row.format?.toUpperCase() ?? "—"}</td>
                  <td data-label="Size">{fileSize(row.bytes)}</td>
                  <td data-label="Credits">{count(row.credits)}</td>
                  <td data-label="Date">{TIME.format(new Date(row.finished_at))}</td>
                  <td className="billing__cell--action">
                    {row.design_id && row.format
                      ? <DownloadLink designId={row.design_id} format={row.format} className="btn btn--ghost btn--row">Download again</DownloadLink>
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cost ? <p className="billing__sub">Downloading again makes a new export, so it uses {count(cost)} credits like any export.</p> : null}
        <Pager page={page} hasMore={state.data.has_more} onPage={setPage} />
      </>
    );
  }
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="billing">
          <h1>Export <span className="accent">history</span></h1>
          {body}
          <p><Link to="/billing">Credits and plan</Link></p>
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
