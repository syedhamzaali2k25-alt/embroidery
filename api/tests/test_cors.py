"""CORS: the browser's preflight must allow every route the API has, for the one web origin.

TestClient does not do CORS, so a method missing from the CORS list (DELETE was: Team > Remove
and Cancel invite failed in the browser with "Can't reach the Stitchbook server") passes every
other test. Here every route gets a real preflight: OPTIONS with Origin, Access-Control-Request-
Method and Access-Control-Request-Headers, exactly as a browser sends it before the request.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from stitchbook_api.main import CORS_HEADERS, cors_methods, create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage
from test_billing_api import CONFIG

ORIGIN = "http://localhost:8080"
WEB_API = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "api.ts"
REQUEST_HEADERS = "authorization,content-type"


def app_for(tmp_path) -> FastAPI:
    settings = Settings("redis://127.0.0.1:1", "digitize", ORIGIN, str(tmp_path), False, "info", free_operations=True)
    return create_app(CONFIG, LocalDiskStorage(tmp_path), settings)


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "0" * 32, path)


def refused_preflights(client: TestClient, app: FastAPI, origin: str = ORIGIN) -> list[str]:
    """Every (method, path) whose preflight the browser would refuse."""
    refused = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods):
            r = client.options(concrete(route.path), headers={
                "Origin": origin, "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": REQUEST_HEADERS})
            allowed = {m.strip() for m in r.headers.get("access-control-allow-methods", "").split(",")}
            headers = {h.strip().lower() for h in r.headers.get("access-control-allow-headers", "").split(",")}
            if (r.status_code != 200 or r.headers.get("access-control-allow-origin") != origin
                    or method not in allowed or not {"authorization", "content-type"} <= headers):
                refused.append(f"{method} {route.path} ({r.status_code})")
    return refused


def test_every_route_passes_the_preflight_from_the_web_origin(tmp_path):
    app = app_for(tmp_path)
    client = TestClient(app)
    assert refused_preflights(client, app) == []
    methods = {m for r in app.routes if isinstance(r, APIRoute) for m in r.methods}
    assert "DELETE" in methods  # the team routes: the bug this test was written for


def test_only_the_methods_the_routes_use_and_options(tmp_path):
    app = app_for(tmp_path)
    used = {m for r in app.routes if isinstance(r, APIRoute) for m in r.methods}
    assert set(cors_methods(app)) == used | {"OPTIONS"} == {"GET", "POST", "DELETE", "OPTIONS"}
    r = TestClient(app).options("/team", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "PUT"})
    assert r.status_code == 400  # nothing the API does not use


def test_another_origin_is_not_allowed(tmp_path):
    app = app_for(tmp_path)
    client = TestClient(app)
    r = client.options("/team/members/" + "0" * 32, headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": REQUEST_HEADERS})
    assert r.status_code == 400 and "access-control-allow-origin" not in r.headers
    assert len(refused_preflights(client, app, origin="https://evil.example")) == \
        sum(len(r.methods) for r in app.routes if isinstance(r, APIRoute))  # every single one refused
    plain = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in plain.headers


def test_a_real_delete_answers_with_the_cors_header(tmp_path):
    client = TestClient(app_for(tmp_path))
    r = client.delete("/team/members/" + "0" * 32, headers={"Origin": ORIGIN})
    assert r.headers.get("access-control-allow-origin") == ORIGIN  # the browser can read the answer


def test_what_the_web_app_sends_is_allowed(tmp_path):
    """Every method and header web/src/lib/api.ts sends to the API is in the CORS lists."""
    source = WEB_API.read_text()
    sent_methods = set(re.findall(r'method:\s*"([A-Z]+)"', source)) | {"GET"}  # fetch's default
    sent_headers = set(re.findall(r'headers\.set\("([A-Za-z-]+)"', source)) | set(re.findall(r'"([A-Za-z-]+)":\s*"', source.split("const post")[1][:200]))
    assert sent_methods == {"GET", "POST", "DELETE"}, sent_methods
    assert {h.lower() for h in sent_headers} == {"authorization", "content-type"}, sent_headers
    app = app_for(tmp_path)
    assert sent_methods <= set(cors_methods(app))
    assert {h.lower() for h in sent_headers} <= {h.lower() for h in CORS_HEADERS}


def test_the_check_catches_a_method_missing_from_the_cors_list(tmp_path):
    """The guard works: an app whose CORS list lacks DELETE fails it (the old bug)."""
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN], allow_methods=["GET", "POST"],
                       allow_headers=list(CORS_HEADERS))

    @app.delete("/team/members/{member_id}")
    def remove(member_id: str) -> dict:
        return {}
    assert refused_preflights(TestClient(app), app) == ["DELETE /team/members/{member_id} (400)"]
