import { useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError, type PlanInfo, type Plans } from "./api";
import { signInEnabled, useSession } from "./auth";
import { count, extraSeatLine, money, useCredits } from "./credits";
import { Unset } from "./SiteChrome";
import "../css/pricing.css";

// The Free / Pro / Business cards with the Monthly | Yearly switch, used by /pricing and the
// home page's Pricing section alike. Every price, discount, credit amount and feature comes from
// GET /plans (config.py); an unchosen value shows a visible placeholder. Nothing is typed in here.

type Interval = "month" | "year";
const FILL: Record<PlanInfo["id"], string> = { free: "card--lavender", pro: "card--lime", business: "card--pink" };

function PlanButton({ plan, interval, plans }: { plan: PlanInfo; interval: Interval; plans: Plans }) {
  const { session } = useSession();
  const account = useCredits();
  const [state, setState] = useState<"idle" | "busy" | { error: string }>("idle");
  const unavailable = <button className="btn plan__cta plan__cta--off" type="button" disabled>Payments are not available yet</button>;
  const current = account && account.enabled ? account.plan : null;
  if (plan.id === "free") {
    // Free: sign up when signed out; once signed in (or with no accounts at all) straight to work.
    if (signInEnabled && !session) {
      return <Link className="btn btn--ink plan__cta" to={`/signup?next=${encodeURIComponent("/upload")}`}>Start free</Link>;
    }
    return <Link className="btn btn--ink plan__cta" to="/upload">Open editor</Link>;
  }
  // Paid plans: only with a payment provider configured (billing.provider; "fake" in local runs).
  if (!plans.payments_available || !signInEnabled) return unavailable;
  if (!session) {
    return <Link className="btn btn--ink plan__cta" to={`/signup?next=${encodeURIComponent("/pricing")}`}>Sign up</Link>;
  }
  if (current === plan.id) return <button className="btn btn--ink plan__cta" type="button" disabled>Current plan</button>;
  const go = () => {
    setState("busy");
    api.checkout(plan.id as "pro" | "business", interval).then(
      ({ url }) => window.location.assign(url),
      (err) => setState({ error: err instanceof ApiError && err.status === 503 ? "Payments are not available yet." : err.message }),
    );
  };
  return (
    <>
      <button className="btn btn--ink plan__cta" type="button" onClick={go} disabled={state === "busy"}>
        {state === "busy" ? "Opening checkout…" : "Upgrade"}
      </button>
      {typeof state === "object" && <p className="plan__error" role="alert">{state.error}</p>}
    </>
  );
}

function Price({ plan, interval, plans }: { plan: PlanInfo; interval: Interval; plans: Plans }) {
  const monthly = money(plan.price_monthly, plans.currency);
  if (monthly === null) return <p className="plan__price"><Unset what="Price not chosen yet" /></p>;
  if (Number(plan.price_monthly) === 0) return <p className="plan__price"><span className="plan__amount">{monthly}</span></p>;
  if (interval === "month") {
    return <p className="plan__price"><span className="plan__amount">{monthly}</span> <span className="plan__per">per month</span></p>;
  }
  const yearly = money(plan.price_yearly, plans.currency);
  const perMonth = money(plan.price_yearly_per_month, plans.currency);
  return (
    <>
      <p className="plan__price"><span className="plan__amount">{yearly ?? <Unset />}</span> <span className="plan__per">per year</span></p>
      {perMonth && <p className="plan__equiv">That is {perMonth} per month.</p>}
    </>
  );
}

function credits(plan: PlanInfo): string | null {
  if (plan.credits === null) return null;
  return plan.credit_period === "lifetime"
    ? `${count(plan.credits)} credits when you sign up, not renewed`
    : `${count(plan.credits)} credits per month`;
}

/** "Credits are provided by your team": what a team member sees instead of plan cards. */
export function TeamMemberNote() {
  return (
    <div className="billing__notice member-note" role="status">
      <p>Credits are provided by your team. Your designs stay private to you.</p>
      <Link className="btn btn--ink" to="/home">My designs</Link>
    </div>
  );
}

export function PlanCards({ plans, headingLevel = 3 }: { plans: Plans; headingLevel?: 2 | 3 }) {
  const [interval, setInterval] = useState<Interval>("month");
  const account = useCredits();
  if (account && account.enabled && account.team?.role === "member") return <TeamMemberNote />;
  // The extra-seat line, only once a plan offers teams (not while "coming soon").
  const teams = plans.plans.some((p) => p.features?.some((f) => f.key === "teams" && f.status === "available"));
  const seatLine = teams ? extraSeatLine(plans.team) : null;
  const discount = plans.yearly_discount_percent;
  const H = headingLevel === 2 ? "h2" : "h3";
  const exportCost = plans.credit_costs.export;
  return (
    <div className="plans">
      <div className="plans__switch" role="radiogroup" aria-label="Billing period">
        {(["month", "year"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={interval === value} className="plans__option"
                  onClick={() => setInterval(value)}>
            {value === "month" ? "Monthly" : "Yearly"}
            {value === "year" && discount ? <span className="plans__badge">{discount}% off</span> : null}
          </button>
        ))}
      </div>
      <ul className="plans__grid">
        {plans.plans.map((plan) => (
          <li key={plan.id} className={`card ${FILL[plan.id]} plan`} data-plan={plan.id}>
            <H className="plan__name">{plan.name ?? <Unset what="Name not chosen yet" />}</H>
            <Price plan={plan} interval={interval} plans={plans} />
            <p className="plan__credits">{credits(plan) ?? <Unset what="Credits not chosen yet" />}</p>
            {plan.features === null
              ? <p className="plan__features-none"><Unset what="Features not chosen yet" /></p>
              : plan.features.length > 0 && (
                <ul className="plan__features">
                  {plan.features.map((f) => (
                    <li key={f.key}>{f.name}{f.status === "coming_soon" && <span className="plan__soon">Coming soon</span>}</li>
                  ))}
                </ul>
              )}
            <div className="plan__action"><PlanButton plan={plan} interval={interval} plans={plans} /></div>
          </li>
        ))}
      </ul>
      {exportCost ? <p className="plans__note">1 export = {count(exportCost)} credits. Preview is free.</p>
        : <p className="plans__note">Preview is free.</p>}
      {seatLine && <p className="plans__note plans__seat">{seatLine}</p>}
    </div>
  );
}
