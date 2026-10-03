import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api, ApiError, planRequired, type Team as TeamData } from "../lib/api";
import { loginPath, signInEnabled, useSession } from "../lib/auth";
import { count, extraSeatLine, refreshCredits, usePlans } from "../lib/credits";
import { TextField } from "../lib/Field";
import { TeamMemberNote } from "../lib/PlanCards";
import { DAY, UpgradeNote } from "../lib/UsageParts";
import { SiteFooter, SiteHeader } from "../lib/SiteChrome";
import { usePage } from "../lib/usePage";
import "../css/pricing.css";

// /team: a Business owner's team (members, invites, seats, extra seats). Members see that their
// credits come from the team; Free and Pro see a calm note that teams come with Business.
// There is no email service: an invite is a link to copy and send yourself.

type State = { team: TeamData } | { upgrade: string } | { error: string } | null;
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export default function Team() {
  usePage("Team · Stitchbook", "team-page");
  const { ready, session } = useSession();
  const { plans } = usePlans();
  const [state, setState] = useState<State>(null);
  const load = useCallback(() => {
    api.team().then((team) => setState({ team }), (err) => {
      const plan = planRequired(err);
      setState(plan !== null ? { upgrade: plan } : { error: message(err, "Your team could not be loaded. Try again.") });
    });
  }, []);
  useEffect(() => {
    if (!signInEnabled || !ready) return;
    if (!session) location.assign(loginPath("/team"));
    else load();
  }, [ready, session, load]);

  let body;
  if (!signInEnabled) body = <p>Sign-in is not set up on this server, so there are no teams here.</p>;
  else if (!state) body = <p role="status">Loading your team…</p>;
  else if ("upgrade" in state) body = <UpgradeNote what="A team" plan={state.upgrade} plans={plans} />;
  else if ("error" in state) body = <p className="billing__error" role="alert">{state.error}</p>;
  else if (!state.team.enabled) body = <p>Teams are not used on this server.</p>;
  else if (state.team.role === "member") body = <TeamMemberNote />;
  else body = <OwnerView team={state.team} reload={load} />;
  return (
    <>
      <div className="sheet">
        <SiteHeader />
        <main className="billing">
          <h1>Your <span className="accent">team</span></h1>
          {body}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}

function OwnerView({ team, reload }: { team: Extract<TeamData, { role: "owner" }>; reload: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const full = team.seats.used >= team.seats.total;
  const seatLine = extraSeatLine(team.extra_seat);

  const invite = (e: FormEvent) => {
    e.preventDefault();
    setBusy("invite"); setError(null); setLink(null); setCopied(false);
    api.invite(email.trim()).then((made) => {
      setBusy(null); setEmail("");
      setLink({ email: made.invite.email, url: `${location.origin}${made.path}` });
      reload();
    }, (err) => { setBusy(null); setError(message(err, "The invite could not be made. Try again.")); });
  };
  const act = (key: string, run: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    run().then(() => { setBusy(null); setConfirm(null); reload(); void refreshCredits(); },
      (err) => { setBusy(null); setError(message(err, "That did not work. Try again.")); });
  };
  const buySeat = () => {
    setBusy("seat"); setError(null);
    api.buySeat().then(({ url }) => window.location.assign(url),
      (err) => { setBusy(null); setError(message(err, "The payment page could not be opened. Try again.")); });
  };
  const copy = () => {
    if (!link) return;
    void navigator.clipboard?.writeText(link.url).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <>
      <div className="billing__cards">
        <div className="billing__card">
          <span className="billing__label">Seats used</span>
          <span className="billing__value">{count(team.seats.used)} of {count(team.seats.total)}</span>
          <span className="billing__sub">You hold one seat. Extra seats: {count(team.seats.extra)}</span>
        </div>
      </div>

      <section className="usage" aria-labelledby="members-title">
        <h2 id="members-title" className="billing__history-title">Members</h2>
        {team.members.length === 0 ? <p className="billing__notice">No members yet. Invite someone below.</p> : (
          <ul className="team__list">
            {team.members.map((m) => (
              <li key={m.user_id} className="team__row">
                <span className="team__who">{m.email ?? "Member"}<span className="team__since">Joined {DAY.format(new Date(m.joined_at))}</span></span>
                {confirm === m.user_id ? (
                  <span className="billing__buttons" role="group" aria-label={`Remove ${m.email ?? "member"}`}>
                    <button className="btn btn--ink" type="button" disabled={busy !== null}
                            onClick={() => act(m.user_id, () => api.removeMember(m.user_id))}>
                      {busy === m.user_id ? "Removing…" : "Yes, remove"}
                    </button>
                    <button className="btn btn--ghost" type="button" onClick={() => setConfirm(null)}>Keep</button>
                  </span>
                ) : <button className="btn btn--ghost" type="button" onClick={() => setConfirm(m.user_id)}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="usage" aria-labelledby="invite-title">
        <h2 id="invite-title" className="billing__history-title">Invite someone</h2>
        <p className="billing__sub">They join with the email you enter, spend the team's credits, and keep their own designs private.</p>
        <form className="team__invite" onSubmit={invite} noValidate>
          <TextField label="Email address" type="email" autoComplete="off" inputMode="email" autoCapitalize="none" spellCheck={false}
                     placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={full} />
          <button className="btn btn--ink" type="submit" disabled={busy !== null || full || !email.trim()}>
            {busy === "invite" ? "Making the link…" : "Make invite link"}
          </button>
        </form>
        {full && <p className="billing__notice">All seats are taken. Remove a member or add an extra seat to invite someone.</p>}
        {link && (
          <div className="billing__notice team__link" role="status">
            <p>Send this link to {link.email}. It works once, for that email address.</p>
            <code className="team__url">{link.url}</code>
            <button className="btn btn--ghost" type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          </div>
        )}
        {team.invites.length > 0 && (
          <ul className="team__list" aria-label="Open invites">
            {team.invites.map((i) => (
              <li key={i.id} className="team__row">
                <span className="team__who">{i.email}<span className="team__since">Open until {DAY.format(new Date(i.expires_at))}</span></span>
                <button className="btn btn--ghost" type="button" disabled={busy !== null}
                        onClick={() => act(i.id, () => api.revokeInvite(i.id))}>
                  {busy === i.id ? "Cancelling…" : "Cancel invite"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="usage" aria-labelledby="seats-title">
        <h2 id="seats-title" className="billing__history-title">Extra seats</h2>
        {seatLine && <p className="team__seat-offer">{seatLine}</p>}
        {team.extra_seat.available
          ? <p><button className="btn btn--ink" type="button" onClick={buySeat} disabled={busy !== null}>{busy === "seat" ? "Opening checkout…" : "Add an extra seat"}</button></p>
          : <p className="billing__notice">Extra seats are not available yet.</p>}
      </section>
      {error && <p className="billing__error" role="alert">{error}</p>}
    </>
  );
}
