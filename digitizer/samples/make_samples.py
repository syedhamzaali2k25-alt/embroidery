"""Generate the three sample logos used by the sample run and the tests.

Drawing coordinates here describe test pictures, not stitch settings.
  circle.png    solid circle, plus a few specks and a pinhole that cleaning must remove
  letter_a.png  a block letter A with a triangular hole
  two_shape.png a five-point star and a separate bar (non-convex + gap between shapes)
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


def main() -> None:
    for name, draw in {"circle": circle, "letter_a": letter_a, "two_shape": two_shape}.items():
        cv2.imwrite(str(HERE / f"{name}.png"), draw())
        print(f"wrote {HERE / name}.png")


if __name__ == "__main__":
    main()
