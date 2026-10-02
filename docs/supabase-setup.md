# Supabase setup

Stitchbook keeps accounts, designs and files in one Supabase project:
`https://vnfvgotzjbfikgcivrmn.supabase.co`. Nothing in the repository changes the project by
itself. You paste the SQL files into the SQL Editor, in order, and put the keys in `.env`.

## 1. Run the migrations, in this order

The files are in `supabase/migrations/`. Paste each one whole and run it before you open the next.

| Order | File | What it creates |
|---|---|---|
| 1st | `20261001000001_tables.sql` | Tables `profiles`, `designs`, `jobs`, `exports`. Each has an owner column. Each has an index on `owner_id`. Row level security is on, and every table has four owner-only policies (read, insert, update, delete) for signed-in users. The anon role has no policy and no table privileges. |
| 2nd | `20261001000002_profiles_on_signup.sql` | A trigger on `auth.users` that adds a `profiles` row for each new account. |
| 3rd | `20261001000003_storage.sql` | Private buckets `uploads` and `exports`. Their policies let a signed-in user read and write only under their own folder: `{user_id}/...`. |
| 4th | `20261001000005_billing.sql` | Credits and plans (Step 13): `subscriptions`, `credit_ledger`, `credit_reservations`, `credit_allocations`, `operation_log`, `processed_webhook_events`, with RLS (users read their own rows only and write nothing), and the credit functions that only the secret key may run. It also adds `(design_id, owner_id)` indexes to `jobs` and `exports`. See `docs/billing.md`. |
| 5th | `20261001000006_whop_subscription_owner.sql` | Payments (Step 13c): one Whop membership can belong to one account only (a unique index on `subscriptions`). Paste it before taking payments; see `docs/payments-whop.md`. |

There is no `20261001000004_*.sql` in this repository. If you made a migration 4 yourself, run it before migration 5. Migration 5 does not depend on it; its index statements use `if not exists`, so an index of the same name is not made twice.

What to click:

1. Open https://supabase.com/dashboard/project/vnfvgotzjbfikgcivrmn
2. In the left sidebar, click **SQL Editor**.
3. Click **+** (New query) to get an empty tab.
4. Open `supabase/migrations/20261001000001_tables.sql` in a text editor. Copy all of it, paste it into the SQL Editor tab, and click **Run** (or press Ctrl+Enter / Cmd+Enter).
   - Expected result: "Success. No rows returned".
   - If you see an error, stop and send it to me. Don't run the next file.
5. Open a new tab with **+** again. Paste and run `20261001000002_profiles_on_signup.sql`.
6. Open a new tab with **+** again. Paste and run `20261001000003_storage.sql`.
7. Open a new tab with **+** again. Paste and run `20261001000005_billing.sql`. (If the first three are already in your project, start here.)
8. Open a new tab with **+** again. Paste and run `20261001000006_whop_subscription_owner.sql` (Step 13c). If 1-5 are already in your project, this is the only one to run now.

Each file is meant to run once on the empty project. Running file 1 or 2 a second time fails with "already exists"; that is harmless, nothing is changed. File 3 also stops at its first policy on a second run, after setting both buckets back to private.

Check that it worked:

- **Table Editor**: the four tables of migration 1 and the six of migration 5 are listed. None of them is marked "RLS disabled".
- **Database → Functions**: `reserve_credit`, `consume_credit`, `release_credit`, `credit_balance`, `grant_credits`, `release_stale_reservations`, `apply_billing_event` are there.
- **Storage**: the buckets `uploads` and `exports` are there. Neither is marked "Public".
- **Authentication → Policies**: each table has its four "owner can ..." policies.

## 2. Keys in `.env`

In the dashboard, open **Project Settings → API Keys**. Copy these into `.env` at the repository root (copy `.env.example` to `.env` first):

```
SUPABASE_URL=https://vnfvgotzjbfikgcivrmn.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
```

- **The publishable key** goes to the browser. The web build reads it, along with the URL.
- **The secret key** stays on your computer. The running API never uses it. Only the live isolation tests use it, to create and delete their two test users.
  - The web build is checked so it can never contain the secret key: `npm run check:secrets`, which also runs at the end of `npm run build`.
- **`.env` is gitignored.** Never commit it.

With these values set:

- **API** (`make api`): sign-in is on. Every route except `/health`, `/site`, `/formats` and `/config` needs a signed-in user. Designs go to the tables, and files go to the private buckets under `{user_id}/{design_id}/{file}`.
- **Web app** (`make web` or `npm run build`): shows Log in, Sign up, Log out and My designs.

Without them, both run in local mode: no sign-in, one local user, and files in `STORAGE_DIR`.

## 3. Authentication settings to check

These are your choices. The code works with either setting.

