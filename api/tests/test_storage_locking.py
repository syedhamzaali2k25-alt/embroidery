"""Windows file locks (PermissionError, WinError 32 on preview.png.tmp): every write has its own
temporary file, moving it into place is retried, and two previews of one design never write
its files at the same time."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from digitizer.config import load_test_run_config
from fastapi.testclient import TestClient

from stitchbook_api import storage as storage_module
from stitchbook_api.main import create_app
from stitchbook_api.settings import Settings
from stitchbook_api.storage import LocalDiskStorage

SAMPLES = Path(__file__).resolve().parents[2] / "digitizer" / "samples"
CONFIG = load_test_run_config()


class WatchedStorage(LocalDiskStorage):
    """Counts how many writes to a design's preview.png are in progress at once."""

    def __init__(self, root):
        super().__init__(root, CONFIG.get("storage.replace_attempts"), CONFIG.get("storage.replace_retry_s"))
        self.active = 0
        self.most = 0
        self.guard = threading.Lock()

    def put(self, key, data):
        if not key.endswith("preview.png"):
            return super().put(key, data)
        with self.guard:
            self.active += 1
            self.most = max(self.most, self.active)
        try:
            time.sleep(0.2)  # hold the write open long enough for a second request to collide
            return super().put(key, data)
        finally:
            with self.guard:
                self.active -= 1


def test_two_previews_of_one_design_both_succeed_one_after_the_other(tmp_path):
    storage = WatchedStorage(tmp_path / "store")
    settings = Settings("redis://unused", "digitize", None, str(tmp_path / "store"), False, "info")
    client = TestClient(create_app(CONFIG, storage, settings))
    body = (SAMPLES / "two_colour.png").read_bytes()
    design_id = client.post("/designs", files={"file": ("two.png", body, "image/png")},
                            data={"settings": json.dumps({"width_mm": 60})}).json()["id"]
    results = []

    def preview():
        results.append(client.post(f"/designs/{design_id}/preview"))

    threads = [threading.Thread(target=preview) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.status_code for r in results] == [200, 200]
    assert results[0].json()["stats"] == results[1].json()["stats"]
    assert storage.most == 1, "two previews wrote the design's files at the same time"
    assert not list((tmp_path / "store").rglob("*.tmp"))


def test_a_locked_target_is_retried_until_it_is_free(tmp_path, monkeypatch):
    real_replace = storage_module.os.replace
    calls = []

    def busy_twice(src, dst):
        calls.append(Path(src).name)
        if len(calls) <= 2:
            raise PermissionError(32, "The process cannot access the file because it is being used by another process")
        return real_replace(src, dst)

    monkeypatch.setattr(storage_module.os, "replace", busy_twice)
    store = LocalDiskStorage(tmp_path, CONFIG.get("storage.replace_attempts"), CONFIG.get("storage.replace_retry_s"))
    started = time.monotonic()
    store.put("designs/abc/preview.png", b"png")
    assert store.get("designs/abc/preview.png") == b"png"
    assert len(calls) == 3 and len(set(calls)) == 1  # the same temp file, moved on the third try
    assert time.monotonic() - started >= 2 * CONFIG.get("storage.replace_retry_s")
    assert not list(tmp_path.rglob("*.tmp"))


def test_a_target_that_stays_locked_fails_after_the_last_try_and_leaves_no_temp_file(tmp_path, monkeypatch):
    calls = []

    def always_busy(src, dst):
        calls.append(src)
        raise PermissionError(32, "in use")

    monkeypatch.setattr(storage_module.os, "replace", always_busy)
    store = LocalDiskStorage(tmp_path, CONFIG.get("storage.replace_attempts"), CONFIG.get("storage.replace_retry_s"))
    with pytest.raises(PermissionError):
        store.put("designs/abc/preview.png", b"png")
    assert len(calls) == CONFIG.get("storage.replace_attempts")
    assert not list(tmp_path.rglob("*.tmp"))


def test_every_write_uses_its_own_temp_file(tmp_path, monkeypatch):
    real_replace = storage_module.os.replace
    names = []
    monkeypatch.setattr(storage_module.os, "replace", lambda src, dst: (names.append(Path(src).name), real_replace(src, dst)))
    store = LocalDiskStorage(tmp_path)
    for _ in range(3):
        store.put("designs/abc/preview.png", b"x")
    assert len(set(names)) == 3 and all(n.startswith("preview.png.") and n.endswith(".tmp") for n in names)
