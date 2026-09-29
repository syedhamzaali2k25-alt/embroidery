"""Loader for config/stitchbook.toml, the single file holding every product number.

Values still set to the placeholder marker raise instead of being returned,
so no code path can run on a number nobody chose.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

PLACEHOLDER = "__CHOOSE__"
CONFIG_ENV_VAR = "STITCHBOOK_CONFIG"
DEFAULT_PATH = Path(__file__).resolve().parents[3] / "config" / "stitchbook.toml"


class PlaceholderValueError(LookupError):
    """Raised when code asks for a config value that has not been chosen yet."""


@dataclass(frozen=True)
class Config:
    path: Path
    data: dict[str, Any]

    def get(self, dotted_key: str) -> Any:
        """Return a value such as "stitch.max_stitch_length_mm"."""
        node: Any = self.data
        for part in dotted_key.split("."):
            if not isinstance(node, dict) or part not in node:
                raise KeyError(f"{dotted_key!r} is not defined in {self.path}")
            node = node[part]
        if node == PLACEHOLDER:
            raise PlaceholderValueError(
                f"{dotted_key!r} is still a placeholder in {self.path}; choose a value first"
            )
        return node

    def placeholders(self) -> list[str]:
        """Every dotted key whose value is still the placeholder marker."""
        found: list[str] = []

        def walk(node: dict[str, Any], prefix: str) -> None:
            for key, value in node.items():
                path = f"{prefix}{key}"
                if isinstance(value, dict):
                    walk(value, path + ".")
                elif value == PLACEHOLDER:
                    found.append(path)

        walk(self.data, "")
        return found

    @property
    def app_name(self) -> str:
        return self.get("app.name")


@lru_cache(maxsize=None)
def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load the config from `path`, $STITCHBOOK_CONFIG, or the repo default."""
    resolved = Path(path or os.environ.get(CONFIG_ENV_VAR) or DEFAULT_PATH)
    with resolved.open("rb") as fh:
        return Config(path=resolved, data=tomllib.load(fh))
