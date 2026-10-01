# Supabase Security and Performance Advisors

I could not run the advisors myself. They have to be opened in the dashboard, after the three
migrations in `docs/supabase-setup.md` have been run. **This page does not say the project is
clean.** Nobody has looked yet. Paste every finding into the tables below as you go.

## Where to find them

1. Open https://supabase.com/dashboard/project/vnfvgotzjbfikgcivrmn
2. In the left sidebar, click **Advisors**.
3. Click **Security Advisor**: https://supabase.com/dashboard/project/vnfvgotzjbfikgcivrmn/advisors/security
4. Click **Performance Advisor**: https://supabase.com/dashboard/project/vnfvgotzjbfikgcivrmn/advisors/performance

Each advisor has tabs for **Errors**, **Warnings** and **Info**. Open all three. Some findings only show after **Refresh** or **Rerun linter**.

## What the migrations were written to avoid

These are intentions, not results. The advisor findings are the result.

- **RLS disabled in public** (security): row level security is enabled on all four tables.
- **Function search_path mutable** (security): both functions set `search_path = ''`.
- **Auth RLS initialization plan** (performance): every policy uses `(select auth.uid())`, not `auth.uid()`.
- **Unindexed foreign keys** (performance): `owner_id` is indexed on `designs`, `jobs` and `exports`, and `design_id` on `jobs` and `exports`.
  - `exports (design_id, format)` is unique.
  - `profiles.id` is the primary key.
- **Multiple permissive policies** (performance): one policy per table and action, for the `authenticated` role only.

## Security Advisor findings

| # | Level (Error / Warning / Info) | Finding (name as shown) | Object (table, function, bucket) | What it says | Fixed in | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

## Performance Advisor findings

| # | Level (Error / Warning / Info) | Finding (name as shown) | Object (table, index, policy) | What it says | Fixed in | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

Date checked: ____ · Checked by: ____
