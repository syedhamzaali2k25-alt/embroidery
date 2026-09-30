"""Colour quantization: an image -> a few flat colours, with the background found and removed.

How it works (every tolerance comes from digitizer.config):
  1. Convert to CIE Lab, where straight-line distance (Delta E, CIE76) follows how different two
     colours look.
  2. "Flat" pixels are those whose 8 neighbours are all within colour.same_colour_delta_e of them.
     Edge pixels (anti-aliasing blends between two colours, JPEG ringing) are left out of the fit,
     so they do not become colours of their own.
  3. Weighted k-means on the flat pixels' colours with k = colour.max_colours (+ 1 for the
     background when the image has no transparency). Seeding is deterministic (most common colour
     first, then the colour furthest from those chosen, weighted by how often it occurs), so the
     same image and config always give the same colours.
  4. Cluster centres closer than colour.same_colour_delta_e are merged: the result has at most
     colour.max_colours colours, fewer if the image has fewer.
  5. Flat pixels take the nearest colour. Edge pixels take the colour of a neighbouring flat
     region, choosing the one closest to their own colour, so blends join a real neighbour.
  6. Background: transparent pixels (alpha below an automatic Otsu split of the alpha channel),
     or else the colour that covers most of the image border.

Limitation: a stroke only a few pixels wide has no flat pixels of its own, so it does not become a
separate colour; it joins a neighbouring colour.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from digitizer.config import Config

_NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass(frozen=True)
class Colour:
    index: int  # position in Quantized.colours (0-based, most pixels first)
    hex: str  # "#RRGGBB", the mean of the image's own flat pixels of this colour
    lab: tuple[float, float, float]
    pixels: int  # pixels labelled with this colour


@dataclass
class Quantized:
    labels: np.ndarray  # H x W int32: colour index, or -1 for background
    colours: list[Colour]  # thread colours (background excluded), most pixels first
    background: str | None  # "#RRGGBB" of the removed background, or None if it was transparency

    @property
    def shape(self) -> tuple[int, int]:
        return self.labels.shape


def read_image(path: str | Path) -> np.ndarray:
    """BGR or BGRA uint8 image. Raises ValueError if it cannot be read."""
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"could not read image {path} (PNG and JPG are supported)")
    if image.dtype != np.uint8:  # 16-bit PNG
        image = (image / 257).astype(np.uint8)
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return image


def _to_lab(bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)


def _shift(a: np.ndarray, dy: int, dx: int, fill) -> np.ndarray:
    """a moved by (dy, dx); cells shifted in from outside get `fill`."""
    out = np.full_like(a, fill)
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def _flat(lab: np.ndarray, opaque: np.ndarray, tolerance: float) -> np.ndarray:
    """Opaque pixels whose 8 neighbours are opaque and within `tolerance` Delta E of them.
    Neighbours outside the image count as equal (the image border is not an edge)."""
    flat = opaque.copy()
    padded = np.pad(lab, ((1, 1), (1, 1), (0, 0)), mode="edge")
    padded_opaque = np.pad(opaque, 1, mode="edge")
    h, w = opaque.shape
    for dy, dx in _NEIGHBOURS:
        other = padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        near = np.linalg.norm(lab - other, axis=2) <= tolerance
        flat &= near & padded_opaque[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
    return flat


def _kmeans(points: np.ndarray, weights: np.ndarray, k: int) -> np.ndarray:
    """Weighted Lloyd's k-means with deterministic seeding. Returns the centres (k x 3)."""
    k = min(k, len(points))
    centres = [points[int(np.argmax(weights))]]
    while len(centres) < k:
        d2 = np.min(((points[:, None, :] - np.array(centres)[None]) ** 2).sum(axis=2), axis=1)
        score = weights * d2
        if score.max() <= 0:
            break
        centres.append(points[int(np.argmax(score))])
    return _refit(points, weights, np.array(centres, dtype=np.float64))


def _merge_close(points: np.ndarray, weights: np.ndarray, centres: np.ndarray, tolerance: float) -> np.ndarray:
    """Merge the closest pair of centres while any two are within `tolerance`, re-fitting after each."""
    while len(centres) > 1:
        d = np.linalg.norm(centres[:, None] - centres[None], axis=2)
        np.fill_diagonal(d, np.inf)
        i, j = np.unravel_index(int(np.argmin(d)), d.shape)
        if d[i, j] > tolerance:
            break
        assign = np.argmin(((points[:, None, :] - centres[None]) ** 2).sum(axis=2), axis=1)
        wi, wj = weights[assign == i].sum(), weights[assign == j].sum()
        merged = (centres[i] * wi + centres[j] * wj) / max(wi + wj, 1e-9)
        centres = np.vstack([np.delete(centres, [i, j], axis=0), merged])
        centres = _refit(points, weights, centres)
    return centres


def _refit(points: np.ndarray, weights: np.ndarray, centres: np.ndarray) -> np.ndarray:
    """Lloyd's iterations from the given centres; they stop when no point changes cluster
    (this always happens after finitely many steps)."""
    centres = centres.copy()
    assign = None
    while True:
        new = np.argmin(((points[:, None, :] - centres[None]) ** 2).sum(axis=2), axis=1)
        if assign is not None and np.array_equal(new, assign):
            return centres
        assign = new
        for c in range(len(centres)):
            mine = assign == c
            if mine.any():
                centres[c] = np.average(points[mine], axis=0, weights=weights[mine])


