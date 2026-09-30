"""Machine file formats: which ones can be offered, and writing them.

A format is offered only if (1) it is listed in config output.formats, which may list a format
only after its round-trip test on every sample design passes (digitizer/tests/test_round_trip.py),
and (2) the same write-then-read round trip passes here, at runtime, on a real multi-colour design
(data/round_trip_check.dst: the bird sample, sewn with the test values). A round trip passes when
pyembroidery reads back the same needle positions and the same stitch / jump / trim /
colour-change sequence as the DST it was written from.
"""

from __future__ import annotations

import tempfile
from functools import lru_cache
from pathlib import Path

import pyembroidery

from digitizer.config import Config

# Formats pyembroidery can write that are worth checking, in the order they are shown.
CANDIDATES = {
    "dst": "DST (Tajima)",
    "pes": "PES (Brother)",
    "jef": "JEF (Janome)",
    "vp3": "VP3 (Husqvarna Viking / Pfaff)",
    "exp": "EXP (Melco)",
}
CHECK_DESIGN = Path(__file__).resolve().parent / "data" / "round_trip_check.dst"
_KEEP = {pyembroidery.STITCH, pyembroidery.JUMP, pyembroidery.TRIM, pyembroidery.COLOR_CHANGE}


def needle_path(pattern) -> list[tuple[int, int, int]]:
    """Stitches, jumps, trims and colour changes in order. Consecutive jumps are merged into one
    move, because formats may split or join long jumps without changing where the needle goes."""
    out: list[tuple[int, int, int]] = []
    for x, y, cmd in pattern.stitches:
        cmd &= pyembroidery.COMMAND_MASK
        if cmd not in _KEEP:
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


def _stitches(path: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    return [s for s in path if s[2] == pyembroidery.STITCH]


def write(dst: str | Path, out: str | Path, fmt: str) -> None:
    """Write the design in `dst` as `fmt` to `out`. Nothing is written unless the round trip passes."""
    problem = round_trip_problem(dst, fmt, out)
    if problem:
        Path(out).unlink(missing_ok=True)
        raise ValueError(f"{fmt.upper()} was not written: {problem}")


def round_trip_problem(dst: str | Path, fmt: str, out: str | Path | None = None) -> str | None:
    """Write `dst` as `fmt`, read it back, compare. None if it matches, else what went wrong."""
    original = pyembroidery.read_dst(str(dst))
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(out) if out else Path(tmp) / f"check.{fmt}"
        try:
            pyembroidery.write(pyembroidery.read_dst(str(dst)), str(path))  # write may change the pattern it gets
        except Exception as exc:  # noqa: BLE001 - any writer failure means the format is not usable
            return f"pyembroidery could not write it ({exc})"
        again = pyembroidery.read(str(path))
    if again is None:
        return "pyembroidery could not read it back"
    a, b = needle_path(original), needle_path(again)
    if _stitches(a) != _stitches(b):
        return "stitch positions changed when it was read back"
    if a != b:
        return "jumps, trims or colour changes changed when it was read back"
    return None


@lru_cache(maxsize=8)
def _checked(listed: tuple[str, ...]) -> tuple[tuple[str, ...], tuple[tuple[str, str], ...]]:
    available, unavailable = [], []
    for fmt, label in CANDIDATES.items():
        problem = round_trip_problem(CHECK_DESIGN, fmt)
        if problem:
            unavailable.append((fmt, f"{label} is not offered: its round-trip test fails ({problem})."))
        elif fmt not in listed:
            unavailable.append((fmt, f"{label} is not offered yet: it has not passed the round-trip test on "
                                     "every sample design."))
        else:
            available.append(fmt)
    return tuple(available), tuple(unavailable)


def offered(config: Config) -> tuple[list[str], dict[str, str]]:
    """(formats that can be exported, {format: why not} for the rest). Checked once per process."""
    available, unavailable = _checked(tuple(config.get("output.formats")))
    return list(available), dict(unavailable)
