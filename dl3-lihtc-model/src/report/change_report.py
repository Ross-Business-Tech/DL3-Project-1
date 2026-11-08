"""Build the HTML/JSON change report for one run from the database. Jinja2 autoescapes all source text."""
from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..fetch import archive, diff

TEMPLATES = Path(__file__).resolve().parent / "templates"


def build_context(conn, archive_root: Path, run_id: str, freshness_days: int) -> dict:
    run = conn.execute("SELECT * FROM run WHERE run_id=?", (run_id,)).fetchone()
    snaps = conn.execute("SELECT s.*, src.title FROM snapshot s JOIN source src USING(source_id) "
                         "WHERE s.run_id=? ORDER BY s.snapshot_id", (run_id,)).fetchall()
    changes, new, unchanged = [], 0, 0
    for s in snaps:
        has_prev = archive.latest_snapshot(conn, s["source_id"], s["snapshot_id"]) is not None
        if not has_prev:
            new += 1
        elif s["is_duplicate"]:
            unchanged += 1
        else:
            d = diff.compare_latest_for(conn, archive_root, s)
            d["title"] = s["title"]
            changes.append(d)
    failures = [dict(r) for r in conn.execute("SELECT * FROM fetch_failure WHERE run_id=?", (run_id,))]
    fresh = []
    for r in conn.execute("SELECT source_id, critical FROM source ORDER BY source_id"):
        f = archive.freshness(conn, r["source_id"], bool(r["critical"]), freshness_days)
        f["critical"] = r["critical"]
        fresh.append(f)
    ids = [s["snapshot_id"] for s in snaps]
    cands = [dict(r) for r in conn.execute(
        "SELECT s.source_id, c.topic, c.page, c.quote FROM candidate_page c JOIN snapshot s USING(snapshot_id) "
        f"WHERE c.snapshot_id IN ({','.join('?' * len(ids)) or 'NULL'}) ORDER BY s.source_id, c.topic, c.score DESC", ids)]
    return {"run_id": run_id, "started_at": run["started_at"] if run else "",
            "counts": {"fetched": len(snaps), "new": new, "changed": len(changes), "unchanged": unchanged,
                       "failed": len(failures), "blocking": sum(1 for f in fresh if f["blocks_recommendation"])},
            "changes": changes, "failures": failures, "freshness": fresh, "candidates": cands,
            "freshness_days": freshness_days, "ocr": []}


def render(context: dict) -> str:
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html", "j2"]))
    return env.get_template("change_report.html.j2").render(**context)
