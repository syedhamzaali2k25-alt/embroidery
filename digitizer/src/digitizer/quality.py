"""Image quality checks for uploads: warnings with a message saying what to fix.

These never reject an image; they tell the user why the stitch-out may look worse.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from digitizer.config import Config


@dataclass(frozen=True)
class QualityWarning:
    code: str  # "too_small", "low_contrast", "blurry_edges"
    message: str
    value: float
    threshold: float


def decode(data: bytes) -> np.ndarray | None:
    """Decode PNG/JPG bytes to a grey image (alpha, if any, is the logo). None if unreadable."""
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        return None
    if image.ndim == 3 and image.shape[2] == 4 and image[:, :, 3].min() < 255:
        return 255 - image[:, :, 3]  # transparent PNG: opaque = dark logo on light background
    if image.ndim == 3:
        return cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
    return image


def contrast(gray: np.ndarray) -> float:
    """Mean grey difference between the two classes of an automatic (Otsu) split."""
    threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark, light = gray[gray <= threshold], gray[gray > threshold]
    if not dark.size or not light.size:
        return 0.0
    return float(light.mean() - dark.mean())


def edge_sharpness(gray: np.ndarray) -> float:
    """Variance of the Laplacian after stretching grey levels to the full 0-255 range."""
    lo, hi = int(gray.min()), int(gray.max())
    if hi == lo:
        return 0.0
    stretched = ((gray.astype(np.float64) - lo) * (255.0 / (hi - lo))).astype(np.uint8)
    return float(cv2.Laplacian(stretched, cv2.CV_64F).var())


def check(gray: np.ndarray, config: Config) -> list[QualityWarning]:
    warnings: list[QualityWarning] = []
    long_side = max(gray.shape[:2])
    min_side = config.get("quality.min_long_side_px")
    if long_side < min_side:
        warnings.append(QualityWarning(
            "too_small",
            f"The image is only {long_side} px on its long side. Upload a version at least {min_side} px "
            "on the long side so edges and small details come out clean.",
            long_side, min_side))
    value, minimum = contrast(gray), config.get("quality.min_contrast")
    if value < minimum:
        warnings.append(QualityWarning(
            "low_contrast",
            "The logo and its background are too close in brightness. Use a dark logo on a plain light "
            "background (or a transparent PNG) so the shapes can be separated reliably.",
            round(value, 1), minimum))
    value, minimum = edge_sharpness(gray), config.get("quality.min_edge_sharpness")
    if value < minimum:
        warnings.append(QualityWarning(
            "blurry_edges",
            "The edges of the logo look blurry. Upload the original artwork (or a sharper, larger export) "
            "instead of a screenshot, photo or resized copy.",
            round(value, 1), minimum))
    return warnings
