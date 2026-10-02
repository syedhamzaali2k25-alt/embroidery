import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, ApiError, type Account, type Plans } from "../lib/api";
import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { count, refreshCredits, useCredits, usePlans } from "../lib/credits";
import { NotChosen, SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/pricing.css";

// /billing: the signed-in user's plan, credit balances and every metered operation; Manage
// billing and Cancel plan (the payment provider's own pages: no card form here); and, back from
// the payment page (?checkout=done), a short wait for the payment to show up.

const TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const OPERATION: Record<string, string> = { export: "Export", satin_columns: "Satin columns", auto_digitize: "Auto-digitize" };
const STATUS: Record<string, string> = { started: "In progress", succeeded: "Done", failed: "Failed (credits returned)", cancelled: "Cancelled (credits returned)" };

type Enabled = Extract<Account, { enabled: true }>;
const paid = (a: Account | null) => !!a && a.enabled && a.plan !== "free" && a.status === "active";
const failure = (err: unknown) => err instanceof ApiError && err.status === 503 ? "Payments are not available yet."
  : "The payment service did not answer. Try again in a minute.";

/** Back from the payment page: look for the payment every poll_s seconds, for at most wait_s. */
function CheckoutReturn({ plans, account }: { plans: Plans; account: Account | null }) {
  const { poll_s: poll, wait_s: wait } = plans.checkout_return;
  const auto = !!poll && !!wait;
  const [state, setState] = useState<"waiting" | "late">(auto ? "waiting" : "late");
  const [checking, setChecking] = useState(false);
  const arrived = paid(account);
  useEffect(() => {
    if (!auto || arrived || state !== "waiting") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= wait! * 1000) { setState("late"); window.clearInterval(timer); return; }
      void refreshCredits();
    }, poll! * 1000);
    return () => window.clearInterval(timer);
  }, [auto, arrived, state, poll, wait]);
  if (arrived) {
    return <p className="billing__notice" role="status">Your payment went through. Your plan is now {(account as Enabled).plan_name ?? (account as Enabled).plan}.</p>;
  }
  if (state === "waiting") return <p className="billing__notice" role="status">Checking for your payment…</p>;
  return (
    <div className="billing__notice" role="status">
      <p>Your payment has not shown up here yet. It can take a few minutes.</p>
      <button className="btn btn--ghost" type="button" disabled={checking}
        onClick={() => { setChecking(true); void refreshCredits().finally(() => setChecking(false)); }}>
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** Manage billing (the provider's own page) and Cancel plan. */
function PlanActions({ account }: { account: Enabled }) {
  const [busy, setBusy] = useState<"manage" | "cancel" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const manage = () => {
    setBusy("manage"); setMessage(null);
    api.manageBilling().then(({ url }) => {
      if (url) window.location.assign(url);
      else { setBusy(null); setMessage({ text: "There is no payment account to manage yet.", error: false }); }
    }, (err) => { setBusy(null); setMessage({ text: failure(err), error: true }); });
  };
  const cancel = () => {
    setBusy("cancel"); setMessage(null);
    api.cancelPlan().then(() => {
      setBusy(null); setConfirming(false);
      setMessage({ text: "Renewal is stopped. You keep your plan until the end of the period you paid for.", error: false });
      void refreshCredits();
    }, (err) => { setBusy(null); setMessage({ text: failure(err), error: true }); });
  };
  const cancellable = account.plan !== "free" && account.status !== "canceled";
  return (
    <div className="billing__actions">
      <div className="billing__buttons">
        <button className="btn btn--ink" type="button" onClick={manage} disabled={busy !== null}>
          {busy === "manage" ? "Opening…" : "Manage billing"}
        </button>
        {cancellable && !confirming && (
          <button className="btn btn--ghost" type="button" onClick={() => setConfirming(true)} disabled={busy !== null}>Cancel plan</button>
        )}
        <Link className="btn btn--ghost" to="/pricing">See plans</Link>
      </div>
      {confirming && (
        <div className="billing__confirm" role="group" aria-label="Cancel plan">
          <p>Stop renewing your {account.plan_name ?? account.plan} plan? You keep it until the end of the period you paid for.</p>
          <div className="billing__buttons">
            <button className="btn btn--ink" type="button" onClick={cancel} disabled={busy !== null}>
              {busy === "cancel" ? "Stopping…" : "Yes, stop renewal"}
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => setConfirming(false)} disabled={busy !== null}>Keep my plan</button>
          </div>
        </div>
      )}
      {message && <p className={message.error ? "billing__error" : "billing__done"} role={message.error ? "alert" : "status"}>{message.text}</p>}
      <p className="billing__provider"><NotChosen what="[Payments, tax and invoices: owner to confirm]" /></p>
    </div>
  );
}

export default function Billing() {
  usePage("Credits and plan · Stitchbook", "billing-page");
  const { ready, session } = useSession();
  const account = useCredits();
  const { plans } = usePlans();
  const [params] = useSearchParams();
  const returned = useRef(params.get("checkout") === "done").current;
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
        {account.status === "past_due" && (
          <p className="billing__notice" role="alert">
            Your last payment did not go through, so no new monthly credits are added. Update your payment details in Manage billing.
          </p>
        )}
        {account.status === "canceled" && account.plan !== "free" && (
          <p className="billing__notice">Renewal is stopped. You keep your plan until the end of the period you paid for.</p>
        )}
        {plans?.payments_available ? <PlanActions account={account} /> : <p><Link className="btn btn--ink" to="/pricing">See plans</Link></p>}
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
          {returned && plans && account?.enabled && <CheckoutReturn plans={plans} account={account} />}
          {body}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
