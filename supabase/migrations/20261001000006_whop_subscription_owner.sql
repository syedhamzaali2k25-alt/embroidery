-- Step 13c (Whop). Run AFTER 20261001000005_billing.sql, once, in the SQL Editor.
--
-- One payment-provider subscription (a Whop membership, mem_...) can belong to ONE account only.
-- The webhook handler already refuses an event whose user differs from the account the membership
-- is bound to; this unique index makes the database refuse it too, even if two such events arrive
-- at the same moment. It also makes the handler's lookup by membership id fast.
--
-- Safe on an existing project: it only fails if two accounts already share a subscription id,
-- which nothing in this repo can produce (then stop and send the error).

create unique index if not exists subscriptions_provider_subscription_idx
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;
