"""Inputs for the DL3 guidance of 2026-11-15: top-100 MSAs, cost per unit, bond volume cap."""
import csv
import json

import pytest

from src.awards import costs, parse_awards as pa
from src.extract import extract
from src.fetch import archive, fetch
from src.reference import msa
from src.report import export_web
from tests.test_awards import add, xlsx


def census(rows):
    return json.dumps([["NAME", "B01003_001E", "metropolitan statistical area/micropolitan statistical area"], *rows]).encode()


def fake_census(n=120):
    rows = [["New York-Newark-Jersey City, NY-NJ Metro Area", "19500000", "35620"],
            ["Chicago-Naperville-Elgin, IL-IN Metro Area", "9300000", "16980"],
            ["Detroit-Warren-Dearborn, MI Metro Area", "4350000", "19820"],
            ["San Juan-Bayamón-Caguas, PR Metro Area", "2000000", "41980"],
            ["Bozeman, MT Micro Area", "9999999", "14580"],          # micro areas never rank
            ["Suppressed, OH Metro Area", None, "99999"]]
    rows += [[f"Town{i:03d}, OH Metro Area", str(1_000_000 - i * 1000), str(10000 + i)] for i in range(n)]
    rows += [["Cheyenne, WY Metro Area", "100000", "16940"]]
    return census(rows)


def store_census(tmp_path, raw, year="2024"):
    conn = archive.connect(tmp_path / "t.db")
    src = {"source_id": "CENSUS_MSA", "jurisdiction": "US Census Bureau", "state": "US", "doc_type": "reference_data",
           "title": "ACS", "url": f"https://api.census.gov/data/{year}/acs/acs5?get=NAME,B01003_001E", "status": "final",
           "critical": 0, "notes": ""}
    archive.upsert_source(conn, src)
    archive.store_snapshot(conn, tmp_path / "a", source=src, data=raw, requested_url=src["url"], final_url=src["url"],
                           content_type="application/json", http_status=200)
    conn.close()


def test_top_msas_ranked_and_states_listed(tmp_path):
    store_census(tmp_path, fake_census())
    r = msa.build(tmp_path / "t.db", tmp_path / "a", tmp_path / "ref")
    assert r["top_n"] == 100 and r["vintage"] == "ACS 5-year ending 2024" and len(r["sha256"]) == 64
    top = list(csv.DictReader(open(tmp_path / "ref" / "top_msas.csv")))
    assert [t["msa_name"].split(",")[0] for t in top[:3]] == ["New York-Newark-Jersey City", "Chicago-Naperville-Elgin",
                                                              "Detroit-Warren-Dearborn"]
    assert top[1]["states"] == "IL-IN" and top[3]["includes_puerto_rico"] == "yes" and len(top) == 100
    assert not any("Micro" in t["msa_name"] or "Suppressed" in t["msa_name"] for t in top)
    st = {s["state"]: s for s in csv.DictReader(open(tmp_path / "ref" / "states_in_top_msas.csv"))}
    assert st["IN"]["in_top_msa"] == "yes" and st["IN"]["largest_msa_rank"] == "2"       # part of a multi-state MSA
    assert st["NJ"]["in_top_msa"] == "yes" and st["MI"]["top_msa_count"] == "1"
    assert st["WY"]["in_top_msa"] == "no" and st["MT"]["in_top_msa"] == "no" and st["WY"]["all_top_msas"] == ""
    assert st["OH"]["top_msa_count"] == "96" and len(st) == 52 and st["IN"]["source_url"].startswith("https://api.census.gov")
    assert st["OH"]["cutoff_population"] == top[-1]["population"]


def test_census_layout_change_is_an_error_not_a_guess(tmp_path):
    with pytest.raises(ValueError, match="missing NAME"):
        msa.parse(json.dumps([["GEO", "POP"], ["x", "1"]]).encode())
    with pytest.raises(ValueError, match="only 3 metro"):
        msa.parse(census([["A, OH Metro Area", "5", "1"], ["B, OH Metro Area", "4", "2"], ["C, MI Metro Area", "3", "3"]]))
    assert msa.build(tmp_path / "t.db", tmp_path / "a", tmp_path / "ref") is None   # not archived yet


def test_census_source_registered_and_json_allowed():
    reg = {r["source_id"]: r for r in fetch.load_register()}
    assert "B01003_001E" in reg["CENSUS_MSA"]["url"] and "/acs/acs5" in reg["CENSUS_MSA"]["url"]
    assert "application/json" in fetch.load_settings()["fetch"]["allowed_content_types"]


