// LEGAL TEXT, DRAFT: this page must be reviewed (by a lawyer, and by the owner against the
// product as it is then) before launch. It describes only what the code does today; when the
// product changes (accounts, payments, sharing, hosting, analytics, email), this text must change
// with it. Owner decisions come from config.py via GET /site and show "Not chosen yet" until set.
// Two versions, each true for its build: with sign-in (Supabase settings at build time: accounts,
// data in Supabase) and without (local mode: no accounts, data on the server's disk).
import { Link } from "react-router-dom";

import { GOOGLE_CLIENT_ID, signInEnabled } from "../lib/auth";
import { DraftBanner, NotChosen, SitePage, SiteValue, useSite } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toLocaleString("en", { maximumFractionDigits: 1 })} MB`;

export default function Privacy() {
  usePage("Privacy · Stitchbook", "site-page");
  const state = useSite();
  const video = state.site?.demo_video_url ?? "";
  return (
    <SitePage>
      <DraftBanner state={state} />
      <h1>Privacy</h1>
      <p className="doc__lede">
        What Stitchbook does with the image you upload and what it makes from it, as the service works today.
      </p>

      <h2>Who runs Stitchbook</h2>
      <p>
        Stitchbook is run by <SiteValue state={state} value={(s) => s.company_name} />. Questions about this page:{" "}
        <SiteValue state={state} value={(s) => s.contact_email}
                   render={(email) => <a href={`mailto:${email}`}>{email}</a>} />.
      </p>

      <h2>What you upload</h2>
      <p>
        One image file of your logo per design: PNG or JPG, up to{" "}
        <SiteValue state={state} value={(s) => s.max_upload_bytes} render={(n) => megabytes(Number(n))} />.
        The server keeps the file as you sent it, together with its file name, its size in bytes and its size in pixels.
      </p>
      <p>
        The upload page only offers PNG and JPG. The server also stores an SVG file if one is sent to it
        directly, but cannot turn it into stitches.
      </p>

      <h2>What is made from it</h2>
      <ul>
        <li>An image check: size, contrast, sharpness and small specks, with warnings.</li>
        <li>The colours found in the image (the background is left out), and the ones you choose to keep.</li>
        <li>The shapes traced from those colours, and the stitches laid out for them.</li>
        <li>A machine embroidery file (DST), a preview image (PNG) and a short report about the stitches.</li>
        <li>Your settings (design width, fill density, the colours kept) and every change you make in the
          editor (including a fabric preset), with its undo history.</li>
      </ul>

      {signInEnabled && (
        <>
          <h2>Your account</h2>
          <p>
            To save a design you sign up with your email address and a password. Accounts are handled by Supabase
            Auth, a service Stitchbook uses: it keeps your email address, a hash of your password (never the password
            itself), when the account was made and when you last logged in, and a log of sign-in events that includes
            the IP address each came from. It also sends the email that confirms your address. Stitchbook keeps a profile row for your account with no other details.
          </p>
          <h2>Signing in with Google</h2>
          <p>
            If you choose "Continue with Google"{GOOGLE_CLIENT_ID ? " or the Google sign-in prompt" : ""}, Google tells
            Stitchbook (through Supabase Auth) your email address, your name and your profile picture, and the ID of your
            Google account that ties them together. Nothing else: no contacts, files, calendar or other Google data. No
            password is kept for a Google sign-in.
          </p>
          {GOOGLE_CLIENT_ID && (
            <p>
              The Log in and Sign up pages load a script from Google (accounts.google.com) to offer the sign-in prompt.
              Loading it lets Google see the request from your browser (such as your IP address), and the script can use
              Google's own cookies on Google's site. No other page loads it.
            </p>
          )}
        </>
      )}

      <h2>Where it is stored</h2>
      {signInEnabled ? (
        <>
          <p>
            In Stitchbook's Supabase project: your designs, settings, changes and job results in its database, and
            your image and the files made from it in its file storage, in private folders named by your account's id.
            The project's region: <NotChosen what="Not stated yet" />. The stitches are worked out on the Stitchbook
            server, which reads your image from there and writes the results back.
          </p>
          <p>
            When you use "Create satin columns" in the editor, a copy of the image goes to the server's background job
            queue (Redis), where Stitchbook's worker program traces it. The job and its result are kept there for a
            set time and then removed by the queue; the finished job's status is saved with the design.
          </p>
        </>
      ) : (<>
      <p>
        On the Stitchbook server's own disk, in the storage folder set for the server (STORAGE_DIR), one folder per
        design named by a random id. Your image is processed on that server; it is not sent to another service.
      </p>
      <p>
        When you use "Create satin columns" in the editor, a copy of the image goes to the server's background job
        queue (Redis), where Stitchbook's worker program traces it. The job and its result are kept there for a
        set time and then removed by the queue; the finished job's status is saved with the design.
      </p>
      </>)}

      <h2>Who can see it</h2>
      {signInEnabled ? (
        <p>
          Only you, when you are logged in. Every design, job and file belongs to the account that uploaded it; the
          server and the database both refuse anyone else, and someone else's design looks to them as if it does not
          exist. Files are never given a public address: a download link works for a short time and then stops. There
          is no sharing feature. People who run Stitchbook can see the stored data through Supabase's own tools.
        </p>
      ) : (
      <p>
        There are no accounts yet. Each design has its own address with a random id, and anyone who has that address
        can open the design, change it and download its file. There is no sharing feature and no list of everyone's
        designs.
      </p>
      )}

      <h2>How long it is kept</h2>
      <p>
        Planned retention: <SiteValue state={state} value={(s) => s.data_retention_days}
                                     render={(d) => `${d} ${Number(d) === 1 ? "day" : "days"}`} />.
        Automatic deletion is not built yet: until it is, designs stay on the server until they are removed by hand.
        There is no button to delete a design in the app yet.
        {signInEnabled && " There is no button to delete your account either; ask at the contact address above."}
      </p>

      <h2>Cookies, analytics and other services</h2>
      <ul>
        <li>Cookies: none. The web app does not set any, and the server does not send any.</li>
        <li>
          {signInEnabled
            ? "Browser storage: while you are logged in, your browser's local storage keeps your sign-in session (set by Supabase Auth), so you stay logged in. Logging out removes it. During a Google sign-in, a one-time check value is kept there too, and this tab's session storage remembers the page to return to; both are removed when you come back. Nothing else."
            : "Browser storage (local storage, session storage): none."}
        </li>
        <li>Analytics, advertising or tracking: none.</li>
        <li>Requests to other services: {signInEnabled
          ? `the web app talks to the Stitchbook server, to Supabase Auth (signing up, logging in and out), to Google when you sign in with Google${GOOGLE_CLIENT_ID ? " (and, on the Log in and Sign up pages, to load Google's sign-in script)" : ""}, and to Supabase file storage when you download a file; its fonts and icons come from the site itself.`
          : "the web app only talks to the Stitchbook server, and its fonts and icons come from the site itself."}{" "}
          {state.site
            ? video
              ? "The landing page plays a demo video from an address set by the owner, so your browser fetches that video from there."
              : "No demo video address is set, so the landing page does not fetch one."
            : "If the owner sets a demo video address, the landing page fetches that video from there."}
        </li>
      </ul>

      <h2>Server logs</h2>
      <p>
        The server program, as it is run today (uvicorn), prints a line for each request it answers: the IP address the request came from, the
        address asked for and the result. Whether and for how long that output is kept depends on how the server is
        run, which is not decided yet.
      </p>

      <h2>What Stitchbook does not have yet</h2>
      {signInEnabled
        ? <p>No payments and no sharing. The only email is the one that confirms your address. This page will change when any of them are added.</p>
        : <p>No accounts, no payments, no sharing and no email. This page will change when any of them are added.</p>}

      <p className="doc__more">See also the <Link to="/terms">Terms of Service</Link> and <Link to="/contact">Contact</Link>.</p>
    </SitePage>
  );
}
