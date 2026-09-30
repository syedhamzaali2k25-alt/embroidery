"""Record scripts/fixtures/editor.json (GET /designs/{id}/editor) from the real API for the bird
fixture design, so the screenshot audit and the editor browser tests need no server.
Run with the repo venv: .venv/bin/python web/scripts/make-editor-fixture.py  (npm run e2e also records it)"""

import json
import tempfile
from pathlib import Path

from digitizer.config import load_test_run_config
from fastapi.testclient import TestClient

from stitchbook_api.main import create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

web = Path(__file__).resolve().parents[1]
fixtures = web / "scripts" / "fixtures"
upload = json.loads((fixtures / "upload.json").read_text())
design = json.loads((fixtures / "design.json").read_text())
with tempfile.TemporaryDirectory() as tmp:
    settings = Settings("redis://unused", "digitize", None, tmp, False, "info")
    client = TestClient(create_app(load_test_run_config(), LocalDiskStorage(tmp), settings))
    image = (web.parent / "digitizer" / "samples" / "bird.png").read_bytes()
    created = client.post("/designs", files={"file": ("bird.png", image, "image/png")},
                          data={"settings": json.dumps({"width_mm": design["settings"]["width_mm"]})}).json()
    state = client.get(f"/designs/{created['id']}/editor").json()
state["id"] = state["shapes"]["id"] = upload["id"]
(fixtures / "editor.json").write_text(json.dumps(state))
print(f"wrote {fixtures / 'editor.json'}: {len(state['shapes']['shapes'])} shapes, {len(state['stitches'])} records")
