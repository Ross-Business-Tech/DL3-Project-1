import csv

import pytest
from openpyxl import load_workbook

from src.fetch import archive, fetch
from src.inventory import build, crawl
from src.inventory.states import match_state
from tests.test_fetch import SETTINGS, Site


@pytest.fixture
def site():
    s = Site()
    yield s
    s.srv.shutdown()


def agency_site(site):
    """A small fake housing agency: home -> developers -> LIHTC page with QAP, awards, underwriting."""
    html = lambda body, title="Agency": (200, "text/html", f"<html><head><title>{title}</title></head><body>{body}</body></html>".encode())  # noqa: E731
    site.routes["/"] = html('<a href="/homebuyers">Homebuyers</a><a href="/developers">Developers</a>'
                            '<a href="mailto:x@y.org">Email</a><a href="/about">About us</a>', "Home")
    site.routes["/developers"] = html('<a href="/developers/lihtc">Low Income Housing Tax Credits</a>'
                                      '<a href="/developers/bonds">Multifamily Bonds (4%)</a>', "Developers")
    site.routes["/developers/lihtc"] = html(
        '<h1>Low Income Housing Tax Credit Program</h1>'
        '<a href="/developers/qap">Qualified Allocation Plan</a>'
        '<a href="/files/2024/01/award_list.xlsx">2024 Tax Credit Awards</a>'
        '<a href="/files/awards-2023.pdf">2023 Awards</a>'
        '<a href="/files/uw.pdf">Underwriting Guidelines</a>'
        '<a href="/developers/round">2026 Application Round</a>'
        '<a href="https://cdn.example.com/2021_awards.pdf">2021 Awards (archive)</a>', "LIHTC")
    site.routes["/developers/qap"] = html(
        '<h1>Qualified Allocation Plan</h1>'
        '<a href="/files/2027-2028_QAP_Draft.pdf">2027-2028 Draft QAP for public comment</a>'
        '<a href="/files/2025-2026-qap.pdf">2025-2026 QAP</a>', "QAP")
    site.routes["/developers/bonds"] = html("<h1>Multifamily Bonds</h1>", "Bonds")
    site.routes["/developers/round"] = html("<h1>Round</h1>", "Round")
    site.routes["/homebuyers"] = html("<h1>Buy a home</h1>", "Homebuyers")
    site.routes["/about"] = html("<h1>About</h1>", "About")


def jur(site, jid="ZZ", **kw):
    j = {"jurisdiction_id": jid, "state": "ZZ", "jurisdiction_type": "state", "in_50_state_scope": "yes",
         "allocating_agency": "Test Housing Agency", "agency_url": site.base + "/", "path_prefix": "",
         "extra_hosts": "", "suballocator_of": "", "bond_issuer_note": "", "notes": ""}
    j.update(kw)
    return j


def run_crawl(site, tmp_path, js, rules=None):
    rules = rules or crawl.load_rules()
    factory = lambda hosts: fetch.Fetcher(SETTINGS, hosts, sleep=lambda s: None)  # noqa: E731
    return crawl.crawl_all(js, SETTINGS, rules, tmp_path / "t.db", fetcher_factory=factory, workers=2,
                           progress=lambda m: None)


def inventory(tmp_path, js, hud=None, overrides=None):
    conn = archive.connect(tmp_path / "t.db")
    status, cands = build.latest_candidates(conn)
    return {r["jurisdiction_id"]: r for r in build.build_rows(js, hud or [], status, cands, overrides or [])}


