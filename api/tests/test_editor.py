"""Editor endpoints: every change is stored on the server, re-sews the design, and shows up in
Preview and Download; Undo and Redo work; mistakes get a plain 422 and store nothing."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from digitizer.config import load_test_run_config
from fastapi.testclient import TestClient
from shapely.geometry import LineString, Polygon

from stitchbook_api.main import create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()
BODY, BRANCH = 1, 7  # bird: navy body (fill), brown branch (satin)


@pytest.fixture
def client(tmp_path):
    settings = Settings("redis://unused", "digitize", None, str(tmp_path / "store"), False, "info")
    return TestClient(create_app(CONFIG, LocalDiskStorage(tmp_path / "store"), settings))


def bird(client, name="bird.png", width=90) -> str:
    body = (SAMPLES / name).read_bytes()
    response = client.post("/designs", files={"file": (name, body, "image/png")}, data={"settings": json.dumps({"width_mm": width})})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def branch_cut(state, x):
    shape = next(s for s in state["shapes"]["shapes"] if s["number"] == BRANCH)
    poly = Polygon(shape["rings"][0], shape["rings"][1:])
    cut = poly.intersection(LineString([(x, -100), (x, 100)]))
    ys = [p[1] for g in getattr(cut, "geoms", [cut]) for p in g.coords]
    return [x, min(ys)], [x, max(ys)]


def download(client, design_id) -> bytes:
    response = client.get(f"/designs/{design_id}/download?format=dst")
    assert response.status_code == 200
    return response.content


def test_editor_state_has_shapes_columns_stitches_and_defaults(client):
    design_id = bird(client)
    state = client.get(f"/designs/{design_id}/editor").json()
    assert len(state["shapes"]["shapes"]) == 9 and state["columns"] and state["stitches"]
    assert state["history"] == {"applied": 0, "total": 0, "undo": None, "redo": None}
    assert state["defaults"]["pull_compensation_mm"] == CONFIG.get("stitch.pull_compensation_mm")
    assert [c["number"] for c in state["columns"]] == list(range(1, len(state["columns"]) + 1))
    assert download(client, design_id)  # opening the editor writes the stitch file


def test_type_change_reaches_preview_and_download_and_undo_redo_restore_it(client):
    design_id = bird(client)
    before = client.get(f"/designs/{design_id}/editor").json()
    dst_before = download(client, design_id)

    after = client.post(f"/designs/{design_id}/edits", json={"op": "set_type", "shape": BODY, "kind": "running"}).json()
    assert after["shapes"]["shapes"][BODY - 1]["kind"] == "running"
    assert after["stats"]["stitch_count"] != before["stats"]["stitch_count"]
    assert after["history"] == {"applied": 1, "total": 1, "undo": "Change a shape to Running", "redo": None}
    dst_after = download(client, design_id)
    assert dst_after != dst_before
    preview = client.post(f"/designs/{design_id}/preview").json()
    assert preview["stats"]["stitch_count"] == after["stats"]["stitch_count"]
    assert "running" in {layer["type"] for layer in preview["layers"]}

    undone = client.post(f"/designs/{design_id}/edits/undo").json()
    assert undone["stats"] == before["stats"] and download(client, design_id) == dst_before
    assert undone["history"] == {"applied": 0, "total": 1, "undo": None, "redo": "Change a shape to Running"}
    redone = client.post(f"/designs/{design_id}/edits/redo").json()
    assert redone["stats"] == after["stats"] and download(client, design_id) == dst_after

    # A new change after Undo drops what could be redone.
    client.post(f"/designs/{design_id}/edits/undo")
    fresh = client.post(f"/designs/{design_id}/edits", json={"op": "set_type", "shape": BODY, "kind": "satin"}).json()
    assert fresh["history"] == {"applied": 1, "total": 1, "undo": "Change a shape to Satin", "redo": None}


def test_nothing_to_undo_or_redo_is_a_plain_409(client):
    design_id = bird(client)
    for action, word in (("undo", "undo"), ("redo", "redo")):
        response = client.post(f"/designs/{design_id}/edits/{action}")
        assert response.status_code == 409 and response.json()["error"] == f"There is nothing to {word}."


def test_pull_compensation_is_checked_against_the_config_range(client):
    design_id = bird(client)
    hi = CONFIG.get("api.pull_compensation_max_mm")
    bad = client.post(f"/designs/{design_id}/edits", json={"op": "set_pull_compensation", "shape": BRANCH, "mm": hi + 1})
    assert bad.status_code == 422 and "between" in bad.json()["error"]
    good = client.post(f"/designs/{design_id}/edits", json={"op": "set_pull_compensation", "shape": BRANCH, "mm": hi})
    assert good.status_code == 200 and good.json()["shapes"]["shapes"][BRANCH - 1]["pull_compensation_mm"] == hi
    reset = client.post(f"/designs/{design_id}/edits", json={"op": "set_pull_compensation", "shape": BRANCH, "mm": None})
    assert reset.json()["shapes"]["shapes"][BRANCH - 1]["pull_compensation_mm"] is None


def test_split_and_its_mistakes(client):
    design_id = bird(client)
    state = client.get(f"/designs/{design_id}/editor").json()
    a, b = branch_cut(state, -30)
    split = client.post(f"/designs/{design_id}/edits", json={"op": "split", "a": a, "b": b}).json()
    assert len(split["shapes"]["shapes"]) == 10 and len(split["columns"]) > len(state["columns"])
    wrong = client.post(f"/designs/{design_id}/edits", json={"op": "split", "a": [0, -20], "b": [5, -20]})
    assert wrong.status_code == 422 and "same satin shape" in wrong.json()["error"]
    # A refused change stores nothing.
    assert client.get(f"/designs/{design_id}").json()["edits_applied"] == 1


def test_column_from_two_outlines_and_from_drawn_edges(client):
    ring_id = bird(client, "thin_ring.png", 40)
    ring = client.post(f"/designs/{ring_id}/edits", json={
        "op": "column", "left": {"shape": 1, "ring": 0}, "right": {"shape": 1, "ring": 1}}).json()
    assert [s["kind"] for s in ring["shapes"]["shapes"]] == ["column"]
    assert ring["shapes"]["shapes"][0]["edges"]["closed"] is True

    design_id = bird(client)
    before = client.get(f"/designs/{design_id}/editor").json()
    drawn = client.post(f"/designs/{design_id}/edits", json={
        "op": "column", "left": {"points": [[-40, -25], [-20, -25]]}, "right": {"points": [[-40, -22], [-20, -22]]},
        "colour": 2}).json()
    assert len(drawn["columns"]) == len(before["columns"]) + 1
    assert drawn["colours"][1]["shape_count"] == before["colours"][1]["shape_count"] + 1
    crossing = client.post(f"/designs/{design_id}/edits", json={
        "op": "column", "left": {"points": [[-40, -25], [-20, -22]]}, "right": {"points": [[-40, -22], [-20, -25]]}})
    assert crossing.status_code == 422 and "cross each other" in crossing.json()["error"]


def test_edits_reach_the_trace_job_arguments_and_the_cli(client, tmp_path):
    design_id = bird(client)
    client.post(f"/designs/{design_id}/edits", json={"op": "set_type", "shape": BODY, "kind": "running"})
    record = client.get(f"/designs/{design_id}").json()
    (tmp_path / "edits.json").write_text(json.dumps(record["edits"]))
    subprocess.run([sys.executable, "-m", "digitizer.digitize", str(SAMPLES / "bird.png"), "--out", str(tmp_path / "cli"),
                    "--width-mm", "90", "--test-run-values", "--edits", str(tmp_path / "edits.json")], check=True,
                   capture_output=True)
    assert (tmp_path / "cli" / "out.dst").read_bytes() == download(client, design_id)


def test_bad_edit_bodies_get_plain_messages(client):
    design_id = bird(client)
    for body in ({"op": "set_type", "shape": 1, "kind": "zigzag"}, {"op": "explode"}, {"op": "split", "a": [1]}):
        response = client.post(f"/designs/{design_id}/edits", json=body)
        assert response.status_code == 422 and response.json()["error"].endswith("Fix the request and send it again.")
    missing = client.post(f"/designs/{design_id}/edits", json={"op": "set_type", "shape": 99, "kind": "fill"})
    assert missing.status_code == 422 and "There is no shape 99" in missing.json()["error"]
