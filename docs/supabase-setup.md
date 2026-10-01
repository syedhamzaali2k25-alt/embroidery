# Supabase setup

Stitchbook keeps accounts, designs and files in one Supabase project:
`https://vnfvgotzjbfikgcivrmn.supabase.co`. Nothing in the repository changes the project by
itself. You paste three SQL files into the SQL Editor, in order, and put three keys in `.env`.

## 1. Run the three migrations, in this order

The files are in `supabase/migrations/`. Paste each one whole and run it before you open the next.

| Order | File | What it creates |
|---|---|---|
| 1st | `20261001000001_tables.sql` | Tables `profiles`, `designs`, `jobs`, `exports`. Each has an owner column. Each has an index on `owner_id`. Row level security is on, and every table has four owner-only policies (read, insert, update, delete) for signed-in users. The anon role has no policy and no table privileges. |
| 2nd | `20261001000002_profiles_on_signup.sql` | A trigger on `auth.users` that adds a `profiles` row for each new account. |
| 3rd | `20261001000003_storage.sql` | Private buckets `uploads` and `exports`. Their policies let a signed-in user read and write only under their own folder: `{user_id}/...`. |

What to click:

1. Open https://supabase.com/dashboard/project/vnfvgotzjbfikgcivrmn
2. In the left sidebar, click **SQL Editor**.
3. Click **+** (New query) to get an empty tab.
4. Open `supabase/migrations/20261001000001_tables.sql` in a text editor. Copy all of it, paste it into the SQL Editor tab, and click **Run** (or press Ctrl+Enter / Cmd+Enter).
   - Expected result: "Success. No rows returned".
   - If you see an error, stop and send it to me. Don't run the next file.
5. Open a new tab with **+** again. Paste and run `20261001000002_profiles_on_signup.sql`.
6. Open a new tab with **+** again. Paste and run `20261001000003_storage.sql`.

Each file is meant to run once on the empty project. Running file 1 or 2 a second time fails with "already exists"; that is harmless, nothing is changed. File 3 also stops at its first policy on a second run, after setting both buckets back to private.

Check that it worked:

- **Table Editor**: the four tables are listed. None of them is marked "RLS disabled".
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
- **Authentication → URL Configuration**:
  - Set **Site URL** to the address of the web app, e.g. `http://localhost:8080` while developing.
  - Add `http://localhost:8080/login` to **Redirect URLs**, so the confirmation link comes back to the Log in screen.
- **Password rules**: set in the same Email provider settings. The Sign up screen shows Supabase's own message when a password is refused.

## 4. Run the live isolation tests

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

- Deleting a user in **Authentication → Users** deletes their profile, designs, jobs and exports rows (cascade). It does not delete their files in Storage; delete the user's folder in both buckets by hand. There is no "delete my account" feature in the app yet.
- The SQL was tested on a local PostgreSQL 16 with a small stand-in for Supabase's `auth` and `storage` schemas (`supabase/tests/test_rls.py`), not on Supabase itself. Section 4 is the test on the real project.
