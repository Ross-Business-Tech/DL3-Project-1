"""Load KEY=VALUE pairs from .env files into os.environ (existing environment variables win).

Looks in dl3-lihtc-model/.env, then the repository root .env. Values are never printed or logged.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_env(paths: list[Path] | None = None) -> list[Path]:
    loaded = []
    for p in paths or [ROOT / ".env", ROOT.parent / ".env"]:
        if not p.is_file():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.removeprefix("export ").partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key, value)
        loaded.append(p)
    return loaded