def test_crawl_finds_qap_awards_underwriting_with_evidence(site, tmp_path):
    agency_site(site)
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["qap_page_url"] == site.base + "/developers/qap"
    docs = r["qap_document_urls"].split("; ")
    assert docs[0].startswith(site.base + "/files/2027-2028_QAP_Draft.pdf") and "[draft]" in docs[0]
    assert r["plan_years"] == "2027–2028"
    assert r["qap_draft_or_final"].startswith("draft")
    assert r["underwriting_manual_url"] == site.base + "/files/uw.pdf"
    assert site.base + "/files/2024/01/award_list.xlsx" in r["award_list_urls"]
    assert "https://cdn.example.com/2021_awards.pdf" in r["award_list_urls"]  # offsite docs recorded, not fetched
    assert r["award_formats"] == "pdf, xlsx"
    assert r["award_years_available"] == "2021, 2023–2024"
    assert r["application_round_url"] == site.base + "/developers/round"
    assert r["bond_program_url"] == site.base + "/developers/bonds"
    assert "qap_page_url <- " in r["evidence"]
    assert r["verification_status"] == "candidates found: needs review"
    assert r["next_round_deadline"] == r["stated_fee_cap"] == "needs verification"


def test_crawl_stays_focused_and_on_site(site, tmp_path):
    agency_site(site)
    run_crawl(site, tmp_path, [jur(site)])
    conn = archive.connect(tmp_path / "t.db")
    urls = {r[0] for r in conn.execute("SELECT url FROM crawl_page")}
    assert site.base + "/homebuyers" not in urls      # skip rule
    assert not any("cdn.example.com" in u for u in urls)  # offsite never fetched
    assert "/files/uw.pdf" not in site.hits               # documents are listed, not downloaded
    assert all(not u.startswith("mailto") for u in urls)


def test_page_limit_respected(site, tmp_path):
    agency_site(site)
    rules = crawl.load_rules()
    rules["crawl"] = {**rules["crawl"], "max_pages_per_jurisdiction": 2}
    run_crawl(site, tmp_path, [jur(site)], rules)
    conn = archive.connect(tmp_path / "t.db")
    assert conn.execute("SELECT pages_fetched FROM crawl_status").fetchone()[0] == 2


def test_path_prefix_limits_shared_portals(site, tmp_path):
    agency_site(site)
    run_crawl(site, tmp_path, [jur(site, path_prefix="/developers/lihtc", agency_url=site.base + "/developers/lihtc")])
    conn = archive.connect(tmp_path / "t.db")
    urls = {r[0] for r in conn.execute("SELECT url FROM crawl_page")}
    assert urls == {site.base + "/developers/lihtc"}


def test_never_marks_final_and_unknown_draft_status(site, tmp_path):
    site.routes["/"] = (200, "text/html", b'<a href="/qap.pdf">2026 Qualified Allocation Plan</a>')
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["plan_years"] == "2026" and "final" not in r["qap_draft_or_final"].replace("never assumed final", "")


def test_unreachable_agency_reported_not_guessed(site, tmp_path):
    js = [jur(site, agency_url=site.base + "/gone")]
    run_crawl(site, tmp_path, js)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["verification_status"] == "crawl failed: see first_crawl_error"
    assert r["qap_page_url"] == "" and "HTTP 404" in r["first_crawl_error"]


def test_hud_cross_check_and_other_agencies(site, tmp_path):
    js = [jur(site, jid="MI", state="MI", agency_url="https://www.michigan.gov/mshda"),
          jur(site, jid="IL", state="IL", agency_url="https://www.ihda.org/"),
          jur(site, jid="CHI", state="IL", jurisdiction_type="city", agency_url="https://www.chicago.gov/doh",
              suballocator_of="IL", allocating_agency="Chicago DOH")]
    hud = [{"state": "MI", "agency_name": "MSHDA", "agency_url": "https://michigan.gov/mshda", "agency_host": "michigan.gov"},
           {"state": "IL", "agency_name": "IHDA", "agency_url": "https://www.ihda.gov/", "agency_host": "ihda.gov"},
           {"state": "IL", "agency_name": "Cook County", "agency_url": "https://cookcounty.gov", "agency_host": "cookcounty.gov"}]
    rows = build.build_rows(js, hud, {}, {}, [])
    by = {r["jurisdiction_id"]: r for r in rows}
    assert by["MI"]["hud_check"] == "matches HUD list"
    assert by["IL"]["hud_check"] == "differs from HUD list: check"
    assert "Cook County" in by["IL"]["other_hud_agencies"]
    assert "CHI" in by["IL"]["local_suballocators"]
    assert by["MI"]["verification_status"] == "not yet crawled"


