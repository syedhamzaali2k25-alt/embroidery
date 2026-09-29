"""Single-colour logo image -> fill-stitched DST + preview PNG.

Pipeline:
  1. load, threshold to black/white (Otsu, or the alpha channel if present), remove specks
  2. trace contours with OpenCV -> shapely polygons with holes
  3. scale to the configured design width (so all stitch spacing is in real millimetres)
  4. parallel scanline fill at the configured angle and row spacing
  5. order rows in a zigzag (nearest endpoint, sewn connections only inside the shape)
  6. split stitches longer than the max length, write DST with pyembroidery
  7. read the DST back and render the preview from what is actually in the file

All numbers come from digitizer.config. Only fill stitches: no satin, underlay,
pull compensation, lock stitches or colours yet.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pyembroidery
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

from digitizer.config import Config, load_config, load_test_run_config
from digitizer.readback import DstStats, dst_stats, render_preview

UNITS_PER_MM = 10  # pyembroidery / DST coordinates are in 0.1 mm; a unit conversion, not a setting.


# ---------- 1. image -> clean binary mask ----------

def load_mask(path: str | Path, min_speck_area_px: int) -> np.ndarray:
    """Return a uint8 mask, 255 = logo, 0 = background."""
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"could not read image {path} (PNG and JPG are supported)")

    if image.ndim == 3 and image.shape[2] == 4 and image[:, :, 3].min() < 255:
        # Transparent PNG: the alpha channel is the logo.
        _, mask = cv2.threshold(image[:, :, 3], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    else:
        gray = image if image.ndim == 2 else cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        # Dark logo on a light background.
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    mask = _drop_small_components(mask, min_speck_area_px)  # specks of ink
    mask = 255 - _drop_small_components(255 - mask, min_speck_area_px)  # pinholes in the logo
    if not mask.any():
        raise ValueError("no logo found after thresholding and speck removal")
    return mask


def _drop_small_components(mask: np.ndarray, min_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return np.where(keep[labels], 255, 0).astype(np.uint8)


# ---------- 2. mask -> polygons with holes ----------

def mask_to_polygons(mask: np.ndarray) -> list[Polygon]:
    """Outer contours become shells, their child contours become holes (pixel coordinates)."""
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]
    shapes = []
    for i, (_next, _prev, first_child, parent) in enumerate(hierarchy):
        if parent != -1 or len(contours[i]) < 3:
            continue
        shell = contours[i][:, 0, :].astype(float)
        holes = []
        child = first_child
        while child != -1:
            if len(contours[child]) >= 3:
                holes.append(contours[child][:, 0, :].astype(float))
            child = hierarchy[child][0]
        polygon = Polygon(shell, holes).buffer(0)  # repair self-touching pixel outlines
        shapes.extend(_polygons(polygon))
    return shapes


def _polygons(geometry) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry] if not geometry.is_empty else []
    if isinstance(geometry, MultiPolygon):
        return [g for g in geometry.geoms if not g.is_empty]
    return []


# ---------- 3. scale to millimetres ----------

def scale_to_width(polygons: list[Polygon], width_mm: float) -> tuple[list[Polygon], float]:
    """Scale so the combined bounding box is width_mm wide, centred on (0, 0). Returns mm per pixel."""
    min_x, min_y, max_x, max_y = unary_union(polygons).bounds
    mm_per_px = width_mm / (max_x - min_x)
    cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
    scaled = [
        affinity.scale(affinity.translate(p, -cx, -cy), mm_per_px, mm_per_px, origin=(0, 0))
        for p in polygons
    ]
    return scaled, mm_per_px


# ---------- 4. scanline fill ----------

@dataclass
class Row:
    shape: int
    index: int
    start: tuple[float, float]
    end: tuple[float, float]


def fill_rows(polygon: Polygon, shape: int, angle_deg: float, spacing_mm: float, min_len_mm: float) -> list[Row]:
    """Parallel rows across the polygon at angle_deg, spacing_mm apart (holes stay empty)."""
    rotated = affinity.rotate(polygon, -angle_deg, origin=(0, 0))
    min_x, min_y, max_x, max_y = rotated.bounds
    rows: list[Row] = []
    y = min_y + spacing_mm / 2
    index = 0
    while y < max_y:
        scan = LineString([(min_x - 1, y), (max_x + 1, y)])
        hit = rotated.intersection(scan)
        pieces = getattr(hit, "geoms", [hit])
        for piece in pieces:
            if not isinstance(piece, LineString) or piece.length < min_len_mm:
                continue
            back = affinity.rotate(piece, angle_deg, origin=(0, 0))
            (x0, y0), (x1, y1) = back.coords[0], back.coords[-1]
            rows.append(Row(shape, index, (x0, y0), (x1, y1)))
        y += spacing_mm
        index += 1
    return rows


# ---------- 5. zigzag ordering ----------

@dataclass
class Move:
    kind: str  # "stitch" or "jump"
    to: tuple[float, float]


def order_rows(rows: list[Row], polygons: list[Polygon], jump_threshold_mm: float, tolerance_mm: float) -> list[Move]:
    """Walk rows boustrophedon-style: from the current needle position take the nearest row end
    in the same shape on an adjacent scanline if it can be reached by a short in-shape stitch;
    otherwise jump to the nearest unsewn row end anywhere."""
    if not rows:
        return []
    inside = [p.buffer(tolerance_mm) for p in polygons]
    by_key: dict[tuple[int, int], list[int]] = {}
    for i, row in enumerate(rows):
        by_key.setdefault((row.shape, row.index), []).append(i)

    remaining = set(range(len(rows)))
    moves: list[Move] = []
    current_row = min(remaining, key=lambda i: (rows[i].shape, rows[i].index, rows[i].start))
    pos = None

    while True:
        row = rows[current_row]
        remaining.discard(current_row)
        start, end = _orient(row, pos)
        if pos is None:
            moves.append(Move("jump", start))
        elif not _sewable(pos, start, inside[row.shape], jump_threshold_mm):
            moves.append(Move("jump", start))
        else:
            moves.append(Move("stitch", start))
        moves.append(Move("stitch", end))
        pos = end
        if not remaining:
            return moves

        neighbours = [
            i
            for step in (1, -1)
            for i in by_key.get((row.shape, row.index + step), [])
            if i in remaining
        ]
        reachable = [
            i for i in neighbours
            if _sewable(pos, _nearest_end(rows[i], pos), inside[row.shape], jump_threshold_mm)
        ]
        pool = reachable or list(remaining)
        current_row = min(pool, key=lambda i: _dist(pos, _nearest_end(rows[i], pos)))


def _orient(row: Row, pos):
    if pos is not None and _dist(pos, row.end) < _dist(pos, row.start):
        return row.end, row.start
    return row.start, row.end


def _nearest_end(row: Row, pos):
    return _orient(row, pos)[0]


def _sewable(a, b, area: Polygon, max_len: float) -> bool:
    return _dist(a, b) <= max_len and area.contains(LineString([a, b]))


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ---------- 6. split long stitches and build the pattern ----------

def build_pattern(moves: list[Move], max_stitch_mm: float, trim_threshold_mm: float) -> pyembroidery.EmbPattern:
    # The file stores whole 0.1 mm units; rounding both ends can lengthen a stitch by up to
    # one unit diagonal, so split against the limit minus that amount.
    split_at = max_stitch_mm - math.sqrt(2) / UNITS_PER_MM
    pattern = pyembroidery.EmbPattern()
    pos = None
    for move in moves:
        if move.kind == "jump":
            if pos is not None and _dist(pos, move.to) > trim_threshold_mm:
                pattern.add_command(pyembroidery.TRIM)
            _add(pattern, pyembroidery.JUMP, move.to)
            pos = move.to
            continue
        for point in _split(pos, move.to, split_at):
            _add(pattern, pyembroidery.STITCH, point)
        pos = move.to
    pattern.add_command(pyembroidery.END)
    return pattern


def _split(a, b, max_len: float):
    """Points from a (exclusive) to b (inclusive), evenly spaced, no step longer than max_len."""
    if a is None:
        return [b]
    pieces = max(1, math.ceil(_dist(a, b) / max_len))
    return [(a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces) for k in range(1, pieces + 1)]


def _add(pattern, command, point_mm):
    pattern.add_stitch_absolute(command, point_mm[0] * UNITS_PER_MM, point_mm[1] * UNITS_PER_MM)


# ---------- entry point ----------

def digitize(image_path: str | Path, out_dir: str | Path, config: Config | None = None) -> DstStats:
    """Write out.dst and preview.png into out_dir and return stats read back from the DST."""
    config = config or load_config()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    mask = load_mask(image_path, config.get("image.min_speck_area_px"))
    polygons_px = mask_to_polygons(mask)
    polygons, mm_per_px = scale_to_width(polygons_px, config.get("design.width_mm"))

    angle = config.get("stitch.fill_angle_deg")
    spacing = config.get("stitch.fill_row_spacing_mm")
    min_len = config.get("stitch.min_stitch_length_mm")
    rows = [r for i, p in enumerate(polygons) for r in fill_rows(p, i, angle, spacing, min_len)]

    # Traced outlines are pixel staircases; allow one source pixel when testing "inside the shape".
    moves = order_rows(rows, polygons, config.get("stitch.jump_threshold_mm"), mm_per_px)
    pattern = build_pattern(moves, config.get("stitch.max_stitch_length_mm"), config.get("stitch.trim_threshold_mm"))

    dst_path = out_dir / "out.dst"
    pyembroidery.write_dst(pattern, str(dst_path))
    stats = dst_stats(dst_path)
    render_preview(dst_path, out_dir / "preview.png", config)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Digitize a single-colour logo into out.dst + preview.png")
    parser.add_argument("image", help="PNG or JPG logo, dark on light or transparent background")
    parser.add_argument("--out", default=".", help="output folder (default: current folder)")
    parser.add_argument(
        "--test-run-values",
        action="store_true",
        help="use TEST_RUN_OVERRIDES from config.py for unchosen values (not for sewing)",
    )
    args = parser.parse_args()
    config = load_test_run_config() if args.test_run_values else load_config()
    print(digitize(args.image, args.out, config).summary())


if __name__ == "__main__":
    main()
