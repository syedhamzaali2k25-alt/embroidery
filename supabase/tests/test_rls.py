"""Row level security and Storage policies, tested on a throwaway local Postgres.

The three migrations in supabase/migrations/ are applied, in order, on top of a small stand-in for
Supabase (supabase_stub.sql: its roles, default grants, auth.uid() and the storage tables), and
two users act through the "authenticated" role with their own JWT claims, as PostgREST and
Storage do. This proves the SQL of the policies; the live project is tested by
api/tests/test_supabase_live.py when its keys are available.

Skipped when no Postgres server binaries (initdb, pg_ctl) are installed.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
STUB = ROOT / "supabase" / "tests" / "supabase_stub.sql"
A, B = str(uuid.uuid4()), str(uuid.uuid4())


def _bindir() -> Path | None:
    found = shutil.which("initdb")
    if found:
        return Path(found).parent
    candidates = sorted(glob.glob("/usr/lib/postgresql/*/bin/initdb"))
    return Path(candidates[-1]).parent if candidates else None


class Postgres:
    def __init__(self) -> None:
        bindir = _bindir()
        if bindir is None or shutil.which("psql") is None:
            pytest.skip("no local Postgres server (initdb/pg_ctl/psql): RLS SQL not tested here")
        self.bindir = bindir
        self.dir = Path(tempfile.mkdtemp(prefix="stitchbook-pg-", dir="/tmp"))
        self.port = os.environ.get("STITCHBOOK_TEST_PG_PORT", "55433")  # the screenshot server uses its own
        as_root = os.geteuid() == 0
        self.prefix = ["runuser", "-u", "postgres", "--"] if as_root else []
        if as_root:
            os.chmod(self.dir, 0o755)
            shutil.chown(self.dir, "postgres")
        self._run([str(bindir / "initdb"), "-D", str(self.dir / "data"), "-A", "trust", "-U", "postgres"])
        self._run([str(bindir / "pg_ctl"), "-D", str(self.dir / "data"), "-w", "-l", str(self.dir / "log"),
                   "-o", f"-k {self.dir} -p {self.port} -c listen_addresses=''", "start"])

    def _run(self, cmd: list[str]) -> None:
        subprocess.run(self.prefix + cmd, check=True, capture_output=True)

    def stop(self) -> None:
        self._run([str(self.bindir / "pg_ctl"), "-D", str(self.dir / "data"), "-m", "fast", "stop"])
        shutil.rmtree(self.dir, ignore_errors=True)

    def sql(self, query: str, user: str | None = None, anon: bool = False, service: bool = False) -> list[list[str]]:
        """Run `query` as the database owner, as a signed-in `user` / an anon visitor (through
        the same roles and JWT claims PostgREST uses), or as the server's secret key
        (`service`: the service_role). Returns rows; raises on any SQL error."""
        if user or anon or service:
            claims = json.dumps({"sub": user, "role": "authenticated"} if user else {"role": "service_role" if service else "anon"})
            role = "authenticated" if user else "service_role" if service else "anon"
            query = (f"begin;\nset local role {role};\nset local request.jwt.claims = '{claims}';\n"
                     f"{query.rstrip().rstrip(';')};\ncommit;")
        done = subprocess.run(["psql", "-h", str(self.dir), "-p", self.port, "-U", "postgres", "-X", "-q", "-A", "-t",
                               "-v", "ON_ERROR_STOP=1", "-f", "-"], input=query, text=True, capture_output=True)
        if done.returncode != 0:
            raise PermissionError(done.stderr.strip())
        return [line.split("|") for line in done.stdout.splitlines() if line]


@pytest.fixture(scope="module")
def db():
    pg = Postgres()
    try:
        pg.sql(STUB.read_text())
        for migration in MIGRATIONS:
            pg.sql(migration.read_text())
        pg.sql(f"insert into auth.users (id, email) values ('{A}', 'a@example.com'), ('{B}', 'b@example.com')")
        yield pg
    finally:
        pg.stop()


def new_design(db: Postgres, user: str) -> str:
    rows = db.sql("insert into public.designs (filename, file_type, status, record) "
                  "values ('logo.png', 'png', 'uploaded', '{}') returning id, owner_id", user=user)
    design_id, owner = rows[0]
    assert owner == user  # owner_id defaults to the signed-in user
    return design_id


def test_the_migrations_create_exactly_the_four_tables_and_two_private_buckets(db):
    tables = {r[0] for r in db.sql("select tablename from pg_tables where schemaname = 'public'")}
    assert tables == {"profiles", "designs", "jobs", "exports",  # migration 1
                      "subscriptions", "credit_ledger", "credit_reservations", "credit_allocations",  # migration 5
                      "operation_log", "processed_webhook_events",
                      "teams", "team_members", "team_invites", "team_extra_seats"}  # migration 7
    rls = db.sql("select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1")
    assert all(on == "t" for _name, on in rls), "row level security must be on for every table"
    assert db.sql("select id, public from storage.buckets order by id") == [["exports", "f"], ["uploads", "f"]]
    owner_indexes = {r[0] for r in db.sql("select indexdef from pg_indexes where schemaname = 'public'") if "owner_id" in r[0]}
    for table in ("designs", "jobs", "exports", "credit_ledger", "credit_reservations", "credit_allocations", "operation_log",
                  "teams", "team_members", "team_invites", "team_extra_seats"):
        assert any(f"public.{table} " in d for d in owner_indexes), f"{table}.owner_id is indexed"


def test_signing_up_creates_the_users_own_profile_and_only_they_see_it(db):
    assert db.sql("select count(*) from public.profiles") == [["2"]]
    assert db.sql("select id from public.profiles", user=A) == [[A]]
    assert db.sql("select id from public.profiles", user=B) == [[B]]
    with pytest.raises(PermissionError, match="row-level security"):
        db.sql(f"insert into public.profiles (id) values ('{uuid.uuid4()}')", user=A)


def test_user_b_cannot_read_change_or_delete_user_as_design(db):
    design = new_design(db, A)
    assert db.sql("select id from public.designs", user=A) == [[design]]
    assert db.sql("select id from public.designs", user=B) == []  # B's list does not contain it
    assert db.sql(f"select id from public.designs where id = '{design}'", user=B) == []
    assert db.sql(f"update public.designs set filename = 'taken.png' where id = '{design}' returning id", user=B) == []
    assert db.sql(f"delete from public.designs where id = '{design}' returning id", user=B) == []
    assert db.sql(f"select filename from public.designs where id = '{design}'", user=A) == [["logo.png"]]


def test_user_b_cannot_create_rows_owned_by_user_a_or_attached_to_as_design(db):
    design = new_design(db, A)
    with pytest.raises(PermissionError, match="row-level security"):
        db.sql(f"insert into public.designs (owner_id, filename, file_type, status, record) "
               f"values ('{A}', 'x.png', 'png', 'uploaded', '{{}}')", user=B)
    with pytest.raises(PermissionError, match="row-level security"):  # someone else's owner_id
        db.sql(f"insert into public.jobs (id, owner_id, design_id, status) values ('{uuid.uuid4().hex}', '{A}', '{design}', 'queued')", user=B)
    with pytest.raises(PermissionError, match="foreign key"):  # own owner_id, but A's design
        db.sql(f"insert into public.jobs (id, owner_id, design_id, status) values ('{uuid.uuid4().hex}', '{B}', '{design}', 'queued')", user=B)
    with pytest.raises(PermissionError, match="foreign key"):
        db.sql(f"insert into public.exports (owner_id, design_id, format, storage_path) "
               f"values ('{B}', '{design}', 'dst', '{B}/{design}/out.dst')", user=B)


def test_jobs_and_exports_are_private_to_their_owner(db):
    design = new_design(db, A)
    job = uuid.uuid4().hex
    db.sql(f"insert into public.jobs (id, owner_id, design_id, status) values ('{job}', '{A}', '{design}', 'queued')", user=A)
    db.sql(f"insert into public.exports (owner_id, design_id, format, storage_path) "
           f"values ('{A}', '{design}', 'dst', '{A}/{design}/out.dst')", user=A)
    assert db.sql(f"select id from public.jobs where id = '{job}'", user=A) == [[job]]
    assert db.sql(f"select id from public.jobs where id = '{job}'", user=B) == []
    assert db.sql(f"select format from public.exports where design_id = '{design}'", user=B) == []
    with pytest.raises(PermissionError, match="check constraint"):  # a path outside the owner's folder
        db.sql(f"insert into public.exports (owner_id, design_id, format, storage_path) "
               f"values ('{A}', '{design}', 'pes', '{B}/{design}/out.pes')", user=A)


def test_a_visitor_who_is_not_signed_in_gets_nothing(db):
    new_design(db, A)
    for table in ("profiles", "designs", "jobs", "exports"):
        with pytest.raises(PermissionError, match="permission denied"):
            db.sql(f"select * from public.{table}", anon=True)
    assert db.sql("select name from storage.objects", anon=True) == []


def test_storage_owner_folder_only(db):
    design = new_design(db, A)
    path = f"{A}/{design}/original.png"
    db.sql(f"insert into storage.objects (bucket_id, name) values ('uploads', '{path}')", user=A)
    db.sql(f"insert into storage.objects (bucket_id, name) values ('exports', '{A}/{design}/out.dst')", user=A)
    assert db.sql(f"select name from storage.objects where name = '{path}'", user=A) == [[path]]
    assert db.sql(f"select name from storage.objects where name like '{A}/%'", user=B) == []  # B reads A's path: nothing
    with pytest.raises(PermissionError, match="row-level security"):  # B writes into A's folder
        db.sql(f"insert into storage.objects (bucket_id, name) values ('uploads', '{A}/{design}/evil.png')", user=B)
    with pytest.raises(PermissionError, match="row-level security"):  # anyone's file outside a user folder
        db.sql("insert into storage.objects (bucket_id, name) values ('exports', 'shared/out.dst')", user=A)
    assert db.sql(f"delete from storage.objects where name = '{path}' returning name", user=B) == []
    assert db.sql(f"select count(*) from storage.objects where name = '{path}'") == [["1"]]


def test_deleting_an_account_deletes_its_rows(db):
    gone = str(uuid.uuid4())
    db.sql(f"insert into auth.users (id) values ('{gone}')")
    design = new_design(db, gone)
    db.sql(f"insert into public.jobs (id, owner_id, design_id, status) values ('{uuid.uuid4().hex}', '{gone}', '{design}', 'done')", user=gone)
    db.sql(f"delete from auth.users where id = '{gone}'")
    for table, column in (("profiles", "id"), ("designs", "owner_id"), ("jobs", "owner_id")):
        assert db.sql(f"select count(*) from public.{table} where {column} = '{gone}'") == [["0"]]
