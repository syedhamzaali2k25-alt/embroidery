import { NotChosen, SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { PlanCards } from "../lib/PlanCards";
import { count, usePlans } from "../lib/credits";
import { usePage } from "../lib/usePage";
import type { Plans } from "../lib/api";
import "../css/pricing.css";

// /pricing: the plan cards (shared with the home page) and what credits do, stated only as the
// code does it (api/src/stitchbook_api/billing.py, migration 5). Every number comes from GET /plans.

function HowCreditsWork({ plans }: { plans: Plans }) {
  const exportCost = plans.credit_costs.export;
  const free = plans.plans.find((p) => p.id === "free");
  return (
    <section className="pricing__block" aria-labelledby="how-credits">
      <h2 id="how-credits">How credits <span className="accent">work</span></h2>
      <ul>
        {exportCost ? <li>Exporting a machine file costs {count(exportCost)} credits.</li> : null}
        <li>Credits are set aside when an export starts, and used only if it succeeds.</li>
        <li>If it fails or is cancelled, the credits come back.</li>
        <li>Previewing and editing a design is free.</li>
        {plans.monthly_rollover === false && (
          <li>A paid plan's credits are given at the start of each calendar month (UTC). Credits left at the end of the month do not carry over.</li>
        )}
        {free?.credit_period === "lifetime" && <li>The Free plan's credits are given once, when you sign up.</li>}
        {plans.credit_packs && <li>Credits you buy separately never expire, and are used after your monthly credits.</li>}
      </ul>
    </section>
  );
}

function Faq({ plans }: { plans: Plans }) {
  const discount = plans.yearly_discount_percent;
  return (
    <section className="pricing__block" aria-labelledby="pricing-faq">
      <h2 id="pricing-faq">Questions about <span className="accent">plans</span></h2>
      <div className="pricing__faq">
        <div>
          <h3>What does a yearly plan include?</h3>
          <p>
            It is billed once a year{discount ? `, at twelve times the monthly price less ${discount}%` : ""}, and gives the same credits
            every month as the monthly plan.
          </p>
        </div>
        <div>
          <h3>What happens to credits when an export fails?</h3>
          <p>They are returned to your balance. Credits are used only when an export succeeds.</p>
        </div>
        <div>
          <h3>Can I see what my credits were used for?</h3>
          <p>Yes. The Credits page lists every export with its time, design, status and the credits it used.</p>
        </div>
        <div>
          <h3>What is the refund policy?</h3>
          <p>{plans.refund_policy ?? <NotChosen what="[Refund policy]" />}</p>
        </div>
      </div>
    </section>
  );
}

export default function Pricing() {
  usePage("Pricing · Stitchbook", "pricing-page");
  const { plans, failed } = usePlans();
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="pricing">
          <header className="pricing__head">
            <h1>Plans and <span className="accent">credits</span></h1>
            <p className="pricing__lede">Preview is free. Exports use credits from your plan.</p>
          </header>
          {plans ? (
            <>
              <PlanCards plans={plans} headingLevel={2} />
              <HowCreditsWork plans={plans} />
              <Faq plans={plans} />
            </>
          ) : failed ? (
            <p role="alert">The plans could not be loaded: the server could not be reached. Try again in a moment.</p>
          ) : <p role="status">Loading plans…</p>}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
