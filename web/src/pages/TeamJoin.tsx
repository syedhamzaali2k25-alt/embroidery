import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError } from "../lib/api";
import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { refreshCredits } from "../lib/credits";
import { SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/pricing.css";

// /team/join#token=...: accept a team invite. The token is in the URL fragment (never sent to a
// server, so never in a log) and kept in this tab's sessionStorage across logging in.

const KEY = "stitchbook.invite";

function readToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  try {
    if (fromHash) {
      sessionStorage.setItem(KEY, fromHash);
      history.replaceState(null, "", location.pathname);  // the token leaves the address bar
      return fromHash;
    }
    return sessionStorage.getItem(KEY);
  } catch {
    return fromHash;
  }
}

export default function TeamJoin() {
  usePage("Join a team · Stitchbook", "team-join-page");
  const { ready, session } = useSession();
  const [token] = useState(readToken);
  const [state, setState] = useState<"idle" | "busy" | "joined" | { error: string }>("idle");
  useEffect(() => {
    if (signInEnabled && ready && !session && token) location.assign(loginPath("/team/join"));
  }, [ready, session, token]);
  const join = () => {
    if (!token) return;
    setState("busy");
    api.acceptInvite(token).then(() => {
      try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ }
      setState("joined");
      void refreshCredits();
    }, (err) => setState({ error: err instanceof ApiError ? err.message : "The invite could not be accepted. Try again." }));
  };

  let body;
  if (!signInEnabled) body = <p>Sign-in is not set up on this server, so there are no teams here.</p>;
  else if (!token) body = <p className="billing__notice">This page needs an invite link. Ask the team owner to send you one.</p>;
  else if (state === "joined") {
    body = (
      <div className="billing__notice member-note" role="status">
        <p>You joined the team. Credits are provided by your team, and your designs stay private to you.</p>
        <Link className="btn btn--ink" to="/home">My designs</Link>
      </div>
    );
  } else {
    body = (
      <div className="billing__notice">
        <p>You have been invited to join a team on Stitchbook. As a member you export with the team's credits; your designs stay private to you.</p>
        <button className="btn btn--ink" type="button" onClick={join} disabled={state === "busy" || !session}>
          {state === "busy" ? "Joining…" : "Join the team"}
        </button>
        {typeof state === "object" && <p className="billing__error" role="alert">{state.error}</p>}
      </div>
    );
  }
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="billing">
          <h1>Join a <span className="accent">team</span></h1>
          {body}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
