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

SAMPLES = Path(__file__).resolve().parents[1] / "samples"
CONFIG = load_test_run_config()
KEEP = {pyembroidery.STITCH, pyembroidery.JUMP, pyembroidery.TRIM, pyembroidery.COLOR_CHANGE}


def needle_path(pattern) -> list[tuple[int, int, int]]:
    """Stitches, jumps and trims in order. Consecutive jumps are merged into one move, because
    formats may split or join long jumps without changing where the needle goes."""
    out: list[tuple[int, int, int]] = []
    for x, y, cmd in pattern.stitches:
        cmd &= pyembroidery.COMMAND_MASK
        if cmd not in KEEP:
            continue
        if cmd == pyembroidery.COLOR_CHANGE:
            out.append((0, 0, cmd))
            continue
        if cmd == pyembroidery.TRIM:
            if not out or out[-1][2] != pyembroidery.TRIM:
                out.append((0, 0, cmd))
            continue
        if cmd == pyembroidery.JUMP and out and out[-1][2] == pyembroidery.JUMP:
            out[-1] = (round(x), round(y), cmd)
            continue
        out.append((round(x), round(y), cmd))
    return out


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


# PES is not offered yet. Found so far: every jump comes back with a trim added, and on bold_r
# one jump comes back with an extra stitch in the middle of it. strict=True: the day PES starts
# passing, this test fails and says so, and 'pes' can be added to output.formats.
@pytest.mark.xfail(strict=True, reason="PES round trip adds trims at jumps (and a stitch inside a jump on bold_r)")
@pytest.mark.parametrize("sample,width", SAMPLE_CASES)
def test_pes_keeps_jumps_and_trims(sample, width, tmp_path):
    original, again = round_trip("pes", sample, width, tmp_path)
    assert again == original
