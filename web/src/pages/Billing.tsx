import { useEffect } from "react";
import { Link } from "react-router-dom";

import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { count, refreshCredits, useCredits } from "../lib/credits";
import { SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/pricing.css";

// /billing: the signed-in user's plan, credit balances and every metered operation.

const TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const OPERATION: Record<string, string> = { export: "Export", satin_columns: "Satin columns", auto_digitize: "Auto-digitize" };
const STATUS: Record<string, string> = { started: "In progress", succeeded: "Done", failed: "Failed (credits returned)", cancelled: "Cancelled (credits returned)" };

export default function Billing() {
  usePage("Credits and plan · Stitchbook", "billing-page");
  const { ready, session } = useSession();
  const account = useCredits();
  useEffect(() => {
    if (!signInEnabled || !ready) return;
    if (!session) location.assign(loginPath("/billing"));
    else void refreshCredits();
  }, [ready, session]);

  let body;
  if (!signInEnabled) {
    body = <p>Sign-in is not set up on this server, so there are no credits or plans here.</p>;
  } else if (!account) {
    body = <p role="status">Loading your credits…</p>;
  } else if (!account.enabled) {
    body = <p>Credits are not used on this server.</p>;
  } else {
    const plan = account.balances.plan, bought = account.balances.purchased;
    body = (
      <>
        <div className="billing__cards">
          <div className="billing__card">
            <span className="billing__label">Plan</span>
            <span className="billing__value">{account.plan_name ?? account.plan}</span>
            <span className="billing__sub">{account.interval === "year" ? "Billed yearly" : account.interval === "month" ? "Billed monthly" : "No payment"}</span>
          </div>
          <div className="billing__card">
            <span className="billing__label">Available credits</span>
            <span className="billing__value">{count(account.available)}</span>
            <span className="billing__sub">Plan {count(plan.available)} · bought {count(bought.available)}</span>
          </div>
          <div className="billing__card">
            <span className="billing__label">Set aside now</span>
            <span className="billing__value">{count(plan.reserved + bought.reserved)}</span>
            <span className="billing__sub">For exports still running</span>
          </div>
          <div className="billing__card">
            <span className="billing__label">Used</span>
            <span className="billing__value">{count(plan.consumed + bought.consumed)}</span>
            <span className="billing__sub">By exports that succeeded</span>
          </div>
        </div>
        <p><Link className="btn btn--ink" to="/pricing">See plans</Link></p>
        <section aria-labelledby="history-title">
          <h2 id="history-title" className="billing__history-title">History</h2>
          {account.history.length === 0 ? <p>Nothing yet. Exports will be listed here.</p> : (
            <div className="billing__table-wrap" tabIndex={0} role="region" aria-labelledby="history-title">
              <table className="billing__table">
                <thead><tr><th scope="col">Time</th><th scope="col">Design</th><th scope="col">Operation</th><th scope="col">Status</th><th scope="col">Credits</th></tr></thead>
                <tbody>
                  {account.history.map((row) => (
                    <tr key={row.job_id}>
                      <td>{TIME.format(new Date(row.created_at))}</td>
                      <td>{row.design_id ? <Link to={`/preview/${row.design_id.replace(/-/g, "")}`}>Open</Link> : "Deleted"}</td>
                      <td>{OPERATION[row.operation] ?? row.operation}{row.format ? ` (${row.format.toUpperCase()})` : ""}</td>
                      <td>{STATUS[row.status] ?? row.status}</td>
                      <td>{row.status === "succeeded" ? count(row.credits) : row.status === "started" ? `${count(row.credits)} set aside` : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>
    );
  }
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="billing">
          <h1>Credits and <span className="accent">plan</span></h1>
          {body}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
