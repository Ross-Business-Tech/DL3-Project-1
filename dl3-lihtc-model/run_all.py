"""Run the full collection pipeline: fetch -> archive -> locate pages -> change report -> manifest.

    python run_all.py [--only P6 P7] [--follow-documents] [--refresh-hud]

Outputs go to outputs/runs/{yyyymmdd}_{runid}/ (change_report.html, change_report.json, run_manifest.json).
Identical archived inputs and code version reproduce identical reports.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import uuid
from pathlib import Path

from src.extract import locate
from src.fetch import archive, fetch, hud_allocators
from src.report import change_report

ROOT = Path(__file__).resolve().parent


def code_version() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def run_pipeline(*, register_path: Path | None = None, db_path: Path | None = None,
                 archive_root: Path | None = None, out_root: Path | None = None,
                 only: set[str] | None = None, follow_documents: bool = False,
                 refresh_hud: bool = True, fetcher: fetch.Fetcher | None = None,
                 inventory: bool = False, inventory_only: set[str] | None = None,
                 extract: bool = False, llm_client=None, awards: bool = False) -> Path:
    settings = fetch.load_settings()
    register = fetch.load_register(register_path)
    db_path = db_path or ROOT / "data" / "dl3.db"
    archive_root = archive_root or ROOT / "archive"
    out_root = out_root or ROOT / "outputs" / "runs"
    run_id = uuid.uuid4().hex[:8]
    conn = archive.connect(db_path)
    archive.start_run(conn, run_id, code_version())

    summary = fetch.run(register, settings, db_path, archive_root, fetcher=fetcher, only=only,
                        follow_documents=follow_documents, run_id=run_id)

    conn = archive.connect(db_path)  # fetch.run closed its own connection
    topics = locate.load_topics()
    ocr = []
    for snap in conn.execute("SELECT * FROM snapshot WHERE run_id=? AND is_duplicate=0", (run_id,)).fetchall():
        res = locate.locate_snapshot(conn, archive_root, snap, topics)
        if res["needs_ocr_pages"]:
            ocr.append({"source_id": snap["source_id"], "pages": res["needs_ocr_pages"]})

    hud_rows = 0
    if refresh_hud:
        for sid in ("P1", "P1b"):  # same HUD list at two addresses; use the first that parses
            p1 = archive.latest_snapshot(conn, sid)
            if p1 and p1["content_type"] == "text/html" and p1["run_id"] == run_id:
                rows = hud_allocators.parse_allocators((archive_root / p1["archive_path"]).read_bytes(),
                                                       p1["final_url"])
                if rows:
                    hud_allocators.write_csv(rows, ROOT / "data" / "reference" / "hud_allocators.csv")
                    hud_rows = len(rows)
                    break

    inventory_path = None
    if inventory:
        from src.inventory import build, crawl
        js = crawl.load_jurisdictions()
        if inventory_only:
            js = [j for j in js if j["jurisdiction_id"] in inventory_only]
        crawl.crawl_all(js, settings, crawl.load_rules(), db_path)
        inventory_path = str(build.build(db_path=db_path))

    award_summary = None
    if awards:
        from src.awards import parse_awards
        award_summary = parse_awards.run(db_path, archive_root, only=only)

    extraction = None
    if extract:
        from src.extract import extract as llm_extract
        extraction = llm_extract.run(db_path, archive_root, settings, client=llm_client, only=only, run_id=run_id)
        extraction.pop("usage", None)

    archive.finish_run(conn, run_id)
    ctx = change_report.build_context(conn, archive_root, run_id, settings["freshness_days"])
    ctx["ocr"] = ocr
    started = conn.execute("SELECT started_at FROM run WHERE run_id=?", (run_id,)).fetchone()[0]
    out_dir = out_root / f"{started[:10].replace('-', '')}_{run_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "change_report.html").write_text(change_report.render(ctx), encoding="utf-8")
    (out_dir / "change_report.json").write_text(json.dumps(ctx, indent=2, default=str), encoding="utf-8")
    manifest = {"run_id": run_id, "started_at": started, "code_version": code_version(),
                "register": str(register_path or "config/source_register.csv"),
                "settings": settings, "counts": ctx["counts"], "hud_allocator_rows": hud_rows, "inventory": inventory_path,
                "extraction": extraction, "awards": award_summary,
                "sources": summary.details,
                "snapshots": [dict(r) for r in conn.execute(
                    "SELECT snapshot_id, source_id, sha256, retrieved_at, archive_path FROM snapshot WHERE run_id=?", (run_id,))]}
    (out_dir / "run_manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    conn.close()
    return out_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--follow-documents", action="store_true")
    ap.add_argument("--no-hud", action="store_true", help="skip parsing the HUD allocator list")
    ap.add_argument("--inventory", nargs="*", metavar="ID",
                    help="also crawl agency sites and rebuild data/inventory/state_inventory.xlsx "
                         "(all jurisdictions, or the IDs given, e.g. --inventory MI CHI)")
    ap.add_argument("--awards", action="store_true", help="parse archived award spreadsheets (code only, no LLM)")
    ap.add_argument("--extract", action="store_true",
                    help="extract rules with the LLM in settings.yaml (Gemini: GEMINI_API_KEY in .env); "
                         "try python -m src.extract.extract --dry-run first")
    a = ap.parse_args(argv)
    from src.env import load_env
    load_env()
    fetch.use_os_trust_store()
    out = run_pipeline(only=set(a.only) if a.only else None, follow_documents=a.follow_documents,
                       refresh_hud=not a.no_hud, inventory=a.inventory is not None,
                       inventory_only={x.upper() for x in a.inventory} if a.inventory else None,
                       extract=a.extract, awards=a.awards)
    m = json.loads((out / "run_manifest.json").read_text())
    print(f"Run {m['run_id']}: {m['counts']}\nReport: {out / 'change_report.html'}")
    if m.get("awards"):
        w = m["awards"]
        print(f"Awards: {w['rows']} rows from {w['files']} files ({w['flagged']} flagged, {len(w['errors'])} errors). "
              "Check: python -m src.awards.parse_awards --export")
    if m.get("extraction"):
        e = m["extraction"]
        print(f"Extraction: {e['calls']} calls ({e['cached']} reused), {e['pending_review']} findings for review, "
              f"{e['rejected_validation']} rejected by validation, {e['errors']} errors "
              f"({e['provider']} {e['model']}; tokens {e['tokens']}"
              + (f"; ~${e['estimated_cost_usd']}" if e.get("estimated_cost_usd") is not None else "") + ")")
        print("Review packet: python -m src.review.build_packet")
    if m.get("inventory"):
        print(f"Inventory: {m['inventory']}")
    return 1 if m["counts"]["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
