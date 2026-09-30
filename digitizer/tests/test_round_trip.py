"""Write-then-read round trip with pyembroidery for every format in output.formats.

CLAUDE.md: a format may be offered only after this passes for it. The test writes a real
digitized design in each format, reads it back and requires the same needle positions and
the same stitch / jump / trim / colour-change sequence.
"""

from __future__ import annotations

from pathlib import Path

import pyembroidery
import pytest

from digitizer.config import load_test_run_config
from digitizer.digitize import digitize
from digitizer.formats import CANDIDATES, CHECK_DESIGN, needle_path, offered, round_trip_problem

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
SAMPLE_CASES = [("mixed", 50), ("bold_r", 18)]
OFFERED_CASES = SAMPLE_CASES + [("bird", 90)]  # multi-colour: colour changes must survive too


def round_trip(fmt: str, sample: str, width: float, tmp_path: Path):
    """(needle path read from our DST, needle path after writing `fmt` and reading it back)."""
    digitize(SAMPLES / f"{sample}.png", tmp_path, CONFIG, width)
    dst = str(tmp_path / "out.dst")
    path = tmp_path / f"round.{fmt}"
    pyembroidery.write(pyembroidery.read_dst(dst), str(path))  # write may modify the pattern it is given
    again = pyembroidery.read(str(path))
    assert again is not None, f"pyembroidery could not read back its own {fmt.upper()}"
    return needle_path(pyembroidery.read_dst(dst)), needle_path(again)


def only_stitches(path):
    return [s for s in path if s[2] == pyembroidery.STITCH]


@pytest.mark.parametrize("fmt", CONFIG.get("output.formats"))
@pytest.mark.parametrize("sample,width", OFFERED_CASES)
def test_offered_formats_round_trip(fmt, sample, width, tmp_path):
    original, again = round_trip(fmt, sample, width, tmp_path)
    assert only_stitches(again) == only_stitches(original), f"{fmt.upper()} changed the stitch positions"
    assert again == original, f"{fmt.upper()} changed the jump/trim/colour-change sequence"


# Not offered: PES, JEF, VP3 and EXP. Found (sample designs and the runtime check design):
#   PES  moves stitch positions and adds a trim at every jump (and a stitch inside a jump on bold_r);
#   JEF  keeps every stitch, but the first jump comes back elsewhere and jumps and trims change;
#   VP3  keeps every stitch, but the first jump comes back as a stitch and jumps and trims are lost;
#   EXP  keeps every stitch, but some jumps come back at other positions.
# strict=True: the day one of them passes, its test fails and says so, and it can be added to
# output.formats.
NOT_OFFERED = [f for f in CANDIDATES if f not in CONFIG.get("output.formats")]


@pytest.mark.parametrize("fmt", NOT_OFFERED)
@pytest.mark.parametrize("sample,width", OFFERED_CASES)
@pytest.mark.xfail(strict=True, reason="its round trip changes the needle path (see the comment above)")
def test_formats_not_offered_still_fail_their_round_trip(fmt, sample, width, tmp_path):
    original, again = round_trip(fmt, sample, width, tmp_path)
    assert again == original


def test_only_formats_that_pass_are_offered_and_the_rest_say_why():
    available, unavailable = offered(CONFIG)
    assert available == ["dst"]
    assert set(unavailable) == {"pes", "jef", "vp3", "exp"}
    assert "stitch positions changed" in unavailable["pes"]
    for fmt in ("jef", "vp3", "exp"):
        assert "jumps, trims or colour changes changed" in unavailable[fmt]
    for fmt in available:
        assert round_trip_problem(CHECK_DESIGN, fmt) is None


def test_the_runtime_check_design_is_a_real_multi_colour_design():
    pattern = pyembroidery.read_dst(str(CHECK_DESIGN))
    commands = [c & pyembroidery.COMMAND_MASK for _x, _y, c in pattern.stitches]
    assert commands.count(pyembroidery.COLOR_CHANGE) >= 2
    assert commands.count(pyembroidery.JUMP) > 10 and commands.count(pyembroidery.STITCH) > 1000
