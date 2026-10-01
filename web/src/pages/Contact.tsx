// Contact: the owner's email address from config.py (via GET /site) as a mailto link. There is no
// contact form and nothing is sent from the site: there is no email service.
import { NotChosen, SitePage, useSite } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";

export default function Contact() {
  usePage("Contact · Stitchbook", "site-page");
  const { site, failed } = useSite();
  const email = site?.contact_email ?? null;
  return (
    <SitePage>
      <h1>Contact</h1>
      {failed ? (
        <p role="alert"><NotChosen what="Not loaded: the server could not be reached" /></p>
      ) : !site ? (
        <p className="site-loading" role="status">Loading…</p>
      ) : email ? (
        <>
          <p className="doc__lede">Write to us by email:</p>
          <p className="contact-email"><a href={`mailto:${email}`}>{email}</a></p>
          <p>This opens your own email program. There is no contact form on this site.</p>
        </>
      ) : (
        <p className="doc__lede"><NotChosen what="Contact email not chosen yet" /></p>
      )}
    </SitePage>
  );
}
