"""API tests: uploads (valid and invalid), quality warnings, preview, download, CORS, storage.

The app runs with TEST_RUN_OVERRIDES because product limits are still unchosen placeholders.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from digitizer.config import load_config, load_test_run_config
from fastapi.testclient import TestClient

from stitchbook_api.main import create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()
ORIGIN = "http://localhost:8080"


def make_client(tmp_path: Path, config=CONFIG) -> TestClient:
    settings = Settings("redis://unused", "digitize", ORIGIN, str(tmp_path / "store"), False, "info")
    return TestClient(create_app(config, LocalDiskStorage(tmp_path / "store"), settings))


@pytest.fixture
def client(tmp_path):
    return make_client(tmp_path)


def png_bytes(image: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", image)
    assert ok
    return buf.tobytes()


def upload(client, data: bytes, name="logo.png", settings: dict | None = None):
    form = {"settings": json.dumps(settings)} if settings is not None else {}
    return client.post("/designs", files={"file": (name, data, "application/octet-stream")}, data=form)


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "app": "Stitchbook"}


# ---------- valid upload ----------

def test_upload_valid_png(client):
    response = upload(client, (SAMPLES / "circle.png").read_bytes(), settings={"width_mm": 60})
    assert response.status_code == 201, response.text
    body = response.json()
    assert len(body["id"]) == 32 and body["type"] == "png"
    assert (body["width_px"], body["height_px"]) == (600, 600)
    assert body["warnings"] == []  # crisp, high-contrast, 600 px
    record = client.get(f"/designs/{body['id']}").json()
    assert record["status"] == "uploaded"
    assert record["settings"] == {"width_mm": 60.0, "fill_row_spacing_mm": None}
    assert record["downloads"] == []


def test_upload_valid_svg_is_stored_but_not_digitized_yet(client):
    svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect/></svg>'
    body = upload(client, svg, "logo.svg").json()
    assert body["type"] == "svg" and (body["width_px"], body["height_px"]) == (400, 200)
    response = client.post(f"/designs/{body['id']}/preview")
    assert response.status_code == 422 and "Export the logo as PNG" in response.json()["error"]


# ---------- invalid uploads: each says what to fix ----------

@pytest.mark.parametrize("data,status,phrase", [
    (b"just some text, not an image", 415, "not a PNG, JPG or SVG"),
    (b"GIF89a" + b"\0" * 64, 415, "This is a GIF file. Upload the logo as PNG, JPG or SVG"),
    (b"%PDF-1.7 ...", 415, "This is a PDF file"),
    (b"\x89PNG\r\n\x1a\n" + b"garbage" * 20, 422, "may be damaged"),
    (b"", 422, "The file is empty"),
    (b'<svg><!DOCTYPE x [<!ENTITY a "b">]></svg>', 422, "DOCTYPE or ENTITY"),
])
def test_upload_invalid_file(client, data, status, phrase):
    response = upload(client, data, "logo.png")
    assert response.status_code == status
    assert phrase in response.json()["error"]


def test_upload_too_many_bytes(tmp_path):
    client = make_client(tmp_path, CONFIG.with_overrides({"input.max_upload_bytes": 1000}))
    response = upload(client, (SAMPLES / "circle.png").read_bytes())
    assert response.status_code == 413
    assert "limit" in response.json()["error"] and "Export a smaller file" in response.json()["error"]


def test_upload_too_many_pixels(tmp_path):
    client = make_client(tmp_path, CONFIG.with_overrides({"input.max_image_side_px": 500}))
    response = upload(client, (SAMPLES / "circle.png").read_bytes())
    assert response.status_code == 422
    assert response.json()["error"] == ("The image is 600 x 600 px; the limit is 500 px on the long side. "
                                        "Resize it and upload again.")


def test_bad_settings_are_rejected_with_a_plain_message(client):
    response = upload(client, (SAMPLES / "circle.png").read_bytes(), settings={"width_mm": -5})
    assert response.status_code == 422
    assert response.json()["error"].startswith("settings: width_mm: Input should be greater than 0")


def test_unknown_and_malformed_ids(client):
    assert client.get("/designs/" + "0" * 32).status_code == 404
    assert "Upload the image again" in client.get("/designs/" + "0" * 32).json()["error"]
    response = client.get("/designs/../../etc/passwd")
    assert response.status_code in (404, 422)
    assert client.get("/designs/not-an-id").status_code == 422


# ---------- quality warnings ----------

def warning_codes(client, image: np.ndarray) -> set[str]:
    response = upload(client, png_bytes(image))
    assert response.status_code == 201, response.text
    return {w["code"] for w in response.json()["warnings"]}


def test_quality_warnings(client):
    sharp = cv2.imread(str(SAMPLES / "circle.png"), cv2.IMREAD_GRAYSCALE)
    assert warning_codes(client, sharp) == set()
    assert warning_codes(client, cv2.resize(sharp, (200, 200), interpolation=cv2.INTER_AREA)) == {"too_small"}
    assert warning_codes(client, cv2.GaussianBlur(sharp, (0, 0), 4)) == {"blurry_edges"}
    faded = (sharp.astype(float) * 0.15 + 200).astype(np.uint8)
    assert warning_codes(client, faded) == {"low_contrast"}
    messages = upload(client, png_bytes(cv2.GaussianBlur(sharp, (0, 0), 4))).json()["warnings"]
    assert "Upload the original artwork" in messages[0]["message"]


# ---------- preview and download ----------

def test_preview_returns_stitch_json_and_dst_matches_cli(client, tmp_path):
    source = SAMPLES / "bold_r.png"
    design_id = upload(client, source.read_bytes(), "bold R.png", {"width_mm": 18}).json()["id"]

    early = client.get(f"/designs/{design_id}/download?format=dst")
    assert early.status_code == 409 and "Run POST" in early.json()["error"]

    response = client.post(f"/designs/{design_id}/preview")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["stats"]["stitch_count"] == sum(s["command"] == "stitch" for s in body["stitches"]) > 0
    assert body["report"]["junction_patches"] == 2
    assert client.get(f"/designs/{design_id}").json()["status"] == "digitized"

    download = client.get(f"/designs/{design_id}/download?format=dst")
    assert download.status_code == 200
    assert download.headers["content-disposition"] == 'attachment; filename="bold_R.dst"'

    cli_out = tmp_path / "cli"
    subprocess.run([sys.executable, "-m", "digitizer.digitize", str(source), "--out", str(cli_out),
                    "--width-mm", "18", "--test-run-values"], check=True, capture_output=True)
    assert download.content == (cli_out / "out.dst").read_bytes()


def test_download_rejects_other_formats(client):
    design_id = upload(client, (SAMPLES / "circle.png").read_bytes()).json()["id"]
    response = client.get(f"/designs/{design_id}/download?format=pes")
    assert response.status_code == 422 and response.json()["error"].startswith("format: Input should be 'dst'")


def test_large_images_are_not_previewed_synchronously(tmp_path):
    client = make_client(tmp_path, CONFIG.with_overrides({"api.sync_preview_max_side_px": 500}))
    design_id = upload(client, (SAMPLES / "circle.png").read_bytes()).json()["id"]
    response = client.post(f"/designs/{design_id}/preview")
    assert response.status_code == 422 and "Resize it to at most 500 px" in response.json()["error"]


def test_unchosen_limits_give_a_configuration_message(tmp_path):
    client = make_client(tmp_path, load_config())  # product config: limits still placeholders
    response = upload(client, (SAMPLES / "circle.png").read_bytes())
    assert response.status_code == 503
    assert response.json()["error"] == ("The server is not configured yet: choose a value for "
                                        "input.max_upload_bytes in digitizer/src/digitizer/config.py.")


# ---------- CORS and storage ----------

def test_cors_allows_only_the_configured_origin(client):
    preflight = {"Access-Control-Request-Method": "POST"}
    ok = client.options("/designs", headers={"Origin": ORIGIN, **preflight})
    assert ok.headers.get("access-control-allow-origin") == ORIGIN
    other = client.options("/designs", headers={"Origin": "https://evil.example", **preflight})
    assert "access-control-allow-origin" not in other.headers


def test_cors_wildcard_is_refused(monkeypatch):
    from stitchbook_api.settings import load_settings
    monkeypatch.setenv("CORS_ORIGIN", "*")
    with pytest.raises(ValueError):
        load_settings()


def test_local_storage_round_trip_and_rejects_escaping_keys(tmp_path):
    storage = LocalDiskStorage(tmp_path)
    storage.put("designs/abc/out.dst", b"123")
    assert storage.get("designs/abc/out.dst") == b"123" and storage.exists("designs/abc/out.dst")
    for bad in ("../x", "/etc/passwd", "designs/../../x", "designs//x"):
        with pytest.raises(ValueError):
            storage.put(bad, b"")


# ---------- additions for the Upload and Preview screens ----------

def test_config_endpoint_gives_form_defaults(client):
    body = client.get("/config").json()
    assert body["design_width_mm"] == CONFIG.get("design.width_mm")
    assert body["fill_row_spacing_min_mm"] < body["fill_row_spacing_mm"] <= body["fill_row_spacing_max_mm"]
    assert "png" in body["allowed_types"]


def test_upload_reports_logo_bounds(client):
    body = upload(client, (SAMPLES / "thin_ring.png").read_bytes()).json()
    # Ring of radius 240 drawn 36 px thick, centred in a 600 px canvas: about 516 px square.
    assert abs(body["logo_width_px"] - 516) <= 4 and abs(body["logo_height_px"] - 516) <= 4


def test_preview_layers_account_for_every_stitch(client):
    design_id = upload(client, (SAMPLES / "mixed.png").read_bytes(), settings={"width_mm": 50}).json()["id"]
    body = client.post(f"/designs/{design_id}/preview").json()
    layers = body["layers"]
    assert [l["number"] for l in layers] == list(range(1, len(layers) + 1))
    assert sorted(l["type"] for l in layers) == ["fill", "fill", "satin", "satin"]
    assert sum(l["stitch_count"] for l in layers) == body["stats"]["stitch_count"]
    per_layer = {}
    for s in body["stitches"]:
        if s["command"] == "stitch":
            per_layer[s["layer"]] = per_layer.get(s["layer"], 0) + 1
        else:
            assert s["layer"] is None
    assert per_layer == {l["number"]: l["stitch_count"] for l in layers}
    assert body["stats"]["color_count"] == 1
    assert body["settings_used"] == {"width_mm": 50.0, "fill_row_spacing_mm": CONFIG.get("stitch.fill_row_spacing_mm")}


def test_preview_settings_change_the_stitches_and_are_saved(client):
    design_id = upload(client, (SAMPLES / "circle.png").read_bytes(), settings={"width_mm": 40}).json()["id"]
    default = client.post(f"/designs/{design_id}/preview").json()
    denser = client.post(f"/designs/{design_id}/preview", json={"fill_row_spacing_mm": 0.3}).json()
    assert denser["stats"]["stitch_count"] > default["stats"]["stitch_count"]
    wider = client.post(f"/designs/{design_id}/preview", json={"width_mm": 60}).json()
    assert abs(wider["stats"]["width_mm"] - 60) < 1
    assert client.get(f"/designs/{design_id}").json()["settings"] == {"width_mm": 60.0, "fill_row_spacing_mm": 0.3}


@pytest.mark.parametrize("body,phrase", [
    ({"fill_row_spacing_mm": 5}, "Fill density (row spacing) must be between 0.3 and 1 mm."),
    ({"width_mm": 5000}, "Design width must be at most 300 mm. Enter a smaller width."),
    ({"width_mm": 0}, "width_mm: Input should be greater than 0"),
    ({"colour": "red"}, "colour: Extra inputs are not permitted"),
])
def test_preview_rejects_bad_settings_plainly(client, body, phrase):
    design_id = upload(client, (SAMPLES / "circle.png").read_bytes()).json()["id"]
    response = client.post(f"/designs/{design_id}/preview", json=body)
    assert response.status_code == 422 and phrase in response.json()["error"]