COSTS = {"2025 9% Awards": [
    ["Project Name", "Developer", "Total Units", "Annual Credit", "Total Development Cost", "Construction Cost", "Developer Fee"],
    ["A", "X", 100, 1000000, 30000000, 20000000, 3000000],
    ["B", "Y", 50, 800000, "$20,000,000", 1, 1],
    ["C", "Z", 80, 900000, None, 1, 1],
    ["D", "W", 0, 900000, 10000000, 1, 1]]}


def test_award_parser_reads_total_development_cost(tmp_path):
    add(tmp_path, xlsx(COSTS))
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    conn = archive.connect(tmp_path / "t.db")
    rows = {r["project_name"]: r for r in conn.execute("SELECT * FROM award_row")}
    assert rows["A"]["total_development_cost"] == 30000000 and rows["B"]["total_development_cost"] == 20000000
    assert rows["C"]["total_development_cost"] is None and rows["A"]["cost_per_unit"] is None  # never computed here
    cmap = json.loads(conn.execute("SELECT column_map FROM award_sheet").fetchone()[0])
    assert cmap["total_development_cost"]["header"] == "Total Development Cost"
    assert "Construction Cost" not in [v["header"] for v in cmap.values()]


def test_cost_per_unit_summary_and_export(tmp_path):
    add(tmp_path, xlsx(COSTS))
    add(tmp_path, xlsx({"2025 4%": [["Project Name", "Sponsor", "Units", "TDC per Unit"], ["E", "V", 200, 350000]]}),
        sid="OH_AWARDS_2")
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    rows = {(r["state"], r["pathway"], r["year"]): r for r in costs.summarize(archive.connect(tmp_path / "t.db"))}
    nine = rows[("OH", "9%", 2025)]
    assert (nine["projects_with_cost"], nine["projects_total"]) == (2, 4)   # C has no cost, D has zero units
    assert nine["median_cost_per_unit"] == 350000 and (nine["min_cost_per_unit"], nine["max_cost_per_unit"]) == (300000, 400000)
    assert nine["cost_for_100_units_at_median"] == 35000000 and nine["basis"] == "total cost / units"
    four = rows[("OH", "4%", 2025)]
    assert four["median_cost_per_unit"] == 350000 and four["basis"] == "per-unit column"
    m = export_web.export(tmp_path / "t.db", tmp_path / "web", reference_dir=tmp_path / "noref")
    out = list(csv.DictReader(open(tmp_path / "web" / "cost_per_unit.csv")))
    assert m["counts"]["cost_per_unit"] == 2 and out[0]["sources"] and not (tmp_path / "web" / "top_msas.csv").exists()


def test_no_cost_data_is_unknown(tmp_path):
    add(tmp_path, xlsx({"2025 9%": [["Project Name", "Sponsor", "Annual Credit"], ["A", "X", 1]]}))
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    r = costs.summarize(archive.connect(tmp_path / "t.db"))[0]
    assert r["projects_with_cost"] == 0 and r["median_cost_per_unit"] == "UNKNOWN" and r["cost_for_100_units_at_median"] == "UNKNOWN"


def test_export_includes_msa_files_when_built(tmp_path):
    store_census(tmp_path, fake_census())
    msa.build(tmp_path / "t.db", tmp_path / "a", tmp_path / "ref")
    m = export_web.export(tmp_path / "t.db", tmp_path / "web", reference_dir=tmp_path / "ref")
    assert m["counts"]["top_msas"] == 100 and m["counts"]["states_in_top_msas"] == 52
    assert (tmp_path / "web" / "states_in_top_msas.csv").exists()


def test_volume_cap_and_cost_prompts_and_inventory():
    from src.inventory import crawl
    b = extract.prompt_bundle("bond_volume_cap")
    fields = b["schema"]["properties"]["findings"]["items"]["properties"]["field"]["enum"]
    assert {"volume_cap_total", "volume_cap_allocated", "oversubscription_statement", "carryforward"} <= set(fields)
    assert "Do not conclude" in b["instruction"]
    assert "tdc_per_unit_limit" in extract.prompt_bundle("cost_limits")["schema"]["properties"]["findings"]["items"]["properties"]["field"]["enum"]
    rules = crawl.load_rules()
    cats = {c["category"] for c in crawl.classify("2025 Private Activity Bond Volume Cap Report", "https://x/r.pdf", "", rules)}
    assert "volume_cap" in cats