def _distinct(lab_pixels: np.ndarray):
    """Distinct colours at quarter-unit Lab resolution (far below a visible step):
    (colours K x 3, count of each, index of each pixel's colour)."""
    q = np.round(lab_pixels * 4).astype(np.int64) + np.array([0, 1024, 1024])  # all non-negative
    key = (q[:, 0] * 2048 + q[:, 1]) * 2048 + q[:, 2]
    keys, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
    colours = np.stack([keys // (2048 * 2048), (keys // 2048) % 2048 - 1024, keys % 2048 - 1024], axis=1) / 4.0
    return colours, counts, inverse.ravel()


def _nearest(lab_pixels: np.ndarray, centres: np.ndarray) -> np.ndarray:
    """Index of the nearest centre for each pixel (N x 3), computed once per distinct colour."""
    colours, _counts, inverse = _distinct(lab_pixels)
    return np.argmin(((colours[:, None, :] - centres[None]) ** 2).sum(axis=2), axis=1)[inverse]


def _propagate(labels: np.ndarray, lab: np.ndarray, centres: np.ndarray, open_: np.ndarray) -> np.ndarray:
    """Give each unlabelled pixel in `open_` the label of a labelled 8-neighbour, picking the
    neighbour colour closest to the pixel's own colour; repeat until nothing changes."""
    labels = labels.copy()
    while True:
        todo = open_ & (labels < 0)
        if not todo.any():
            return labels
        best = np.full(labels.shape, np.inf)
        choice = np.full(labels.shape, -1, dtype=np.int32)
        for dy, dx in _NEIGHBOURS:
            neighbour = _shift(labels, dy, dx, -1)
            ok = todo & (neighbour >= 0)
            if not ok.any():
                continue
            dist = np.linalg.norm(lab[ok] - centres[neighbour[ok]], axis=1)
            cur = best[ok]
            better = dist < cur
            idx = np.flatnonzero(ok)[better]
            best.flat[idx] = dist[better]
            choice.flat[idx] = neighbour[ok][better]
        if not (choice >= 0).any():
            return labels  # the rest cannot be reached from a flat region
        labels[choice >= 0] = choice[choice >= 0]


def quantize(image: np.ndarray, config: Config) -> Quantized:
    """Reduce a BGR/BGRA image to at most colour.max_colours flat thread colours plus background."""
    max_colours = config.get("colour.max_colours")
    tolerance = config.get("colour.same_colour_delta_e")
    bgr = image[:, :, :3]
    lab = _to_lab(bgr)
    transparent = image.shape[2] == 4 and image[:, :, 3].min() < 255
    if transparent:
        _, alpha = cv2.threshold(image[:, :, 3], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        opaque = alpha > 0
    else:
        opaque = np.ones(image.shape[:2], dtype=bool)
    if not opaque.any():
        raise ValueError("the image is fully transparent")

    flat = _flat(lab, opaque, tolerance)
    fit = flat if flat.any() else opaque  # a picture with no flat area at all: fit on every pixel
    # Weighted k-means over the distinct colours of the flat pixels.
    points, counts, _ = _distinct(lab[fit])
    weights = counts.astype(np.float64)
    k = max_colours + (0 if transparent else 1)
    centres = _merge_close(points, weights, _kmeans(points, weights, k), tolerance)

    labels = np.full(opaque.shape, -1, dtype=np.int32)
    labels[fit] = _nearest(lab[fit], centres)
    labels = _propagate(labels, lab, centres, opaque)
    rest = opaque & (labels < 0)
    if rest.any():
        labels[rest] = _nearest(lab[rest], centres)

    background = None
    if not transparent:
        border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        bg = int(np.bincount(border, minlength=len(centres)).argmax())
        background = _hex(bgr[(labels == bg) & fit].reshape(-1, 3) if ((labels == bg) & fit).any()
                          else bgr[labels == bg].reshape(-1, 3))
        labels[labels == bg] = -1

    # Renumber: most pixels first; each colour's hex is the mean of its own flat pixels.
    used = [c for c in range(len(centres)) if (labels == c).any()]
    sizes = {c: int((labels == c).sum()) for c in used}
    order = sorted(used, key=lambda c: (-sizes[c], tuple(centres[c])))
    remap = np.full(len(centres) + 1, -1, dtype=np.int32)
    colours = []
    for new, old in enumerate(order):
        remap[old] = new
        own = (labels == old) & fit
        pixels = bgr[own] if own.any() else bgr[labels == old]
        colours.append(Colour(new, _hex(pixels.reshape(-1, 3)), tuple(round(float(v), 2) for v in centres[old]),
                              sizes[old]))
    labels = remap[labels]  # -1 indexes the last slot, which is -1
    return Quantized(labels, colours, background)


def _hex(bgr_pixels: np.ndarray) -> str:
    b, g, r = (int(round(v)) for v in bgr_pixels.mean(axis=0))
    return f"#{r:02X}{g:02X}{b:02X}"
