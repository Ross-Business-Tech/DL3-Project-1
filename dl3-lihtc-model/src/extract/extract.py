"""LLM rule extraction from archived documents, with deterministic validation.

For each archived document whose type has prompts (settings.yaml -> llm.topics_by_doc_type):
1. Send the page text (whole document if small enough, else the located candidate pages) wrapped in
   <page number="N"> tags, plus one topic prompt, and require JSON matching a fixed schema.
2. Validate in code: the cited page must be one that was sent; the quote must appear verbatim on that
   page (after whitespace/typography normalization); numbers in the value must appear in the quote.
   Findings failing the quote check are stored as rejected_validation and never reach review.
3. Store every request (prompt version, model, raw output, usage) and every finding as pending_review.
   Only a named reviewer can approve a finding (src/review). Nothing here feeds a calculation directly.

Results are cached by (document hash, prompt version, model): a rerun on unchanged inputs makes no API
calls and reuses the stored findings, so identical inputs reproduce identical results.

    python -m src.extract.extract --dry-run          # what would be sent and roughly what it costs
    python -m src.extract.extract                    # all eligible archived documents
    python -m src.extract.extract --only P3 --topics fee_rule
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path

import yaml

from ..fetch import archive, fetch
from .llm_client import LLMResult, make_client
from .pdf_text import pages_from_bytes

ROOT = Path(__file__).resolve().parents[2]
PROMPTS = Path(__file__).resolve().parent / "prompts"
CONFIDENCE = ["high", "medium", "low"]


# --- prompts and schemas --------------------------------------------------------------------------
def load_prompt(topic: str) -> tuple[dict, str]:
    text = (PROMPTS / f"{topic}.md").read_text(encoding="utf-8")
    meta = {}
    if text.startswith("---"):
        _, front, text = text.split("---", 2)
        meta = yaml.safe_load(front) or {}
    return meta, text.strip()


def schema_for(topic: str, meta: dict) -> dict:
    s = lambda: {"type": "string"}  # noqa: E731
    if meta.get("kind") == "table":
        cols = ["project_name", "sponsor", "address", "city", "county", "total_units", "restricted_units",
                "annual_credit_amount", "total_development_cost", "award_round_or_date", "set_aside", "status", "section", "quote", "notes"]
        props = {c: s() for c in cols}
        props["credit_type"] = {"type": "string", "enum": ["9%", "4%", "other", "unknown"]}
        props["page"] = {"type": "integer"}
        props["confidence"] = {"type": "string", "enum": CONFIDENCE}
        row = {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
        return {"type": "object", "properties": {"rows": {"type": "array", "items": row}},
                "required": ["rows"], "additionalProperties": False}
    fields = meta["fields"]
    finding = {"type": "object", "additionalProperties": False, "properties": {
        "field": {"type": "string", "enum": fields}, "value": s(), "units": s(),
        "applies_to": {"type": "string", "enum": ["9%", "4%", "both", "unknown"]},
        "page": {"type": "integer"}, "section": s(), "quote": s(),
        "confidence": {"type": "string", "enum": CONFIDENCE}, "notes": s()}}
    finding["required"] = list(finding["properties"])
    return {"type": "object", "additionalProperties": False, "required": ["findings", "not_found"],
            "properties": {"findings": {"type": "array", "items": finding},
                           "not_found": {"type": "array", "items": {"type": "string", "enum": fields}}}}


def prompt_bundle(topic: str) -> dict:
    system = (PROMPTS / "system.md").read_text(encoding="utf-8").strip()
    meta, body = load_prompt(topic)
    schema = schema_for(topic, meta)
    digest = hashlib.sha256((system + "\n" + body + "\n" + json.dumps(schema, sort_keys=True)).encode()).hexdigest()
    return {"topic": topic, "system": system, "instruction": body, "schema": schema, "meta": meta,
            "version": f"{topic}@{digest[:8]}"}


# --- validation -------------------------------------------------------------------------------------
_TRANS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-",
                        "—": "-", "−": "-", " ": " ", "­": ""})
NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def norm(text: str) -> str:
    """Normalize typography and layout only (never words): ligatures, quotes, dashes, hyphenated line
    breaks, whitespace."""
    t = unicodedata.normalize("NFKC", text or "").translate(_TRANS)
    t = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", t)
    return re.sub(r"\s+", " ", t).strip()


def numbers(text: str) -> set[str]:
    out = set()
    for n in NUM.findall(text or ""):
        n = n.replace(",", "").rstrip(".")
        if "." in n:
            n = n.rstrip("0").rstrip(".")
        out.add(n)
    return out


VALIDATOR_VERSION = "v2"  # v2: page correction; layout-aware checks for tables and award forms

EXACT, LAYOUT, REJECTED = 1, 2, 0  # stored in extraction.quote_verified


def _in_page(needle: str, page: str) -> bool:
    return bool(needle) and norm(needle).lower() in norm(page).lower()


def verify(item: dict, value: str, page_text: dict[int, str], is_table: bool) -> tuple[int, int | None, bool, str]:
    """Check one finding against the pages that were sent. Returns (level, page, value_in_quote, note).

    EXACT: the quote is on the cited page word for word (or on another sent page: the page is corrected).
    LAYOUT: the quote is not one continuous passage because the PDF text runs in a different order (tables,
    one-project-per-page forms), but code finds the facts on the page: for award rows the project name and
    credit amount; for rules every quote word in order plus every number of the value. Reviewers see a note.
    REJECTED: none of the above. Nothing here ever trusts the model's own word.
    """
    cited, quote = item.get("page"), (item.get("quote") or "").strip()
    if not quote:
        return REJECTED, cited, False, "no quote"
    order = ([cited] if cited in page_text else []) + [p for p in page_text if p != cited]

    def moved(p):
        return "" if p == cited else f"page corrected from {cited} to {p} (the quote is there); "

    for p in order:
        if norm(quote) in norm(page_text[p]):
            missing = numbers(value) - numbers(quote)
            note = moved(p) + (f"number(s) {', '.join(sorted(missing))} in the value are not in the quote: check"
                               if missing else "")
            return EXACT, p, not missing, note.strip("; ")
    for p in order:
        text = page_text[p]
        if numbers(value) - numbers(text):
            continue
        if is_table:
            name = (item.get("project_name") or "").strip()
            if name and _in_page(name, text):
                return LAYOUT, p, not (numbers(value) - numbers(quote)), (
                    moved(p) + "project name and amount found on the page, but the quote is not one continuous "
                    "passage (form or table layout): check against the page")
        elif words_in_order(quote, text):
            return LAYOUT, p, not (numbers(value) - numbers(quote)), (
                moved(p) + "quote words found in order with other text between (table layout): check against the page")
    if cited not in page_text:
        return REJECTED, cited, False, f"cited page {cited} was not in the pages sent"
    return REJECTED, cited, False, f"quote not found verbatim on page {cited}"


# --- documents --------------------------------------------------------------------------------------
def eligible_snapshots(conn, topics_by_type: dict, only: set[str] | None):
    rows = conn.execute(
        "SELECT s.*, src.doc_type, src.title, src.url AS source_url FROM snapshot s JOIN source src USING(source_id) "
        "WHERE s.snapshot_id IN (SELECT snapshot_id FROM current_snapshot) ORDER BY s.source_id"
    ).fetchall()
    for r in rows:
        if only and r["source_id"] not in only:
            continue
        if r["doc_type"] in topics_by_type:
            yield r


def select_pages(conn, snap, pages, cfg) -> tuple[list, str]:
    text_pages = [p for p in pages if p.text.strip()]
    if len(pages) <= cfg["full_document_max_pages"]:
        return text_pages, f"all ({len(text_pages)} of {len(pages)} have text)"
    wanted = {r[0] for r in conn.execute(
        "SELECT page FROM candidate_page WHERE snapshot_id=? ORDER BY score DESC", (snap["snapshot_id"],))}
    n = cfg.get("located_neighbor_pages", 1)
    wanted |= {p + d for p in list(wanted) for d in range(1, n + 1)}
    chosen = [p for p in text_pages if p.number in wanted][: cfg["located_pages_max"]]
    return chosen, ",".join(str(p.number) for p in chosen)


def document_text(snap, pages) -> str:
    head = (f'<document source_id="{snap["source_id"]}" title="{snap["title"]}" '
            f'status="{snap["doc_status"]}" retrieved="{snap["retrieved_at"][:10]}">')
    body = "\n".join(f'<page number="{p.number}">\n{p.text.strip()}\n</page>' for p in pages)
    return f"{head}\n{body}\n</document>"


# --- run ---------------------------------------------------------------------------------------------
def cached_call(conn, snap, bundle, model):
    return conn.execute(
        "SELECT c.call_id FROM llm_call c JOIN snapshot s USING(snapshot_id) WHERE s.sha256=? AND s.source_id=? "
        "AND c.prompt_version=? AND c.model_requested=? AND c.error IS NULL ORDER BY c.call_id DESC LIMIT 1",
        (snap["sha256"], snap["source_id"], bundle["version"], model)).fetchone()


def store(conn, snap, bundle, cfg, pages_sent, res: LLMResult, page_text, run_id, ocr_pages=frozenset()) -> dict:
    now = archive.utcnow().isoformat()
    parsed, error = None, res.error
    if res.text is not None:
        try:
            parsed = json.loads(res.text)
        except json.JSONDecodeError as e:
            error = f"output was not valid JSON: {e}"
    u = res.usage
    cur = conn.execute(
        "INSERT INTO llm_call (run_id, snapshot_id, topic, prompt_version, model_requested, model_served, request_id,"
        " pages_sent, stop_reason, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, raw_output,"
        " error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, snap["snapshot_id"], bundle["topic"], bundle["version"], cfg["model"], res.model_served,
         res.request_id, pages_sent, res.stop_reason, u.get("input_tokens"), u.get("output_tokens"),
         u.get("cache_write_tokens"), u.get("cache_read_tokens"), res.text, error, now))
    call_id = cur.lastrowid
    counts = {"pending_review": 0, "rejected_validation": 0}
    if parsed is not None:
        counts = insert_findings(conn, call_id, snap, bundle, parsed, page_text, ocr_pages, now)
    conn.execute("UPDATE llm_call SET validator_version=? WHERE call_id=?", (VALIDATOR_VERSION, call_id))
    conn.commit()
    return {"call_id": call_id, "error": error, **counts}


def insert_findings(conn, call_id, snap, bundle, parsed, page_text, ocr_pages, now) -> dict:
    counts = {"pending_review": 0, "rejected_validation": 0}
    is_table = bundle["meta"].get("kind") == "table"
    items = parsed.get("rows", []) if is_table else parsed.get("findings", [])
    for it in items:
        value = it.get("annual_credit_amount" if is_table else "value", "") or ""
        level, page, num_ok, note = verify(it, value, page_text, is_table)
        if level and page in ocr_pages:
            note = (note + "; " if note else "") + "page is a scan read by OCR: check the quote against the image"
        status = "pending_review" if level else "rejected_validation"
        counts[status] += 1
        conn.execute(
            "INSERT INTO extraction (call_id, snapshot_id, source_id, topic, field, value, units, applies_to, page,"
            " section, quote, confidence, notes, row_json, doc_status, quote_verified, value_in_quote, status,"
            " validation_note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (call_id, snap["snapshot_id"], snap["source_id"], bundle["topic"],
             "award_row" if is_table else it.get("field"), value,
             "USD (annual credit, as printed)" if is_table else it.get("units"),
             it.get("credit_type") if is_table else it.get("applies_to"), page, it.get("section"),
             it.get("quote"), it.get("confidence"), it.get("notes"),
             json.dumps(it, sort_keys=True) if is_table else None, snap["doc_status"],
             level, int(num_ok), status, note or None, now))
    for f in ([] if is_table else parsed.get("not_found", [])):
        conn.execute("INSERT INTO extraction_not_found VALUES (?,?)", (call_id, f))
    return counts


def revalidate(conn, archive_root: Path, cfg: dict, progress=print) -> dict:
    """Re-check stored answers with the current validator, from the raw output saved with each call: no API
    calls. Calls with any reviewer decision are left alone."""
    out = {"calls": 0, "pending_review": 0, "rejected_validation": 0, "skipped_reviewed": 0}
    calls = conn.execute(
        "SELECT c.* FROM llm_call c WHERE c.error IS NULL AND c.raw_output IS NOT NULL "
        "AND COALESCE(c.validator_version, '') <> ? AND c.snapshot_id IN (SELECT snapshot_id FROM current_snapshot) "
        "AND c.call_id IN (SELECT MAX(call_id) FROM llm_call WHERE error IS NULL GROUP BY snapshot_id, topic)",
        (VALIDATOR_VERSION,)).fetchall()
    pages_cache: dict = {}
    for c in calls:
        if conn.execute("SELECT 1 FROM extraction WHERE call_id=? AND reviewer IS NOT NULL", (c["call_id"],)).fetchone():
            out["skipped_reviewed"] += 1
            continue
        snap = conn.execute("SELECT s.*, src.doc_type, src.title FROM snapshot s JOIN source src USING(source_id) "
                            "WHERE s.snapshot_id=?", (c["snapshot_id"],)).fetchone()
        if snap["snapshot_id"] not in pages_cache:
            pages = pages_from_bytes((archive_root / snap["archive_path"]).read_bytes(), snap["content_type"]) or []
            chosen, _ = select_pages(conn, snap, pages, cfg)
            pages_cache[snap["snapshot_id"]] = chosen
        chosen = pages_cache[snap["snapshot_id"]]
        try:
            bundle = prompt_bundle(c["topic"])
            parsed = json.loads(c["raw_output"])
        except (FileNotFoundError, ValueError):
            continue
        conn.execute("DELETE FROM extraction WHERE call_id=?", (c["call_id"],))
        conn.execute("DELETE FROM extraction_not_found WHERE call_id=?", (c["call_id"],))
        counts = insert_findings(conn, c["call_id"], snap, bundle, parsed, {p.number: p.text for p in chosen},
                                 {p.number for p in chosen if p.ocr}, archive.utcnow().isoformat())
        conn.execute("UPDATE llm_call SET validator_version=? WHERE call_id=?", (VALIDATOR_VERSION, c["call_id"]))
        out["calls"] += 1
        out["pending_review"] += counts["pending_review"]
        out["rejected_validation"] += counts["rejected_validation"]
    conn.commit()
    if out["calls"]:
        progress(f"Re-checked {out['calls']} stored answers with validator {VALIDATOR_VERSION}: "
                 f"{out['pending_review']} for review, {out['rejected_validation']} rejected (no API calls)")
    return out


def resolve_cfg(llm: dict) -> dict:
    """Provider + model for this run. Env vars (from .env) override settings.yaml."""
    import os
    cfg = dict(llm)
    provider = os.environ.get("LLM_PROVIDER") or cfg.get("provider", "gemini")
    cfg["provider"] = provider
    env_model = {"gemini": "GEMINI_MODEL", "anthropic": "ANTHROPIC_MODEL"}.get(provider)
    cfg["model"] = (os.environ.get(env_model) if env_model else None) or cfg.get("model") or cfg["models"][provider]
    prices = cfg.get("price_per_mtok") or {}
    cfg["prices"] = prices.get(provider) if isinstance(prices, dict) and provider in prices else None
    return cfg


def words_in_order(quote: str, page: str, max_spread: int = 4) -> bool:
    """Diagnostic only: do the quote's words appear in order on the page, with other text between them
    (typical of a table read across columns)? Never used to accept a finding."""
    q, p = norm(quote).lower().split(), norm(page).lower().split()
    if not q:
        return False
    for start in (i for i, w in enumerate(p) if w == q[0]):
        k, i = 1, start + 1
        while k < len(q) and i < len(p) and i - start <= max_spread * len(q):
            if p[i] == q[k]:
                k += 1
            i += 1
        if k == len(q):
            return True
    return False


def write_rejected(conn, out_dir: Path, archive_root: Path | None = None) -> tuple[str, dict]:
    """Every current finding that failed the quote check, with a hint why, for checking prompts and PDFs."""
    import csv
    from collections import Counter
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "rejected.csv"
    reasons = Counter()
    texts: dict = {}
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["source_id", "topic", "field", "value", "page", "reason", "likely_cause", "quote"])
        for r in conn.execute(
                "SELECT e.*, s.archive_path, s.content_type FROM extraction e JOIN snapshot s USING(snapshot_id) "
                "WHERE e.status='rejected_validation' AND e.snapshot_id IN (SELECT snapshot_id FROM current_snapshot) "
                "ORDER BY e.source_id, e.topic, e.page"):
            cause = ""
            if r["validation_note"] and "not found verbatim" in r["validation_note"]:
                if r["snapshot_id"] not in texts:
                    try:
                        pages = pages_from_bytes(((archive_root or ROOT / "archive") / r["archive_path"]).read_bytes(),
                                                 r["content_type"])
                        texts[r["snapshot_id"]] = {p.number: p.text for p in (pages or [])}
                    except OSError:
                        texts[r["snapshot_id"]] = {}
                page_text = texts[r["snapshot_id"]].get(r["page"], "")
                if words_in_order(r["quote"] or "", page_text):
                    cause = "words are on the page in order with text between (table or columns)"
                elif any(words_in_order(r["quote"] or "", t) for t in texts[r["snapshot_id"]].values()):
                    cause = "quote is on a different page"
                else:
                    cause = "quote not on any page (paraphrased or invented)"
            key = re.sub(r"\d+", "N", r["validation_note"] or "")
            reasons[f"{key} -> {cause}" if cause else key] += 1
            w.writerow([r["source_id"], r["topic"], r["field"], r["value"], r["page"], r["validation_note"], cause,
                        (r["quote"] or "")[:300]])
    return str(path), dict(reasons)


def estimate_cost(usage_rows, prices) -> float | None:
    if not prices:
        return None
    total = 0.0
    for u in usage_rows:
        total += (u.get("input_tokens") or 0) * prices["input"] + (u.get("output_tokens") or 0) * prices["output"]
        total += (u.get("cache_write_tokens") or 0) * prices["cache_write"]
        total += (u.get("cache_read_tokens") or 0) * prices["cache_read"]
    return total / 1_000_000


def run(db_path: Path, archive_root: Path, settings: dict, client=None, only: set[str] | None = None,
        topics: set[str] | None = None, dry_run: bool = False, force: bool = False, run_id: str | None = None,
        progress=print) -> dict:
    cfg = resolve_cfg(settings["llm"])
    conn = archive.connect(db_path)
    summary = {"documents": 0, "calls": 0, "cached": 0, "errors": 0, "pending_review": 0,
               "rejected_validation": 0, "skipped": [], "usage": [], "estimated_input_tokens": 0}
    for snap in list(eligible_snapshots(conn, cfg["topics_by_doc_type"], only)):
        doc_topics = [t for t in cfg["topics_by_doc_type"][snap["doc_type"]] if not topics or t in topics]
        if not doc_topics:
            continue
        raw = (archive_root / snap["archive_path"]).read_bytes()
        pages = pages_from_bytes(raw, snap["content_type"])
        if pages is None:
            summary["skipped"].append(f"{snap['source_id']}: {snap['content_type']} has no text extractor "
                                      "(spreadsheets are parsed in code: python -m src.awards.parse_awards)")
            continue
        chosen, pages_sent = select_pages(conn, snap, pages, cfg)
        if not chosen:
            ocr = [p.number for p in pages if p.needs_ocr]
            summary["skipped"].append(f"{snap['source_id']}: no text pages to send"
                                      + (f" (pages {ocr[:10]} need OCR)" if ocr else ""))
            continue
        summary["documents"] += 1
        doc = document_text(snap, chosen)
        page_text = {p.number: p.text for p in chosen}
        ocr_pages = {p.number for p in chosen if p.ocr}
        if ocr_pages:
            pages_sent += f"; OCR pages {','.join(map(str, sorted(ocr_pages)))}"
        for topic in doc_topics:
            bundle = prompt_bundle(topic)
            if not force and cached_call(conn, snap, bundle, cfg["model"]):
                summary["cached"] += 1
                continue
            if dry_run:
                summary["estimated_input_tokens"] += (len(doc) + len(bundle["system"]) + len(bundle["instruction"])) // 4
                progress(f"[dry run] {snap['source_id']} {topic}: pages {pages_sent}, ~{len(doc) // 4:,} tokens")
                continue
            if client is None:
                client = make_client(cfg)
            res = client.extract(bundle["system"], doc, bundle["instruction"], bundle["schema"])
            out = store(conn, snap, bundle, cfg, pages_sent, res, page_text, run_id, ocr_pages)
            summary["calls"] += 1
            summary["usage"].append(res.usage)
            summary["errors"] += int(out["error"] is not None)
            summary["pending_review"] += out["pending_review"]
            summary["rejected_validation"] += out["rejected_validation"]
            progress(f"{snap['source_id']} {topic}: {out['pending_review']} for review, "
                     f"{out['rejected_validation']} rejected by validation" + (f", ERROR {out['error']}" if out["error"] else ""))
    if not dry_run:
        summary["revalidated"] = revalidate(conn, Path(archive_root), cfg, progress)
        summary["rejected_file"], summary["rejected_reasons"] = write_rejected(
            conn, Path(archive_root).parent / "outputs" / "extract" if Path(archive_root) != ROOT / "archive"
            else ROOT / "outputs" / "extract", Path(archive_root))
    conn.close()
    cost = estimate_cost(summary["usage"], cfg["prices"])
    summary["provider"], summary["model"] = cfg["provider"], cfg["model"]
    summary["tokens"] = {k: sum((u.get(k) or 0) for u in summary["usage"])
                         for k in ("input_tokens", "output_tokens", "cache_read_tokens")}
    summary["estimated_cost_usd"] = None if cost is None else round(cost, 4)
    if dry_run and cfg["prices"]:
        # upper bound: every topic pays full input price (caching usually makes it much lower)
        summary["estimated_cost_usd_upper_bound"] = round(
            summary["estimated_input_tokens"] * cfg["prices"]["input"] / 1_000_000, 2)
    return summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", help="source_ids")
    ap.add_argument("--topics", nargs="*", help="e.g. fee_rule deadlines")
    ap.add_argument("--dry-run", action="store_true", help="show what would be sent; no API calls")
    ap.add_argument("--force", action="store_true", help="re-run even if this document+prompt+model is cached")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--archive", default=str(ROOT / "archive"))
    a = ap.parse_args(argv)
    from ..env import load_env
    load_env()
    s = run(Path(a.db), Path(a.archive), fetch.load_settings(), only=set(a.only) if a.only else None,
            topics=set(a.topics) if a.topics else None, dry_run=a.dry_run, force=a.force)
    s.pop("usage")
    print(json.dumps(s, indent=2))
    return 1 if s["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
