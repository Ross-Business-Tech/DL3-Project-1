"""Run the pipeline for any state given by its two-letter code: python run_all.py --states CA TX --awards --extract

A state that already has sources in the register is simply refreshed. A state with none yet is set up first:
its agency site is crawled (config/jurisdictions.csv), the 50-state inventory is rebuilt, and what the crawl
found (newest QAP, underwriting manual, program and bond pages, award lists) is added to
config/source_register_auto.csv, which keeps machine-added sources apart from the hand-kept register.
Those rows say "auto-found link, needs verification": nothing they produce reaches a score until a reviewer
approves it. Sub-allocators inside a state (e.g. Chicago in IL) are crawled with it.
"""
from __future__ import annotations

from pathlib import Path

from src.fetch import fetch

ROOT = Path(__file__).resolve().parents[1]
AUTO_REGISTER = ROOT / "config" / "source_register_auto.csv"
NATIONAL = "US"  # Census top-metro table, HUD allocator list: shared by every state, refreshed with any of them


def normalise(states) -> list[str]:
    out = []
    if isinstance(states, str):
        states = [states]
    for s in states or []:
        for part in str(s).replace(",", " ").split():
            code = part.strip().upper()
            if code and code not in out:
                out.append(code)
    return out


def jurisdictions_for(states: list[str], jurisdictions: list[dict]) -> list[dict]:
    """Every jurisdiction in those states: the state agency and any local sub-allocators."""
    return [j for j in jurisdictions if j["state"].upper() in states or j["jurisdiction_id"].upper() in states]


def prepare(states: list[str], settings: dict, db_path: Path, *, recrawl: bool = False,
            jurisdictions: list[dict] | None = None, load_register=None, crawl_fn=None, build_fn=None,
            promote_fn=None, auto_register: Path = AUTO_REGISTER, log=print) -> dict:
    """Make sure each state has sources. Returns {"states", "only": source ids to run, "added", "missing"}."""
    from src.inventory import build, crawl, promote

    load_register = load_register or fetch.load_register
    states = normalise(states)
    jurisdictions = jurisdictions if jurisdictions is not None else crawl.load_jurisdictions()
    known = {j["state"].upper() for j in jurisdictions} | {j["jurisdiction_id"].upper() for j in jurisdictions}
    unknown = [s for s in states if s not in known]
    if unknown:
        raise ValueError(f"Not a state or jurisdiction in config/jurisdictions.csv: {', '.join(unknown)}")

    register = load_register()
    have = {r["state"].upper() for r in register}
    new_states = [s for s in states if s not in have]
    to_crawl = jurisdictions_for(states if recrawl else new_states, jurisdictions)
    added: dict[str, int] = {}
    if to_crawl:
        log(f"Crawling agency sites for {', '.join(j['jurisdiction_id'] for j in to_crawl)} to find their documents")
        (crawl_fn or crawl.crawl_all)(to_crawl, settings, crawl.load_rules(), db_path)
        xlsx = (build_fn or (lambda: build.build(db_path=db_path)))()
        inventory_csv = Path(xlsx).with_name("state_inventory.csv")
        ids = [j["jurisdiction_id"] for j in jurisdictions_for(new_states, jurisdictions)]
        if ids:
            ay = settings.get("award_years", {"first": 2021, "last": 2026})
            rows = (promote_fn or promote.promote)(ids, inventory_csv, auto_register, db_path=db_path,
                                                   years=(ay["first"], ay["last"]))
            for jid in ids:
                n = sum(1 for r in rows if r["source_id"].startswith(jid + "_"))
                added[jid] = n
                log(f"  {jid}: {n} sources added to {auto_register.name} (auto-found links: a person should check them)")
            register = load_register()
    run_states = set(states) | {NATIONAL}
    only = {r["source_id"] for r in register if r["state"].upper() in run_states}
    missing = [s for s in states if not any(r["state"].upper() == s for r in register)]
    return {"states": states, "only": only, "added": added, "missing": missing}
