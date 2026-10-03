// The signed-in user's credits (GET /me/credits), shared by the header, the export buttons and
// the Billing page. Fetched once, refreshed after any metered operation (refreshCredits).
// Plans and prices (GET /plans) are fetched once too. Nothing here holds a price or a credit
// amount: every number comes from the server, which reads config.py.
import { useEffect, useState } from "react";

import { api, type Account, type Plans } from "./api";
import { signInEnabled, useSession } from "./auth";

type Listener = (a: Account | null) => void;
let current: Account | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(a: Account | null) {
  current = a;
  listeners.forEach((l) => l(a));
}

/** Asks the server again (after an export, a purchase, logging in or out). */
export function refreshCredits(): Promise<void> {
  if (!signInEnabled) return Promise.resolve();
  loading = api.credits().then(publish, () => publish(null)).finally(() => { loading = null; });
  return loading;
}

/** The account, or null while unknown / signed out / unavailable (then nothing is shown). */
export function useCredits(): Account | null {
  const { ready, session } = useSession();
  const [account, setAccount] = useState<Account | null>(current);
  useEffect(() => {
    listeners.add(setAccount);
    setAccount(current); // an answer that arrived between the first render and now is not missed
    return () => { listeners.delete(setAccount); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (!session) { publish(null); return; }
    if (!current && !loading) void refreshCredits();
  }, [ready, session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return account;
}

/** What an operation costs, from the account (or 0 when it is free / unknown). */
export const costOf = (account: Account | null, operation: string) =>
  account && account.enabled ? account.costs[operation] ?? 0 : 0;

/** True when the user is known to lack the credits for an operation (the button is disabled). */
export const cannotAfford = (account: Account | null, operation: string) =>
  !!account && account.enabled && costOf(account, operation) > 0 && account.available < costOf(account, operation);

let plansRequest: Promise<Plans> | null = null;
/** GET /plans once per page load. */
export function loadPlans(): Promise<Plans> {
  plansRequest ??= api.plans().catch((err) => { plansRequest = null; throw err; });
  return plansRequest;
}

export function usePlans(): { plans: Plans | null; failed: boolean } {
  const [state, setState] = useState<{ plans: Plans | null; failed: boolean }>({ plans: null, failed: false });
  useEffect(() => {
    let live = true;
    loadPlans().then((plans) => live && setState({ plans, failed: false }), () => live && setState({ plans: null, failed: true }));
    return () => { live = false; };
  }, []);
  return state;
}

/** A price from config, formatted in the configured currency; null when not chosen. */
export function money(value: string | null, currency: string | null): string | null {
  if (value === null || !currency) return null;
  return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 2 }).format(Number(value));
}

export const count = (n: number) => n.toLocaleString("en");

/** A price without ".00" when it is whole (the extra-seat line: "$10/month"). */
export function moneyShort(value: string | null, currency: string | null): string | null {
  if (value === null || !currency) return null;
  const n = Number(value);
  return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
}

/** "Extra seat: $10/month, adds 1 seat and 1,000 credits to the shared pool": every number from
 * config (GET /plans team); null while any of them is not chosen. */
export function extraSeatLine(team: { extra_seat_price: string | null; extra_seat_credits: number | null; currency: string | null }): string | null {
  const price = moneyShort(team.extra_seat_price, team.currency);
  if (!price || team.extra_seat_credits === null) return null;
  return `Extra seat: ${price}/month, adds 1 seat and ${count(team.extra_seat_credits)} credits to the shared pool`;
}
