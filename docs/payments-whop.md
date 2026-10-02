# Payments with Whop (Step 13c)

## The answer first: can our user id travel through checkout and come back in the webhook?

**YES**, according to Whop's official Python SDK. A checkout configuration takes `metadata`, documented as *"Custom key-value metadata copied to payments and memberships."* Memberships and payments both carry that `metadata` back in the webhook body.

- **How Stitchbook uses it**
  - The API creates the checkout server-side for the signed-in user. The user id comes only from the verified Supabase token, never from the request body.
  - It goes into the checkout as `metadata.stitchbook_user_id`.
  - When a webhook arrives, the API verifies the signature first. Only then does it read the user id from the signed `data.metadata`.
  - That id is the only link between a payment and a user. Nobody is ever matched by email.
- **Renewal payments with no metadata in their body** are applied to the account the membership was first bound to, by an earlier signed event.
  - An event naming a different user than the one its membership is bound to is refused, and grants nothing.
  - Migration 6 enforces the same rule in the database.

**Not verified here:** whether real Whop deliveries carry this metadata. docs.whop.com was not reachable from the build environment (see Sources). Check it once in step 3 (the test payment):

1. In Whop's webhook delivery log, open the `payment.succeeded` delivery.
2. Look for `"metadata": {"stitchbook_user_id": "..."}` inside `data`.
3. If it is missing, stop and tell me. Do not go live.

## Sources used

**docs.whop.com could not be opened from the environment this was built in.** Both `https://docs.whop.com/llms.txt` and the pages it lists were blocked by the environment's network policy (403). So nothing here was taken from the doc pages.

Instead, everything was read from Whop's **official SDK packages on PyPI**, published by Whop (repository `github.com/whopio/whopsdk-python`):

| Source | What it settled |
|---|---|
| `whop-sdk 2.0.0` `whop_sdk/checkout_configurations/raw_client.py` (`create`) | `POST /checkout_configurations` with `plan_id`, `metadata` ("copied to payments and memberships"), `redirect_url` |
| `whop-sdk 2.0.0` `whop_sdk/types/checkout_configuration.py` | the response's `purchase_url` ("Checkout URL you can send to customers") |
| `whop-sdk 2.0.0` `whop_sdk/environment.py` | Production API `https://api.whop.com/api/v1`, **sandbox** API `https://sandbox-api.whop.com/api/v1` |
| `whop-sdk 2.0.0` `whop_sdk/core/client_wrapper.py` | `Authorization: Bearer <API key>` |
| `whop-sdk 2.0.0` `whop_sdk/memberships/raw_client.py` (`cancel`, `retrieve`) | `POST /memberships/{id}/cancel` with `cancel_at_period_end: true` (keeps access until the period ends) |
| `whop-sdk 2.0.0` `whop_sdk/types/membership_legacy.py` | `manage_url`: "where the customer can view and manage this membership, including cancellation and plan changes" |
| `whop-sdk 2.0.0` `whop_sdk/types/plan.py` (`plans.retrieve`) | `initial_price`, `renewal_price`, `currency`, `billing_period` (days), `plan_type`, `trial_period_days` |
| `whop-sdk 2.0.0` `whop_sdk/types/webhook_events_item.py` | Event names: `membership.activated`, `membership.deactivated`, `membership.cancel_at_period_end_changed`, `payment.succeeded`, `payment.failed`, `refund.created`, … |
| `whop-sdk 2.0.0` `whop_sdk/lib/verify_webhook.py` | Standard Webhooks. Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`. The secret (`ws_...`) is used as its **literal bytes**, not base64-decoded. |
| `standardwebhooks 1.1.0` (the library that SDK uses) | HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`, `v1,<base64>`, tolerance **5 minutes** |
| `whop-sdk 0.0.41` `types/*_webhook_event.py`, `types/shared/membership.py`, `types/shared/payment.py` | The webhook body shape `{id, api_version, type, timestamp, company_id, data}`, and the fields of `data`: `metadata`, `plan.id`, `membership.id`, `renewal_period_end`, `cancel_at_period_end`, `paid_at`, … |

The adapter's signature was checked against the `standardwebhooks` library: same bytes, and it verifies. The test payloads in `api/tests/test_whop.py` are built from the 0.0.41 shapes. The adapter also reads the newer field names (`plan_id`, `membership_id`, `current_period_end`) in case Whop sends those.

To re-check all of this against the doc pages, allow `docs.whop.com` in the environment's network settings and ask me to compare.

## What was built

