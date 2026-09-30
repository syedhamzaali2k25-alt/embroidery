"""Generate the sample logos used by the sample run and the tests.

Drawing coordinates here describe test pictures, not stitch settings.
  circle.png    solid circle, plus a few specks and a pinhole that cleaning must remove
  letter_a.png  a block letter A with a triangular hole
  two_shape.png a five-point star and a separate bar (non-convex + gap between shapes)
  bold_r.png    a bold letter R (strokes, a bowl with a hole, two junctions)
  thin_ring.png a thin ring (closed satin loop)
  mixed.png     a wide disc (fill), a thin swoosh arc (satin), a sharp chevron (satin, tight
                corner) and a lollipop: a disc joined to a thin stick (one shape, wide + narrow)
  junctions.png thin strokes meeting as a T, an X and a Y (satin junctions only)
  two_colour.png   a red disc and a blue bar that cuts into it, on white (two touching colours)
  three_colour.png a green square with an orange disc overlapping it and a navy bar: colours that
                   touch, so the anti-aliased border between them must not become a third shape
  gradient.png     a disc filled with a smooth top-to-bottom gradient (no flat colours at all)
  noisy_specks.png a black star with scattered dark specks, grain and JPEG artefacts
  bird.png         an original multi-colour bird on a branch (7 colours): navy body and head,
                   teal wing, orange belly, yellow beak, black eye with a white ring, brown branch,
                   green leaves. Drawn here; a stand-in for a real customer logo.

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
WHITE = (255, 255, 255)


def bgr(hex_colour: str) -> tuple[int, int, int]:
    """'#RRGGBB' -> OpenCV's (B, G, R)."""
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return b, g, r


def blank_colour(width: int = SIZE, height: int = SIZE) -> np.ndarray:
    return np.full((height, width, 3), 255, dtype=np.uint8)


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


def junctions() -> np.ndarray:
    img = blank()
    stroke = 30
    for a, b in [
        ((40, 100), (260, 100)), ((150, 100), (150, 300)),  # T
        ((340, 60), (560, 280)), ((560, 60), (340, 280)),  # X
        ((300, 580), (300, 470)), ((300, 470), (220, 370)), ((300, 470), (380, 370)),  # Y
    ]:
        cv2.line(img, a, b, INK, stroke, cv2.LINE_AA)
    return img


def two_colour() -> np.ndarray:
    img = blank_colour()
    cv2.circle(img, (210, 300), 150, bgr("#D62828"), -1, lineType=cv2.LINE_AA)
    cv2.rectangle(img, (330, 120), (430, 480), bgr("#1D4ED8"), -1, lineType=cv2.LINE_AA)  # overlaps the disc
    return img


def three_colour() -> np.ndarray:
    img = blank_colour()
    cv2.rectangle(img, (70, 90), (330, 350), bgr("#2E9E4F"), -1)
    cv2.circle(img, (330, 350), 120, bgr("#F28C28"), -1, lineType=cv2.LINE_AA)  # overlaps the square
    cv2.rectangle(img, (90, 500), (520, 550), bgr("#1F2A5A"), -1)
    return img


def gradient() -> np.ndarray:
    img = blank_colour()
    top, bottom = np.array(bgr("#FDE68A"), float), np.array(bgr("#6D28D9"), float)
    t = np.linspace(0, 1, SIZE)[:, None, None]
    ramp = (top * (1 - t) + bottom * t).astype(np.uint8) * np.ones((1, SIZE, 1), np.uint8)
    disc = np.zeros((SIZE, SIZE), np.uint8)
    cv2.circle(disc, (300, 300), 250, 255, -1, lineType=cv2.LINE_AA)
    a = (disc.astype(float) / 255)[:, :, None]
    return (ramp * a + img * (1 - a)).astype(np.uint8)


def noisy_specks() -> np.ndarray:
    rng = np.random.default_rng(7)  # fixed seed: the same picture every time
    img = blank()
    star = [(300 + (250 if k % 2 == 0 else 110) * math.sin(k * math.pi / 5),
             310 - (250 if k % 2 == 0 else 110) * math.cos(k * math.pi / 5)) for k in range(10)]
    cv2.fillPoly(img, [np.array(star, np.int32)], INK, lineType=cv2.LINE_AA)
    for _ in range(60):  # dark specks all over the paper
        x, y = (int(v) for v in rng.integers(10, SIZE - 10, 2))
        cv2.circle(img, (x, y), int(rng.integers(1, 4)), int(rng.integers(0, 90)), -1, lineType=cv2.LINE_AA)
    grain = rng.normal(0, 6, img.shape)
    img = np.clip(img + grain, 0, 255).astype(np.uint8)
    ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return cv2.imdecode(jpg, cv2.IMREAD_GRAYSCALE)


def bird() -> np.ndarray:
    img = blank_colour(800, 640)
    navy, teal, orange = bgr("#1E3A6E"), bgr("#2A9D8F"), bgr("#F4A261")
    yellow, black, brown, green = bgr("#F6C90E"), bgr("#111111"), bgr("#7A4A2A"), bgr("#5BAA46")
    aa = cv2.LINE_AA
    # branch and leaves first, the bird sits on top
    cv2.line(img, (90, 520), (720, 470), brown, 26, aa)
    for (cx, cy), angle in (((170, 470), -35), ((640, 430), 30), ((560, 540), 150)):
        cv2.ellipse(img, (cx, cy), (70, 26), angle, 0, 360, green, -1, aa)
    # tail
    cv2.fillPoly(img, [np.array([[250, 360], [90, 300], [120, 390], [240, 410]], np.int32)], navy, aa)
    # body, head, belly, wing
    cv2.ellipse(img, (380, 350), (175, 120), -12, 0, 360, navy, -1, aa)
    cv2.circle(img, (540, 230), 88, navy, -1, aa)
    cv2.ellipse(img, (440, 400), (120, 62), -12, 0, 360, orange, -1, aa)
    cv2.ellipse(img, (330, 320), (120, 58), -25, 0, 360, teal, -1, aa)
    # beak and eye
    cv2.fillPoly(img, [np.array([[615, 205], [700, 235], [612, 262]], np.int32)], yellow, aa)
    cv2.circle(img, (560, 215), 24, WHITE, -1, aa)
    cv2.circle(img, (563, 215), 13, black, -1, aa)
    # feet on the branch
    for x in (400, 450):
        cv2.line(img, (x, 455), (x + 8, 492), brown, 12, aa)
    return img


SAMPLES = {
    "circle": circle,
    "letter_a": letter_a,
    "two_shape": two_shape,
    "bold_r": bold_r,
    "thin_ring": thin_ring,
    "mixed": mixed,
    "junctions": junctions,
    "two_colour": two_colour,
    "three_colour": three_colour,
    "gradient": gradient,
    "noisy_specks": noisy_specks,
    "bird": bird,
}
WIDTHS_MM = {"circle": 60, "letter_a": 60, "two_shape": 60, "bold_r": 18, "thin_ring": 40, "mixed": 50, "junctions": 50,
             "two_colour": 60, "three_colour": 60, "gradient": 60, "noisy_specks": 60, "bird": 90}


def main() -> None:
    for name, draw in SAMPLES.items():
        cv2.imwrite(str(HERE / f"{name}.png"), draw())
        print(f"wrote {HERE / name}.png")


if __name__ == "__main__":
    main()
