"""Upload validation: file type from the bytes themselves, size and pixel limits, quality warnings.

Every rejection carries a plain message that says what to fix.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from digitizer import quality
from digitizer.config import Config
from PIL import Image

# Signatures of formats people often try, so the error can name them.
_OTHER_FORMATS = [
    (b"GIF87a", "a GIF"), (b"GIF89a", "a GIF"), (b"%PDF", "a PDF"),
    (b"BM", "a BMP"), (b"II*\x00", "a TIFF"), (b"MM\x00*", "a TIFF"),
]


class UploadRejected(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Upload:
    type: str  # "png", "jpg" or "svg"
    width_px: int | None
    height_px: int | None
    warnings: list[quality.QualityWarning] = field(default_factory=list)


def _mb(n: int) -> str:
    return f"{n / 1_000_000:.1f} MB"


def detect_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    head = data[:1024].lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"<") and b"<svg" in data[:4096]:
        return "svg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        raise UploadRejected(415, "This is a WebP image. Upload the logo as PNG, JPG or SVG instead.")
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        raise UploadRejected(415, "This is a HEIC photo. Upload the logo as PNG, JPG or SVG instead.")
    for signature, name in _OTHER_FORMATS:
        if data.startswith(signature):
            raise UploadRejected(415, f"This is {name} file. Upload the logo as PNG, JPG or SVG instead.")
    raise UploadRejected(415, "This file is not a PNG, JPG or SVG image. Export your logo in one of those formats "
                              "and upload it again.")


def _svg_size(data: bytes) -> tuple[int | None, int | None]:
    text = data.decode("utf-8", errors="strict")
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise UploadRejected(422, "SVG files with DOCTYPE or ENTITY declarations are not accepted. Re-export the "
                                  "logo as a plain SVG (or PNG) and upload again.")
    root = ET.fromstring(text)
    if not root.tag.endswith("svg"):
        raise ValueError("root element is not <svg>")

    def number(value: str | None) -> float | None:
        m = re.fullmatch(r"\s*([0-9.]+)\s*(px)?\s*", value or "")
        return float(m.group(1)) if m else None

    w, h = number(root.get("width")), number(root.get("height"))
    if (w is None or h is None) and root.get("viewBox"):
        parts = re.split(r"[\s,]+", root.get("viewBox").strip())
        if len(parts) == 4:
            w, h = float(parts[2]), float(parts[3])
    return (round(w) if w else None), (round(h) if h else None)


def inspect(data: bytes, config: Config) -> Upload:
    """Validate an upload and return its type, size and quality warnings, or raise UploadRejected."""
    max_bytes = config.get("input.max_upload_bytes")
    max_side = config.get("input.max_image_side_px")
    if not data:
        raise UploadRejected(422, "The file is empty. Choose your logo file and upload it again.")
    if len(data) > max_bytes:
        raise UploadRejected(413, f"The file is larger than the {_mb(max_bytes)} limit. Export a smaller file "
                                  "(fewer pixels, or PNG with fewer colours) and upload it again.")

    kind = detect_type(data)
    allowed = {"jpg" if t == "jpeg" else t for t in config.get("input.allowed_types")}
    if kind not in allowed:
        raise UploadRejected(415, f"{kind.upper()} uploads are switched off. Upload the logo in another format.")

    if kind == "svg":
        try:
            width, height = _svg_size(data)
        except UploadRejected:
            raise
        except (ValueError, ET.ParseError, UnicodeDecodeError):
            raise UploadRejected(422, "The SVG file could not be read; it may be damaged or not really an SVG. "
                                      "Re-export it from your design program and upload again.") from None
        return Upload("svg", width, height)  # vector: pixel-based quality checks do not apply

    try:
        with Image.open(io.BytesIO(data)) as im:  # reads the header only
            width, height = im.size
    except Exception:  # noqa: BLE001 - any decoder failure means the same thing to the user
        raise UploadRejected(422, "The image could not be read; it may be damaged. Re-export it and upload "
                                  "again.") from None
    if max(width, height) > max_side:
        raise UploadRejected(422, f"The image is {width} x {height} px; the limit is {max_side} px on the long "
                                  "side. Resize it and upload again.")
    gray = quality.decode(data)
    if gray is None:
        raise UploadRejected(422, "The image could not be read; it may be damaged. Re-export it and upload again.")
    return Upload(kind, width, height, quality.check(gray, config))
