// LEGAL TEXT, DRAFT: this page must be reviewed (by a lawyer, and by the owner against the
// product as it is then) before launch. It describes only what the service does today; it must
// change when accounts and payments are added. Owner decisions come from config.py via GET /site
// and show "Not chosen yet" until set.
import { Link } from "react-router-dom";

import { DraftBanner, SitePage, SiteValue, useSite } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";

export default function Terms() {
  usePage("Terms of Service · Stitchbook", "site-page");
  const state = useSite();
  return (
    <SitePage>
      <DraftBanner state={state} />
      <h1>Terms of Service</h1>
      <p className="doc__lede">The rules for using Stitchbook as it works today.</p>

      <h2>Who provides the service</h2>
      <p>Stitchbook is run by <SiteValue state={state} value={(s) => s.company_name} />.</p>

      <h2>What Stitchbook does</h2>
      <p>
        You upload a PNG or JPG image of a logo. Stitchbook finds its colours, traces its shapes and lays out
        embroidery stitches for them automatically. You can look at the stitches in the preview, change them in the
        editor, and download a machine embroidery file.
      </p>

      <h2>No guarantee for the stitches</h2>
      <p>
        The files Stitchbook makes have not yet been sewn on an embroidery machine by its owner. No guarantee is given
        that the stitches look right, that a file works on your machine, or that it suits your fabric. Sew a test
        piece before you use a file for anything that matters.
      </p>

      <h2>Your images</h2>
      <ul>
        <li>Only upload an image you have the right to use: your own logo, or one whose owner has given you
          permission.</li>
        <li>Do not upload brand logos or other artwork you do not own and have no permission for.</li>
        <li>You stay responsible for what you upload and for what you sew from it.</li>
      </ul>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not upload anything unlawful, or files that are not images of a logo.</li>
        <li>Do not try to break the service, get around its limits, or overload it.</li>
        <li>Do not open, change or download designs whose address was not given to you.</li>
      </ul>

      <h2>Accounts and payments</h2>
      <p>
        There are no accounts and no payments yet. Anyone who has a design's address can open it (see{" "}
        <Link to="/privacy">Privacy</Link>). These terms will change when accounts and payments are added.
      </p>

      <h2>Law</h2>
      <p>These terms fall under the law of <SiteValue state={state} value={(s) => s.governing_country} />.</p>

      <h2>Contact</h2>
      <p>
        Questions about these terms:{" "}
        <SiteValue state={state} value={(s) => s.contact_email} render={(email) => <a href={`mailto:${email}`}>{email}</a>} />.
      </p>
    </SitePage>
  );
}
