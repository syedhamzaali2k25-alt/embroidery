# Billing: credits, plans and payments (Step 13)

Preview is always free. Exporting a machine file costs credits.

1. The credits are **reserved** when the export starts.
2. They are **used** only if it succeeds.
3. They are **released** (returned) if it fails, is cancelled, or never reports back (the stale sweep).

Plans grant the credits. Payments go through a provider adapter: **Whop** (`docs/payments-whop.md`), switched on with `billing.provider = "whop"` once its keys and plan ids are set. Until then the site says "Payments are not available yet".

## Where things are

| What | Where |
|---|---|
| Every price, credit amount, cost and switch | `digitizer/src/digitizer/config.py`, section `billing` (comments on each value) |
| Plan math (yearly price, per-month equivalent) | `api/src/stitchbook_api/plans.py` |
| Credits: reserve / consume / release, grants, sweep | `api/src/stitchbook_api/billing.py`, the only code that uses `SUPABASE_SECRET_KEY` |
| Payment provider interface, FakeProvider, WhopProvider | `api/src/stitchbook_api/payments.py`; setup and event mapping in `docs/payments-whop.md` |
| One provider subscription per account | `supabase/migrations/20261001000006_whop_subscription_owner.sql` |
| Tables, RLS, functions | `supabase/migrations/20261001000005_billing.sql`; teams and usage reads in `20261001000007_usage_and_teams.sql` |
| Export history, Credit usage (read as the user) | `api/src/stitchbook_api/account.py`, `web/src/pages/Exports.tsx`, Credit usage in `web/src/pages/Billing.tsx` |
| Teams | `Billing.team_*` in `api/src/stitchbook_api/billing.py`, routes `/team*` in `main.py`, `web/src/pages/Team.tsx`, `web/src/pages/TeamJoin.tsx` |
| Pricing page, plan cards, header balance, /billing | `web/src/pages/Pricing.tsx`, `web/src/lib/PlanCards.tsx`, `web/src/lib/credits.ts`, `web/src/pages/Billing.tsx` |

## Values the owner gave (in config.py)

| Value | Setting | Notes |
|---|---|---|
| Free | price 0, 30 credits, given once ("lifetime") | **OWNER TO CONFIRM.** 30 = 3 exports at 10 credits each. |
| Features | Free: Saved designs. Pro: + Export history, Credit usage. Business: + Multiple accounts | `plans.*.features`: each has a `key` the API checks and a `name` the cards show; `"status": "coming_soon"` shows a tag and unlocks nothing. |
| Pro | 12 USD a month, 5,000 credits a month | |
| Business | 25 USD a month, 10,000 credits a month | Teams: 4 seats including the owner (`team.included_seats`). |
| Extra seat | 10.00 USD a month, adds 1 seat and 1,000 credits a month to the owner's plan bucket | `team.extra_seat_price`, `team.extra_seat_credits`. The Whop add-on id `team.extra_seat_whop_plan_id` is `__CHOOSE__`. |
| Yearly discount | 10% | Yearly price = monthly × 12 × 0.9, computed in code: Pro 129.60, Business 270.00. Yearly plans get the same monthly allowance. |
| Export cost | 10 credits | |
| Monthly rollover | off | **OWNER TO CONFIRM.** Unused plan credits expire at the end of the UTC month. |
| Currency | USD | Whether the provider supports it is an owner decision. |

## OWNER TO CONFIRM / not chosen yet

These are all `__CHOOSE__` or flagged in config.py. Until chosen, the UI shows a visible placeholder or hides the item; it never shows an invented value.

- **Credit costs:**
  - `credit_costs.satin_columns`: unset, so satin columns are free and nothing is reserved;
  - `credit_costs.auto_digitize`: unset (the operation does not exist yet).
- **The Free plan's 30 credits:** exports? Lifetime or monthly?
- **History page size:** `history_page_size` (rows per page of Export history and Credit usage). Unset = those pages answer "not configured".
- **Teams:** `team.invite_ttl_s` (how long an invite link works) and `team.extra_seat_whop_plan_id`; see "Teams" below for the open decisions.
- **Rollover:** `monthly_rollover`.
- **Credit packs:** `credit_packs`, a list of `{"credits": n, "price": p}`. Hidden while unset. Bought credits never expire and are spent after the monthly allowance.
- **Reservation timeout:** `reservation_timeout_s`, and `sweep_interval_s`. While unset, the stale sweep does not run.
- **Refund policy:** `refund_policy`. The pricing page shows "[Refund policy]".
- **Currency and tax:** handling, VAT/sales tax, invoices.
- **Provider:** `provider` (`"whop"`; see `docs/payments-whop.md` for its own list). `"fake"` is for local development only and is refused in production.
- **Refunds:** a provider refund is only logged; credits are never removed automatically. A manual adjustment tool is not built.
- **Re-downloads:** each export is charged, including downloading the same design again.

