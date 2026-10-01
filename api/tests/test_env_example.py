""".env.example lists every environment variable the code reads, all with empty values, and .env
is gitignored."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [*ROOT.glob("api/src/**/*.py"), *ROOT.glob("worker/src/**/*.py"), *ROOT.glob("digitizer/src/**/*.py"),
           *ROOT.glob("web/src/**/*.ts"), *ROOT.glob("web/src/**/*.tsx"), ROOT / "web" / "vite.config.ts", ROOT / "Makefile"]
READS = [
    re.compile(r"os\.environ(?:\.get)?\(\s*\"([A-Z][A-Z0-9_]+)\""),  # os.environ.get("X")
    re.compile(r"import\.meta\.env\.(VITE_[A-Z0-9_]+)"),            # Vite: only VITE_ names reach the browser
    # loadEnv(...) in vite.config.ts (not import.meta.env.STITCHBOOK_*: constants it defines)
    re.compile(r"(?<!meta\.)\b(?:env|supabase)\.((?:STITCHBOOK|SUPABASE)_[A-Z0-9_]+)"),
    re.compile(r"\$\((API_PORT|WEB_PORT)\)"),                        # Makefile
]


def example() -> dict[str, str]:
    pairs = {}
    for line in (ROOT / ".env.example").read_text().splitlines():
        if line and not line.startswith("#"):
            key, _, value = line.partition("=")
            pairs[key] = value
    return pairs


def test_every_variable_the_code_reads_is_in_env_example_with_an_empty_value():
    read = set()
    for path in SOURCES:
        text = path.read_text()
        for pattern in READS:
            read.update(pattern.findall(text))
    listed = example()
    assert read, "the scan found no variables at all"
    assert sorted(read - set(listed)) == [], "read by the code but missing from .env.example"
    assert {k: v for k, v in listed.items() if v} == {}, ".env.example values must be empty"
    assert {"SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "VITE_GOOGLE_CLIENT_ID"} <= set(listed)
    assert "VITE_GOOGLE_CLIENT_ID" in read, "the web app reads the Google client ID"


def test_env_is_gitignored_and_not_committed():
    assert subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=ROOT).returncode == 0
    tracked = subprocess.run(["git", "ls-files", ".env"], cwd=ROOT, capture_output=True, text=True).stdout
    assert tracked.strip() == ""


FAKES = ("sb_secret_must_never_ship", "GOCSPX-made-up-test-secret", "sb_secret_test_value_123")


def test_no_google_client_secret_or_supabase_secret_key_in_the_repo():
    """The Google client secret lives only in the Supabase dashboard; no tracked file holds one
    (GOCSPX-...), nor a Supabase secret key (sb_secret_...)."""
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True).stdout.split("\0")
    secret = re.compile(r"GOCSPX-[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{10,}")
    found = []
    for name in filter(None, files):
        path = ROOT / name
        if path.suffix.lower() in {".png", ".jpg", ".dst", ".pes", ".woff2", ".ico"} or not path.is_file():
            continue
        text = path.read_text(errors="ignore")
        for fake in FAKES:  # made-up values the build tests plant on purpose
            text = text.replace(fake, "")
        if secret.search(text):
            found.append(name)
    assert found == []
