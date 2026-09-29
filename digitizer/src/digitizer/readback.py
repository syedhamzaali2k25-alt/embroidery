"""Read a DST back with pyembroidery: stats for reports/tests and the preview image."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
import pyembroidery  # noqa: E402

from digitizer.config import Config  # noqa: E402

UNITS_PER_MM = 10  # DST coordinates are in 0.1 mm.


@dataclass(frozen=True)
class DstStats:
    stitch_count: int
    jump_count: int
    trim_count: int
    width_mm: float
    height_mm: float
    longest_stitch_mm: float
    longest_jump_mm: float

    def summary(self) -> str:
        return (
            f"stitches={self.stitch_count}  size={self.width_mm:.1f} x {self.height_mm:.1f} mm  "
            f"longest stitch={self.longest_stitch_mm:.2f} mm  "
            f"jumps={self.jump_count} (longest {self.longest_jump_mm:.2f} mm)  trims={self.trim_count}"
        )


def segments(pattern):
    """Yield (command, x0, y0, x1, y1) for every needle move, in file units."""
    prev = None
    for x, y, cmd in pattern.stitches:
        cmd &= pyembroidery.COMMAND_MASK
        if cmd in (pyembroidery.STITCH, pyembroidery.JUMP):
            if prev is not None:
                yield cmd, prev[0], prev[1], x, y
            prev = (x, y)


def dst_stats(path: str | Path) -> DstStats:
    pattern = pyembroidery.read_dst(str(path))
    stitch_points = [(x, y) for x, y, c in pattern.stitches if c & pyembroidery.COMMAND_MASK == pyembroidery.STITCH]
    longest = {pyembroidery.STITCH: 0.0, pyembroidery.JUMP: 0.0}
    jumps = 0
    for cmd, x0, y0, x1, y1 in segments(pattern):
        longest[cmd] = max(longest[cmd], math.hypot(x1 - x0, y1 - y0))
        jumps += cmd == pyembroidery.JUMP
    xs = [p[0] for p in stitch_points] or [0]
    ys = [p[1] for p in stitch_points] or [0]
    return DstStats(
        stitch_count=len(stitch_points),
        jump_count=jumps,
        trim_count=pattern.count_stitch_commands(pyembroidery.TRIM),
        width_mm=(max(xs) - min(xs)) / UNITS_PER_MM,
        height_mm=(max(ys) - min(ys)) / UNITS_PER_MM,
        longest_stitch_mm=longest[pyembroidery.STITCH] / UNITS_PER_MM,
        longest_jump_mm=longest[pyembroidery.JUMP] / UNITS_PER_MM,
    )


def render_preview(dst_path: str | Path, png_path: str | Path, config: Config) -> None:
    """Draw every stitch (solid) and jump (dashed) exactly as stored in the DST."""
    pattern = pyembroidery.read_dst(str(dst_path))
    min_x, min_y, max_x, max_y = pattern.bounds()
    w, h = max(max_x - min_x, 1), max(max_y - min_y, 1)
    margin = config.get("preview.margin_fraction") * max(w, h)
    width_in = config.get("preview.width_in")

    fig = plt.figure(figsize=(width_in, width_in * (h + 2 * margin) / (w + 2 * margin)))
    ax = fig.add_axes([0, 0, 1, 1])
    lines = {pyembroidery.STITCH: [], pyembroidery.JUMP: []}
    for cmd, x0, y0, x1, y1 in segments(pattern):
        lines[cmd].append([(x0, y0), (x1, y1)])
    dash = tuple(config.get("preview.jump_dash_pt"))
    ax.add_collection(LineCollection(lines[pyembroidery.JUMP], colors=config.get("preview.jump_color"),
                                     linewidths=config.get("preview.jump_line_width_pt"), linestyles=[(0, dash)]))
    ax.add_collection(LineCollection(lines[pyembroidery.STITCH], colors=config.get("preview.stitch_color"),
                                     linewidths=config.get("preview.stitch_line_width_pt"), capstyle="round"))
    ax.set_xlim(min_x - margin, max_x + margin)
    ax.set_ylim(max_y + margin, min_y - margin)  # file y grows downward, like the source image
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(str(png_path), dpi=config.get("preview.dpi"), facecolor="white")
    plt.close(fig)


def main() -> None:
    import sys

    for path in sys.argv[1:]:
        print(f"{path}: {dst_stats(path).summary()}")


if __name__ == "__main__":
    main()