## How credits are counted (migration 5)

- **`credit_ledger`:** append-only grants, with a `ref` so each grant is given once.
  - Bucket `plan`: the free grant (never expires) and the monthly plan grants (expire at the end of their UTC month unless rollover is on).
  - Bucket `purchased`: never expires.
- **`credit_reservations` + `credit_allocations`:** each operation's reservation, and which grants it draws from.
  - Plan credits are used first, soonest-expiring first; then purchased credits.
  - Status goes `reserved` → `consumed` (success) or `released` (failure, cancel, stale).
  - A consumed credit is never released.
- **`operation_log`:** one row for every operation: user, design, time, settings, format, credits and final status.
- **`credit_balance(owner)`:** available / reserved / consumed per bucket.
- **Locking:** every change locks the owner's `profiles` row (`FOR UPDATE`), so two operations of one user never spend the same credits.
- **Idempotency:** every function is idempotent by job id or ref.
- **Grants:** the Free grant (ref `free_grant`) is given on the first `/me/credits` or first metered operation. This month's plan grant (ref `plan:{subscription}:{YYYY-MM-01}`) is given by the webhook, or lazily by the API, once per subscription and month.

## API

| Route | What it does |
|---|---|
| `GET /plans` (public) | Plans, computed prices, credit costs, and whether payments are available. Also inside `GET /config` as `billing`. |
| `GET /me/credits` (token) | Plan, interval, status, balances, operation history. `{"enabled": false}` when the server has no billing. |
| `GET /designs/{id}/download`, `/download-url` | Metered exports: reserve first (402 `{error, available, needed, plan}` if short, nothing runs), consume on success, release on failure. |
| `POST /designs/{id}/trace` | Satin columns. Reserves BEFORE enqueuing (once its cost is set); if enqueueing fails, released at once. Settled when the job ends: done → consumed; failed or cancelled → released. |
| `POST /billing/checkout` (token) `{plan, interval}` | The provider's checkout URL; 503 "Payments are not available yet." without a provider. |
| `POST /billing/cancel` (token) | Asks the provider to stop renewal (the plan stays until the paid period ends). |
| `GET /billing/manage` (token) | The provider's own page to manage the plan and payment details (`{"url": null}` when there is none). |
| `POST /webhooks/billing` | Provider events. The raw body's signature is checked BEFORE parsing. Each event is applied once (`processed_webhook_events`). The user id comes only from the provider's signed metadata. |

How each mode behaves:
- **Supabase mode:** billing needs `SUPABASE_SECRET_KEY`.
- **Local mode (no Supabase):** no billing. Metered operations run free only with `STITCHBOOK_FREE_OPERATIONS=1`; otherwise they are refused (503).
- **Production (`STITCHBOOK_ENV=production`):** the API refuses to start in local mode, without the secret key, with free operations, or with test-run values (fail closed).

## Adding another payment provider

Whop is built this way (`WhopProvider`); follow it for another one.

1. Choose the provider (you need a merchant account; see the lists at the end).
2. Write an adapter class in `api/src/stitchbook_api/payments.py` with the `Provider` methods:
   - **`create_checkout(user_id, email, plan, interval) -> url`:** put `user_id` in the provider's metadata (signed by the provider), map plan/interval to the provider's price ids (store those ids in config.py, not in code), and return the hosted checkout URL.
   - **`verify_webhook(headers, raw_body) -> Event`:** verify the signature with `PAYMENT_WEBHOOK_SECRET` over the **raw** body, before parsing. Raise `BadSignature` otherwise. Map the provider's event to `Event(id, type, owner_id, plan, interval, status, period_end, customer_id, subscription_id)`.
   - **`cancel_subscription(subscription_id)`.**
3. Register it in `provider_from()` and set `billing.provider` in config.py to its name.
4. Put its secret key and webhook secret in `.env` under its own names (as `WHOP_API_KEY` / `WHOP_WEBHOOK_SECRET`), list them empty in `.env.example`, and add the names to `web/scripts/check-bundle-secrets.mjs`.
5. Register the webhook URL with the provider: `https://<your API host>/webhooks/billing`. It must be public HTTPS, so it needs a deployed API.
6. Test in the provider's test mode first. `api/tests/test_billing_api.py` shows the checks to repeat: bad signature, replay, one grant per period.

A local gateway can be added the same way. The FakeProvider (HMAC-SHA256 over the raw body, header `X-Fake-Signature`, secret `STITCHBOOK_FAKE_PROVIDER_SECRET`) is the model.

## Threat notes

- **Users cannot give themselves credits.**
  - The billing tables are read-only for them (RLS select-own-rows; no insert, update or delete grants).
  - Every function is `security definer`, `search_path ''`, and executable by `service_role` only.
  - The ledger is append-only even for the service role.
