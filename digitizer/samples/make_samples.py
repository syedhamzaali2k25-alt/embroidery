"""Generate the three sample logos used by the sample run and the tests.

Drawing coordinates here describe test pictures, not stitch settings.
  circle.png    solid circle, plus a few specks and a pinhole that cleaning must remove
  letter_a.png  a block letter A with a triangular hole
  two_shape.png a five-point star and a separate bar (non-convex + gap between shapes)
  bold_r.png    a bold letter R (strokes, a bowl with a hole, two junctions)
  thin_ring.png a thin ring (closed satin loop)
  mixed.png     a wide disc (fill), a thin swoosh arc (satin), a sharp chevron (satin, tight
                corner) and a lollipop: a disc joined to a thin stick (one shape, wide + narrow)

WIDTHS_MM is the design width each sample is digitized at in the sample run and tests.
Like the drawings, these are test fixtures, not product settings.
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
SIZE = 600
INK, PAPER = 0, 255


def blank() -> np.ndarray:
    return np.full((SIZE, SIZE), PAPER, dtype=np.uint8)


def circle() -> np.ndarray:
    img = blank()
    cv2.circle(img, (300, 300), 220, INK, -1, lineType=cv2.LINE_AA)
    for x, y in [(40, 40), (560, 80), (70, 540)]:  # ink specks outside
        cv2.circle(img, (x, y), 2, INK, -1)
    cv2.circle(img, (330, 260), 2, PAPER, -1)  # pinhole inside
    return img


def letter_a() -> np.ndarray:
    img = blank()
    outer = np.array([[260, 60], [340, 60], [520, 540], [420, 540], [380, 420],
                      [220, 420], [180, 540], [80, 540]], np.int32)
    hole = np.array([[300, 170], [350, 330], [250, 330]], np.int32)
    cv2.fillPoly(img, [outer], INK, lineType=cv2.LINE_AA)
    cv2.fillPoly(img, [hole], PAPER, lineType=cv2.LINE_AA)
    return img


def two_shape() -> np.ndarray:
    img = blank()
    cx, cy, r_out, r_in = 200, 300, 170, 70
    star = [
        (cx + (r_out if k % 2 == 0 else r_in) * math.sin(k * math.pi / 5),
         cy - (r_out if k % 2 == 0 else r_in) * math.cos(k * math.pi / 5))
        for k in range(10)
    ]
    cv2.fillPoly(img, [np.array(star, np.int32)], INK, lineType=cv2.LINE_AA)
    cv2.rectangle(img, (430, 130), (530, 470), INK, -1)
    return img


def bold_r() -> np.ndarray:
    img = blank()
    font, scale, thickness = cv2.FONT_HERSHEY_SIMPLEX, 16, 60
    (w, h), _ = cv2.getTextSize("R", font, scale, thickness)
    cv2.putText(img, "R", ((SIZE - w) // 2, (SIZE + h) // 2), font, scale, INK, thickness, cv2.LINE_AA)
    return img


def thin_ring() -> np.ndarray:
    img = blank()
    cv2.circle(img, (300, 300), 240, INK, 36, lineType=cv2.LINE_AA)
    return img


def mixed() -> np.ndarray:
    img = blank()
    cv2.circle(img, (190, 330), 120, INK, -1, lineType=cv2.LINE_AA)
    cv2.ellipse(img, (190, 330), (175, 165), 0, 200, 340, INK, 30, lineType=cv2.LINE_AA)
    cv2.polylines(img, [np.array([[400, 120], [470, 300], [540, 120]], np.int32)], False, INK, 30, cv2.LINE_AA)
    cv2.circle(img, (470, 430), 45, INK, -1, lineType=cv2.LINE_AA)
    cv2.line(img, (470, 470), (470, 570), INK, 18, cv2.LINE_AA)
    return img


SAMPLES = {
    "circle": circle,
    "letter_a": letter_a,
    "two_shape": two_shape,
    "bold_r": bold_r,
    "thin_ring": thin_ring,
    "mixed": mixed,
}
WIDTHS_MM = {"circle": 60, "letter_a": 60, "two_shape": 60, "bold_r": 18, "thin_ring": 40, "mixed": 50}


def main() -> None:
    for name, draw in SAMPLES.items():
        cv2.imwrite(str(HERE / f"{name}.png"), draw())
        print(f"wrote {HERE / name}.png")


if __name__ == "__main__":
    main()
