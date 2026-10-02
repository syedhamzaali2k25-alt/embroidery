"""Test helper: the billing Rpc on a throwaway local Postgres (supabase/tests harness), so the API's
billing tests run the real migration-5 functions, as the service role, exactly as PostgREST would."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "supabase" / "tests"))
from test_rls import MIGRATIONS, STUB, Postgres  # noqa: E402

from stitchbook_api.billing import InsufficientCredits  # noqa: E402

SET_RETURNING = {"credit_balance"}


def literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
    return "'" + text.replace("'", "''") + "'"


class PgRpc:
    def __init__(self, pg: Postgres):
        self.pg = pg

    def call(self, fn: str, args: dict[str, Any]) -> Any:
        named = ", ".join(f"{k} => {literal(v)}" for k, v in args.items())
        query = (f"select coalesce(json_agg(t), '[]') from public.{fn}({named}) t" if fn in SET_RETURNING
                 else f"select to_json(public.{fn}({named}))")
        try:
            out = self.pg.sql(query, service=True)
        except PermissionError as exc:
            if "insufficient_credits" in str(exc):
                detail = re.search(r"DETAIL:\s+(\{.*\})", str(exc))
                d = json.loads(detail.group(1)) if detail else {}
                raise InsufficientCredits(int(d.get("available", 0)), int(d.get("needed", 0))) from None
            raise
        text = whole(out)
        return json.loads(text) if text else None

    def select(self, table: str, owner_id: str, order: str | None = None, limit: int | None = None) -> list[dict]:
        order_sql = f" order by {order.replace('.', ' ')}" if order else ""
        limit_sql = f" limit {int(limit)}" if limit else ""
        out = self.pg.sql(f"select coalesce(json_agg(t), '[]') from (select * from public.{table} "
                          f"where owner_id = {literal(owner_id)}{order_sql}{limit_sql}) t", service=True)
        return json.loads(whole(out))

    def select_by(self, table: str, column: str, value: str) -> list[dict]:
        assert column.isidentifier()
        out = self.pg.sql(f"select coalesce(json_agg(t), '[]') from (select * from public.{table} "
                          f"where {column}::text = {literal(value)}) t", service=True)
        return json.loads(whole(out))


def whole(rows: list[list[str]]) -> str:
    """psql prints JSON over several lines and splits on "|": put it back together."""
    return "\n".join("|".join(r) for r in rows).strip()


def start_postgres() -> Postgres:
    pg = Postgres()
    pg.sql(STUB.read_text())
    for migration in MIGRATIONS:
        pg.sql(migration.read_text())
    return pg
