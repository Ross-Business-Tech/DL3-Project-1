"""--states: any state by its code, set up automatically when it has no sources yet."""
import csv

import pytest

from src import states
from src.inventory import promote as promote_mod

JUR = [
    {"jurisdiction_id": "MI", "state": "MI", "jurisdiction_type": "state"},
    {"jurisdiction_id": "CA", "state": "CA", "jurisdiction_type": "state"},
    {"jurisdiction_id": "IL", "state": "IL", "jurisdiction_type": "state"},
    {"jurisdiction_id": "CHI", "state": "IL", "jurisdiction_type": "city"},
]
REG = [
    {"source_id": "MI_QAP", "state": "MI"}, {"source_id": "MI_AW", "state": "MI"},
    {"source_id": "CENSUS_MSA", "state": "US"}, {"source_id": "OH_QAP", "state": "OH"},
]


def run(sts, register, recrawl=False, promoted=()):
    calls = {"crawl": [], "promote": []}
    reg = list(register)

    def crawl_fn(js, settings, rules, db):
        calls["crawl"].append([j["jurisdiction_id"] for j in js])

    def promote_fn(ids, inv, auto, db_path=None, years=None):
        calls["promote"].append(ids)
        rows = [r for r in promoted if r["source_id"].split("_")[0] in ids]
        reg.extend(rows)
        return rows

    plan = states.prepare(sts, {"award_years": {"first": 2021, "last": 2026}}, None, recrawl=recrawl,
                          jurisdictions=JUR, load_register=lambda: list(reg), crawl_fn=crawl_fn,
                          build_fn=lambda: "/x/state_inventory.xlsx", promote_fn=promote_fn, log=lambda *_: None)
    return plan, calls


def test_known_state_is_just_refreshed():
    plan, calls = run(["mi"], REG)
    assert plan["only"] == {"MI_QAP", "MI_AW", "CENSUS_MSA"} and calls == {"crawl": [], "promote": []}


def test_new_state_is_crawled_and_promoted():
    plan, calls = run(["CA"], REG, promoted=[{"source_id": "CA_QAP_CURRENT", "state": "CA"}])
    assert calls["crawl"] == [["CA"]] and calls["promote"] == [["CA"]]
    assert plan["only"] == {"CA_QAP_CURRENT", "CENSUS_MSA"} and plan["added"] == {"CA": 1} and not plan["missing"]


def test_sub_allocators_come_with_their_state():
    plan, calls = run("IL", REG, promoted=[{"source_id": "IL_QAP", "state": "IL"}, {"source_id": "CHI_QAP", "state": "IL"}])
    assert calls["crawl"] == [["IL", "CHI"]] and calls["promote"] == [["IL", "CHI"]]
    assert {"IL_QAP", "CHI_QAP"} <= plan["only"]


def test_state_with_nothing_found_is_reported():
    plan, _ = run(["CA"], REG)
    assert plan["missing"] == ["CA"] and plan["only"] == {"CENSUS_MSA"}


def test_recrawl_crawls_known_states_but_does_not_repromote():
    _, calls = run(["MI"], REG, recrawl=True)
    assert calls["crawl"] == [["MI"]] and calls["promote"] == []


def test_unknown_code_is_refused():
    with pytest.raises(ValueError, match="ZZ"):
        run(["ZZ"], REG)


def test_input_forms():
    assert states.normalise(["mi, oh", "IN", "mi"]) == ["MI", "OH", "IN"]


def test_promote_creates_a_separate_register_file(tmp_path):
    inv = tmp_path / "inv.csv"
    with open(inv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["jurisdiction_id", "state", "allocating_agency", "qap_current_nondraft_url"])
        w.writeheader()
        w.writerow({"jurisdiction_id": "CA", "state": "CA", "allocating_agency": "CTCAC",
                    "qap_current_nondraft_url": "https://www.treasurer.ca.gov/regs.pdf"})
    auto = tmp_path / "source_register_auto.csv"
    rows = promote_mod.promote(["CA"], inv, auto, db_path=None)
    assert rows and auto.exists()
    with open(auto) as fh:
        got = list(csv.DictReader(fh))
    assert got[0]["source_id"].startswith("CA_") and "source_id" in got[0]