- **The secret key stays on the server.** Only `billing.py` uses it, and the web bundle is checked for it.
- **No double spending.** One owner's operations are serialised by a row lock. Tested: 2 at once with credits for 1; 20 at once with credits for 12.
- **Webhooks:**
  - Forged webhooks fail signature verification before any parsing.
  - Replays are ignored (unique provider + event id).
  - Out-of-order events: the last applied event wins. Providers usually send the current state; check this when choosing one.
- **Lost jobs:** reservations are released by the stale sweep (once `reservation_timeout_s` is chosen).
  - A job that succeeded but was never observed before the sweep ends up free; consume after release is refused.
  - A satin-columns job that finishes while nobody polls is settled when the editor next asks for it, or released by the sweep.
- **Deleting a design** keeps its spent credits spent; the log rows stay, with no design.
- **Deleting an account** removes its billing rows (cascade), but not the provider's subscription: cancel it first.

## Export history and Credit usage (Step 13d)

Pro and Business (the `export_history` and `credit_usage` feature keys). Free gets 403 `{"error": "plan_required", "plan": "pro"}` and the web shows a calm note with a link to Pricing; Free keeps its header balance, its designs and the operation History on /billing.

- `GET /exports?page=n`: the user's finished exports, newest first (design name, format, size, credits, date). Downloading again goes through the normal metered download, which signs a fresh short-lived link (`storage.signed_url_ttl_s`); it is a new export and costs credits, because the stored file is rewritten by every (free) preview.
- `GET /credits/usage?page=n`: balance by bucket, renewal date, this month's spend, and the entries (grants +, spends −), newest first.
- Both are read AS THE USER: the API calls migration 7's `my_*` functions with the user's own token and the publishable key, so row level security decides. No secret key. (`my_credit_balance()` is a definer wrapper that only ever reads the caller's own balance.)

## Teams (Step 13b)

Only Business has a team (the `teams` feature key, "Multiple accounts"). Members export with the TEAM OWNER's credits; designs stay private to whoever made them (no sharing).

- **Seats:** owner + members ≤ `team.included_seats` + active extra seats. Checked in SQL under the owner's row lock (`team_create_invite`, `team_accept_invite`), so concurrent accepts cannot overshoot (tested with 10 at once).
- **Invites:** `POST /team/invites {email}` returns a link `/team/join#token=...` to copy; there is no email service. Only the token's SHA-256 is stored. A link works once, until `team.invite_ttl_s`, for the invited email only (the signed-in email must match). One person, one team. Someone with an active paid plan of their own must cancel it before joining.
- **Who pays:** `billing_credit_owner(user)` = the team owner while the user is a member of an active Business team, else the user. `reserve_credit` / `consume_credit` / `release_credit` lock and spend that pool. A reservation keeps who spent (`owner_id`, whose design it is) and who paid (`credit_owner_id`, new); the owner's Credit usage shows which member spent. Grants record `acting_user_id` (new, nullable) where there is one (an extra seat). Spends are not ledger rows (the ledger only holds grants; balances subtract reservations), so "who spent" lives on the reservation.
- **Members see** "Credits are provided by your team" (on /billing, /team and instead of plan cards), the pool's available credits and their own history. They cannot read the owner's billing, invites, seats or other members (403 `team_member`; RLS shows them only their own member row).
- **Removing a member** (`DELETE /team/members/{id}`; never the owner) stops pool access at once: the next reservation finds no membership. Something already running settles normally.
- **Plan end:** when the owner's Business ends (deactivated, or switched to another plan), the webhook runs `team_end`: members leave the team, open invites stop working, designs stay with their makers. They fall back to Free rules with no new free credits (nobody who has ever joined a team gets the Free grant). "Cancelled but paid until later" keeps the team until then.
- **Extra seats:** `POST /team/seats` opens the provider's checkout (FakeProvider now; Whop once `team.extra_seat_whop_plan_id` is set, otherwise "Extra seats are not available yet."). A seat event grants `team.extra_seat_credits` into the owner's plan bucket once per seat and UTC month (ref `seat:{subscription}:{YYYY-MM-01}`, no rollover; replays add nothing); the monthly top-up gives later months while the seat and Business are active. A cancelled seat stops the next grant and frees no member.

### OWNER TO DECIDE (teams)

- **Whop add-on seat billing:** create the add-on plan in Whop and paste its id into `team.extra_seat_whop_plan_id`; whether a seat renews with the Business plan's date or its own; what happens to seats when Business is cancelled (today: seats stay recorded but give no credits and no access while Business is inactive).
- **Members at downgrade:** today the team ends and members go back to Free rules without new free credits. Alternatives: a grace period, or keeping the team inactive for a later re-subscribe.
- **Seats below the member count** (an extra seat cancelled while full): today nobody is removed; no one new can join until there is room.
- **Email invites later:** an email service (Supabase Auth invite, or a mail provider) instead of copying the link.
- **Per-member credit limits:** not built; any member can spend the whole pool.