- **Authentication → Sign In / Providers → Email**:
  - With **Confirm email** on (the default), a new account must open the emailed link before logging in. The Sign up screen says so.
  - With it off, a new account is logged in straight away.
- **Authentication → URL Configuration**: see 4c (Site URL `http://localhost:8080`; Redirect URLs `http://localhost:8080/login` and `http://localhost:8080/`).
- **Password rules**: set in the same Email provider settings. The Sign up screen shows Supabase's own message when a password is refused.

## 4. Google sign-in

The Log in and Sign up screens have a **Continue with Google** button and, when a Google client ID is set, the Google One Tap prompt. Both end in an ordinary Supabase session, so the API needs no change.

- **Continue with Google**: the browser goes to Google through Supabase and comes back to `/login`, which finishes the sign-in and goes on to the page the visitor came from.
- **One Tap**: Google's ID token is checked by Supabase with a nonce. Keep Supabase's nonce check on.

The Google client secret lives only in the Supabase dashboard. Never put it in `.env`, `web/` or anywhere in the repo. `npm run check:secrets` and `api/tests/test_env_example.py` look for one (`GOCSPX-...`).

### 4a. Google Cloud: the OAuth client

1. Open https://console.cloud.google.com/apis/credentials and choose the project for Stitchbook.
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - App name, support email and developer contact email.
   - Scopes: only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. Nothing else is used.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: `http://localhost:8080`. Add the real site's origin later, when it has one.
   - **Authorized redirect URIs**: `https://vnfvgotzjbfikgcivrmn.supabase.co/auth/v1/callback`
   - Click **Create**. Copy the **Client ID** (public) and the **Client secret** (secret: it goes only in step 4b).
4. **Test users**: while the app's publishing status is **Testing**, only the Google accounts listed under **Audience → Test users** can sign in. Add your own account, and anyone else who should try it. Others see Google's "access blocked" page.

### 4b. Supabase: the Google provider

You said this is already done. To check it:

- Go to **Authentication → Sign In / Providers → Google**.
- **Enable Sign in with Google** is on.
- **Client IDs** contains the Client ID from 4a. **Client Secret (for OAuth)** is the secret from 4a.
- Leave **Skip nonce checks** off. One Tap sends a nonce, and Supabase must check it.
- The **Callback URL (for OAuth)** shown there is the redirect URI in 4a.

### 4c. Supabase: URL Configuration

Go to **Authentication → URL Configuration**:

- **Site URL**: `http://localhost:8080`
- **Redirect URLs**: add both of these, then click **Save**:
  - `http://localhost:8080/login` (Google and the confirmation email return here)
  - `http://localhost:8080/`

When the site gets its real address, add the same two paths for it.

### 4d. `.env`

```
VITE_GOOGLE_CLIENT_ID=<the Client ID from 4a>.apps.googleusercontent.com
```

This turns on the One Tap prompt. Without it, **Continue with Google** still works and no Google script is loaded. Rebuild or restart the web app (`make web`) after changing it.

### 4e. What the browser loads

The Log in and Sign up pages load `https://accounts.google.com/gsi/client` (only with a client ID, and only for someone not signed in). No other page loads it. The repo has no Content-Security-Policy today. If one is added where the site is hosted, it needs:

- `script-src https://accounts.google.com/gsi/client`
- `frame-src https://accounts.google.com/gsi/`
- `connect-src https://accounts.google.com/gsi/` plus the Supabase URL
- `style-src https://accounts.google.com/gsi/style`

## 5. Run the live isolation tests

These tests run against the real project:

1. They create two real test users, A and B. Both get random `stitchbook-test-...@example.com` addresses.
2. They check that B cannot see A's design anywhere:
   - the list;
   - get, edits, undo/redo, trace, download and the signed download link;
   - the Storage paths, read directly;
   - the REST API.
3. They check that nothing works without a token.
4. They delete both users and their files.

```sh
.venv/bin/pytest api/tests/test_supabase_live.py -v
```

The tests read the three keys from `.env` or the environment, and never print them. Without the keys they are skipped, with a message that says so.

## Known limits

- A Google sign-in started from the Upload screen comes back without the chosen file (the page reloads on the way back). Choose the file again; email/password log-in keeps it.
- The Google sign-in was tested here only against stand-ins for Google and Supabase (`npm run test:auth`), never against real Google. Try it once yourself after 4a-4d.
- Deleting a user in **Authentication → Users** deletes their profile, designs, jobs and exports rows (cascade). It does not delete their files in Storage; delete the user's folder in both buckets by hand. There is no "delete my account" feature in the app yet.
- The SQL was tested on a local PostgreSQL 16 with a small stand-in for Supabase's `auth` and `storage` schemas (`supabase/tests/test_rls.py`), not on Supabase itself. Section 4 is the test on the real project.