def test_reviewer_overrides_win_and_drive_status(site, tmp_path):
    agency_site(site)
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    ov = [{"jurisdiction_id": "ZZ", "field": "qap_draft_or_final", "value": "final", "source_url": "u",
           "reviewer": "A. Reviewer", "reviewed_on": "2026-11-08", "note": ""}]
    r = inventory(tmp_path, js, overrides=ov)["ZZ"]
    assert r["qap_draft_or_final"] == "final" and r["verification_status"] == "partly verified"
    full = [dict(ov[0], field=f, value="x") for f in build.REVIEW_FIELDS]
    assert inventory(tmp_path, js, overrides=full)["ZZ"]["verification_status"] == "verified"


def test_overrides_reject_unknown_field_or_missing_reviewer(tmp_path):
    p = tmp_path / "o.csv"
    p.write_text("jurisdiction_id,field,value,source_url,reviewer,reviewed_on,note\nMI,qap_url,x,u,R,2026-11-08,\n")
    with pytest.raises(ValueError, match="unknown field"):
        build.load_overrides(p)
    p.write_text("jurisdiction_id,field,value,source_url,reviewer,reviewed_on,note\nMI,plan_years,2026,u,,2026-11-08,\n")
    with pytest.raises(ValueError, match="no reviewer"):
        build.load_overrides(p)


def test_one_broken_site_does_not_stop_others(site, tmp_path, monkeypatch):
    agency_site(site)
    real = crawl.crawl_jurisdiction

    def flaky(j, rules, fetcher):
        if j["jurisdiction_id"] == "BAD":
            raise RuntimeError("boom")
        return real(j, rules, fetcher)
    monkeypatch.setattr(crawl, "crawl_jurisdiction", flaky)
    js = [jur(site), jur(site, jid="BAD")]
    run_crawl(site, tmp_path, js)
    rows = inventory(tmp_path, js)
    assert rows["ZZ"]["qap_page_url"] and "crawler error" in rows["BAD"]["first_crawl_error"]


def test_excel_and_csv_written_for_every_jurisdiction(site, tmp_path):
    agency_site(site)
    js = crawl.load_jurisdictions()
    test_js = [jur(site)]
    run_crawl(site, tmp_path, test_js)
    path = build.build(db_path=tmp_path / "t.db", out_dir=tmp_path / "inv", hud_path=tmp_path / "none.csv",
                       overrides_path=tmp_path / "none.csv")
    wb = load_workbook(path)
    assert wb.sheetnames == ["Inventory", "Candidates", "HUD list", "Read me"]
    ws = wb["Inventory"]
    assert ws.max_row - 1 == len(js) and [c.value for c in ws[1]] == build.FIELDS
    rows = list(csv.DictReader(open(tmp_path / "inv" / "state_inventory.csv")))
    assert {r["jurisdiction_id"] for r in rows} == {j["jurisdiction_id"] for j in js}
    assert all(r["verification_status"] == "not yet crawled" for r in rows)  # real list, not crawled in test


def test_seed_list_covers_all_50_states_once():
    js = crawl.load_jurisdictions()
    states = [j for j in js if j["in_50_state_scope"] == "yes"]
    assert len(states) == 50 and len({j["state"] for j in states}) == 50
    assert len({j["jurisdiction_id"] for j in js}) == len(js)
    assert all(j["agency_url"].startswith("https://") for j in js)
    assert {"CHI", "NYC", "DC"} <= {j["jurisdiction_id"] for j in js}


def test_years_and_states_helpers():
    assert crawl.years_in("2027-28 QAP") == [2027, 2028]
    assert crawl.years_in("QAP 2025–2026 and 2024") == [2024, 2025, 2026]
    assert crawl.years_in("Form 8609") == []
    assert match_state("New York") == "NY" and match_state("West Virginia:") == "WV"
    assert match_state("Virginia") == "VA" and match_state("Kansas City Housing") is None