| Piece | Where |
|---|---|
| `WhopProvider` | `api/src/stitchbook_api/payments.py`. It does create_checkout, verify_webhook, cancel_subscription and manage_url. |
| Owner binding, old-membership guard | `Billing.apply_event` in `api/src/stitchbook_api/billing.py` |
| Settings | `digitizer/src/digitizer/config.py` `billing.*`: `provider`, `whop_environment`, `plans.*.whop_plan_ids.*`, `webhook_tolerance_s`, `provider_http_timeout_s`, `checkout_return_*` |
| Secrets | `.env`: `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET` (server only). `STITCHBOOK_SITE_URL` is the return address. |
| Price check (read only) | `make check-whop-plans` (`api/src/stitchbook_api/whop_plans.py`) |
| Database | `supabase/migrations/20261001000006_whop_subscription_owner.sql`: one membership belongs to one account |
| Tests | `api/tests/test_whop.py` (no network). `api/tests/test_whop_live.py` is optional, read only, and skips without keys. |
| Web | `/billing`: Manage billing, Cancel plan, return from checkout, past due. Upgrade opens the checkout URL the API returns. |

**Nothing from Whop reaches the browser.** No Whop key, id or script is in the web bundle. The browser is only sent to the `purchase_url` the API returns, so no public Whop id is needed in `vite.config.ts`. `npm run check:secrets` fails the build if either key name, either key value, or a `ws_...` secret appears in it.

**No company id is needed.** A checkout made from an existing `plan_id` belongs to that plan's company. The SDK's `account_id` field is optional.

### Events

The webhook URL path is **`/webhooks/billing`**.

| Whop event | Stitchbook does |
|---|---|
| `membership.activated` | Plan active (Pro/Business, month/year from the plan id), period end from the membership |
| `membership.cancel_at_period_end_changed` | `true`: renewal stopped, the plan stays until the period end. `false`: active again. |
| `membership.deactivated` | Back to Free for new grants at once. Credits already given are kept. |
| `payment.succeeded` | Active, plus this month's credits (Pro 5,000, Business 10,000; the same monthly amount for yearly plans) |
| `payment.failed` | `past_due`: /billing says so, and no new monthly credits are given |
| `refund.*`, everything else | 200 and a log line. **Refunds never remove credits automatically.** See "Refunds" below. |

Rules that apply to every event:

- **Signature and time window.** A bad or missing signature, or a timestamp more than 5 minutes from the server's clock, gets 400 and changes nothing.
- **One application per webhook.** Each webhook id is applied once, so a replay does nothing.
- **Whose plans count.** A plan id that is not one of the four in config.py is ignored (200).
- **Ref for the credit grant:** `plan:{membership_id}:{YYYY-MM-01}`, where the date is the first of the UTC month in which the payment was made.
  - This replaces the request's `{period_start}` with the start of the month.
  - Credits are a monthly allowance that expires at the end of the UTC month (Step 13). The API also tops up a yearly plan every month under this same ref.
  - Using Whop's own period start (for example 17 October for a yearly plan) would grant a second 5,000 in the same month. The month start makes the webhook grant and the API's monthly top-up the same grant.
- **An event for an older membership** cannot end the user's current plan. For example, a `deactivated` for the Pro membership after the user bought Business is ignored.

## What you must do, in order

### 1. Whop seller account, product and the four plans

1. Create the Whop seller account (company) at whop.com, and fill in what Whop asks for.
2. Create **one product** for Stitchbook. Use the **sandbox** first: see step 3 for where the sandbox dashboard is (OWNER TO CONFIRM).
3. In that product, create **four renewing plans**, in USD:

| Plan | Billing | Recurring price | First charge | Trial |
|---|---|---|---|---|
| Pro monthly | every month | 12.00 | the same (or none) | **none** |
| Pro yearly | every year | 129.60 | the same (or none) | **none** |
| Business monthly | every month | 25.00 | the same (or none) | **none** |
| Business yearly | every year | 270.00 | the same (or none) | **none** |

   - The prices are computed from config.py. If you change config.py, change Whop too. Code never creates or changes a Whop price.
   - **No trials.** A trialing membership would get credits without a payment.
4. Copy each plan's id (`plan_...`) into `digitizer/src/digitizer/config.py`:

```python
"plans.pro.whop_plan_ids.month": "plan_...",
"plans.pro.whop_plan_ids.year": "plan_...",
"plans.business.whop_plan_ids.month": "plan_...",
"plans.business.whop_plan_ids.year": "plan_...",
```

5. In the same file, choose the remaining values:
   - `"whop_environment": "sandbox"` (later `"production"`, with the production plan ids);
   - `"provider_http_timeout_s"`;
   - `"checkout_return_poll_s"` and `"checkout_return_wait_s"`;
   - `"provider": "whop"`.
6. Run `make check-whop-plans`. It only reads from Whop. It prints `ok` or `MISMATCH` for each plan and lists what to fix.

### 2. API key, webhook secret, webhook URL, a tunnel for local testing

1. In the Whop dashboard (sandbox), create a **company API key**. It needs these permissions:
   - create checkout configurations;
   - read and cancel memberships;
   - read plans.
