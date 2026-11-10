import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_every_source_file_is_tracked_by_git():
    """Guards against .gitignore patterns hiding code (an unanchored 'review/' once hid src/review/)."""
    try:
        ignored = subprocess.run(["git", "check-ignore", "--no-index", "--stdin"], cwd=ROOT, capture_output=True,
                                 text=True, input="\n".join(str(p.relative_to(ROOT)) for p in _sources()))
    except FileNotFoundError:
        pytest.skip("git not installed")
    if ignored.returncode not in (0, 1):
        pytest.skip("not a git checkout")
    assert ignored.stdout.strip() == "", f"ignored by .gitignore: {ignored.stdout}"


def _sources():
    for pattern in ("src/**/*.py", "src/**/*.md", "src/**/*.sql", "src/**/*.j2", "config/*", "tests/*.py", "*.py"):
        for p in ROOT.glob(pattern):
            if "__pycache__" not in p.parts:
                yield p
