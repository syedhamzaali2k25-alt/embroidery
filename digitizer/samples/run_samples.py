"""Digitize every sample with the test-run values and print what the DST reads back as.

Outputs land in samples/out/<name>/ (out.dst, preview.png). Not for sewing as product
settings: see samples/README.md.
"""

from __future__ import annotations

from pathlib import Path

from make_samples import WIDTHS_MM

from digitizer.config import load_test_run_config
from digitizer.digitize import digitize

HERE = Path(__file__).resolve().parent


def main() -> None:
    config = load_test_run_config()
    for name, width in WIDTHS_MM.items():
        result = digitize(HERE / f"{name}.png", HERE / "out" / name, config, width)
        print(f"{name} ({width} mm): {result.summary()}")


if __name__ == "__main__":
    main()
