"""Stitchbook digitizer: the only place stitch logic lives.

The API and the worker import this package; they never re-implement it.
"""

from digitizer.config import Config, PlaceholderValueError, load_config

__all__ = ["Config", "PlaceholderValueError", "load_config"]