2. Create a **webhook**:
   - URL: `https://<public API address>/webhooks/billing`
   - Events: `membership.activated`, `membership.deactivated`, `membership.cancel_at_period_end_changed`, `payment.succeeded`, `payment.failed`. Optionally add `refund.created` and `refund.updated`, which are only logged.
   - Copy its **signing secret** (`ws_...`).
3. Put the keys in `.env` (never commit it):

```
WHOP_API_KEY=...
WHOP_WEBHOOK_SECRET=ws_...
STITCHBOOK_SITE_URL=http://localhost:8080
```

   The API refuses to start with `provider: "whop"` unless both keys and every Whop value in config.py are set. It names what is missing.
4. Paste **migration 6** into the Supabase SQL Editor: `supabase/migrations/20261001000006_whop_subscription_owner.sql`, after migration 5. Expected result: "Success. No rows returned".
5. **Local testing needs a public HTTPS address.** Whop must reach the webhook, so open a tunnel to the API (port 8000):
   - **cloudflared:** `cloudflared tunnel --url http://localhost:8000`. It prints `https://<random>.trycloudflare.com`.
   - **ngrok:** `ngrok http 8000`. It prints `https://<random>.ngrok-free.app`.

   Set the webhook URL in Whop to `<that address>/webhooks/billing`. The address changes each time the tunnel restarts, so update it in Whop then.

### 3. A test payment

- **What is known:** the SDK has a **sandbox** API (`sandbox-api.whop.com`), and Stitchbook uses it while `whop_environment` is `"sandbox"`.
- **What is not known:** I could not read how sandbox payments are made (test cards, sandbox dashboard address). **OWNER TO CONFIRM** in Whop's docs.
  - If the sandbox takes test payments, use it.
  - If there is no usable test mode, a **small real payment** is needed. Temporarily create a cheap renewing plan, put its id in place of `plans.pro.whop_plan_ids.month` on your own machine only, pay once, then cancel and refund it in Whop. `make check-whop-plans` will rightly report the price mismatch while you do this.

Then check:

1. **Upgrade on /pricing.** You land on Whop's checkout, pay, and come back to `/billing?checkout=done`. It shows "Your payment went through. Your plan is now Pro."
2. **The webhook deliveries.** In Whop's webhook log you see `payment.succeeded` and `membership.activated`, with **200** and `{"result": "applied"}`. The body contains `"metadata": {"stitchbook_user_id": "<your user id>"}`.
3. **The credits.** /billing shows 5,000 plan credits plus what was there before.
4. **Manage billing.** It opens Whop's own page for the membership.
5. **Cancel plan.** /billing says renewal is stopped, and Whop shows the membership cancelling at period end.
6. **Optional live check:** `.venv/bin/pytest api/tests/test_whop_live.py -v -rs` (read only).

### 4. Payouts to Pakistan

The SDK has payout APIs (`payout_accounts`, `payout_methods`, `withdrawals`) but says nothing about which countries or methods are supported. **OWNER TO CONFIRM:**

- Whether Whop pays out to a seller in Pakistan, and by which method (bank transfer, a wallet, …).
- Any identity verification, tax forms and minimum payout.
- Payout fees and currency conversion (USD to PKR).

### 5. OWNER TO CONFIRM before launch

- **Tax and invoices:** Owner states that Whop handles tax and invoices. Verify this in Whop's own terms/docs before launch and paste the link here: ____
  - Until then the app shows "[Payments, tax and invoices: owner to confirm]" and "[Owner to confirm]". It never says who handles tax.
- **Whop fees:** the percentage and fixed fee per payment, and any payout fees.
- **Refund policy:** the text for `billing.refund_policy`, which the pricing page shows as "[Refund policy]".
- **Refunds and credits:** a Whop refund is only logged; no credits are removed. Decide what should happen. A manual credit adjustment tool is not built.
- **Chargebacks / disputes:** who handles them and what happens to the account. Not built: `dispute.*` events are only logged.
- **Allowed product category:** that a software subscription for embroidery digitizing is allowed on Whop.
- **Company name** shown on Whop's checkout and the buyer's statement.
- **Currency:** USD on all four plans (config.py `billing.currency`). Check that buyers can pay in it.
- **Upgrades between plans:** buying Business while Pro is active creates a **second membership**, and Stitchbook switches to the newest one. The old membership keeps billing until the buyer cancels it under Manage billing. Decide whether to tell buyers that, or to use a Whop upgrade flow if it has one (not built).

## Known limits

- Never run against Whop's servers from here: no checkout, webhook delivery or price read.
- Payment events do not carry the membership's period end, so a `payment.succeeded` keeps the period end from the latest membership event.
- If the webhook is down for longer than Whop retries, the API's monthly top-up still grants an active plan's credits. Status changes (cancel, past due) wait for the next delivered event.
