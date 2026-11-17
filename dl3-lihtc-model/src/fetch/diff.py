"""Change detection between snapshots. Reports changed source text only, not interpretation."""
from __future__ import annotations

import difflib
import re
from pathlib import Path

from bs4 import BeautifulSoup

from .archive import latest_snapshot


def html_to_text(raw: bytes) -> str:
    """Visible text only; scripts, styles, and nav chrome removed so layout churn is not a 'change'."""
    soup = BeautifulSoup(raw, "lxml")
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header", "form", "svg"]):
        tag.decompose()
    text = soup.get_text("\n")
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def pdf_to_pages(raw: bytes) -> list[str]:
    import pymupdf
    with pymupdf.open(stream=raw, filetype="pdf") as doc:
        return [page.get_text() for page in doc]


def extract_text(raw: bytes, content_type: str | None) -> str | None:
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct == "text/html":
        return html_to_text(raw)
    if ct == "application/pdf":
        return "\n".join(f"[page {i}]\n{t.strip()}" for i, t in enumerate(pdf_to_pages(raw), 1))
    if ct in ("text/csv", "text/plain"):
        return raw.decode("utf-8", "replace")
    return None  # binary formats: hash comparison only


def text_diff(old: str, new: str, context: int = 1, max_lines: int = 200) -> dict:
    old_l, new_l = old.splitlines(), new.splitlines()
    added = [l for l in difflib.ndiff(old_l, new_l) if l.startswith("+ ")]
    removed = [l for l in difflib.ndiff(old_l, new_l) if l.startswith("- ")]
    unified = list(difflib.unified_diff(old_l, new_l, "previous", "current", n=context, lineterm=""))
    return {"added_lines": len(added), "removed_lines": len(removed), "unified": unified[:max_lines],
            "truncated": len(unified) > max_lines}


def compare_latest(conn, archive_root: str | Path, source_id: str) -> dict:
    """Compare the most recent snapshot of a source with its prior different version."""
    cur = latest_snapshot(conn, source_id)
    if cur is None:
        return {"source_id": source_id, "status": "no_snapshot"}
    return compare_latest_for(conn, archive_root, cur)


def compare_latest_for(conn, archive_root: str | Path, cur) -> dict:
    """Compare snapshot `cur` with the nearest earlier snapshot whose content differs."""
    source_id = cur["source_id"]
    prev = conn.execute(
        "SELECT * FROM snapshot WHERE source_id=? AND snapshot_id<? AND sha256<>? ORDER BY snapshot_id DESC LIMIT 1",
        (source_id, cur["snapshot_id"], cur["sha256"])).fetchone()
    if prev is None:
        earlier = latest_snapshot(conn, source_id, cur["snapshot_id"])
        return {"source_id": source_id, "status": "first_snapshot" if earlier is None else "unchanged",
                "current_snapshot_id": cur["snapshot_id"]}
    out = {"source_id": source_id, "status": "changed", "previous_snapshot_id": prev["snapshot_id"],
           "current_snapshot_id": cur["snapshot_id"], "previous_sha256": prev["sha256"],
           "current_sha256": cur["sha256"], "previous_retrieved_at": prev["retrieved_at"],
           "current_retrieved_at": cur["retrieved_at"]}
    old_t = extract_text((Path(archive_root) / prev["archive_path"]).read_bytes(), prev["content_type"])
    new_t = extract_text((Path(archive_root) / cur["archive_path"]).read_bytes(), cur["content_type"])
    if old_t is None or new_t is None:
        out["text_diff"] = None
        out["note"] = "binary format; hash changed, text diff unavailable"
    elif old_t == new_t:
        out["status"] = "bytes_changed_text_same"
        out["note"] = "file bytes differ but extracted text is identical"
    else:
        out["text_diff"] = text_diff(old_t, new_t)
    return out
