"""Fixes for failures seen in the first real 55-jurisdiction run (2026-11-08)."""
import os

import pytest

from src.fetch import archive, fetch
from src.inventory import build, crawl
from src.report import change_report
from tests.test_fetch import SETTINGS, Site, go, reg
from tests.test_inventory import inventory, jur, run_crawl

BROWSER = {"fetch": {**SETTINGS["fetch"], "browser_fallback": True, "timeout_seconds": 20}}


def browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch(executable_path=os.environ.get("DL3_CHROMIUM_PATH") or None).close()
        return True
    except Exception:
        return False


needs_browser = pytest.mark.skipif(not browser_available(), reason="headless Chromium not available")


@pytest.fixture
def site():
    s = Site()
    yield s
    s.srv.shutdown()


def html(body, title="Agency"):
    return (200, "text/html", f"<html><head><title>{title}</title></head><body>{body}</body></html>".encode())


# --- robots.txt (AZ, MA, MI, NV, UT, CHI were blocked) -------------------------------------------
def test_robots_403_means_no_rules_rfc9309(site, tmp_path):
    site.routes["/robots.txt"] = (403, "text/plain", b"forbidden")
    site.routes["/qap"] = html("ok")
    assert go(site, tmp_path, reg(site)).fetched == 1


def test_robots_server_error_means_disallow_with_reason(site, tmp_path):
    site.routes["/robots.txt"] = (500, "text/plain", b"err")
    site.routes["/qap"] = html("ok")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1 and "server error (HTTP 500)" in s.details[0]["error"]


def test_real_robots_disallow_still_respected_and_explained(site, tmp_path):
    site.routes["/robots.txt"] = (200, "text/plain", b"User-agent: *\nDisallow: /\n")
    site.routes["/qap"] = html("ok")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1 and "robots.txt rules at" in s.details[0]["error"] and "qap" not in str(site.hits)


# --- failure bookkeeping ------------------------------------------------------------------------
def test_attempts_recorded_accurately(site, tmp_path):
    go(site, tmp_path, reg(site, path="/missing"))
    conn = archive.connect(tmp_path / "t.db")
    assert conn.execute("SELECT attempts FROM fetch_failure").fetchone()[0] == 1


def test_bot_check_page_is_not_archived_as_content(site, tmp_path):
    site.routes["/qap"] = html("<p>Checking your browser before accessing...</p>")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1 and "bot-check" in s.details[0]["error"]


def test_missing_browser_gives_clear_error_not_crash(site, tmp_path, monkeypatch):
    monkeypatch.setenv("DL3_CHROMIUM_PATH", "/nonexistent/chrome")
    site.routes["/qap"] = (202, "text/html", b"<p>please wait</p>")
    f = fetch.Fetcher(BROWSER, {"127.0.0.1"}, sleep=lambda s: None)
    with pytest.raises(fetch.FetchError, match="playwright install chromium"):
        f.get(site.base + "/qap")
    f.close()


# --- browser fallback (HUD 202, GA/ilga TLS, VI JavaScript) ---------------------------------------
def ua_gate(headers):
    """Like HUD: a 202 holding page for scripts, the real page for a browser."""
    if "Chrome" in (headers.get("User-Agent") or ""):
        return html('<table><tr><td>Michigan</td><td><a href="https://www.michigan.gov/mshda">MSHDA</a></td></tr></table>')
    return (202, "text/html", b"<html><body>Request accepted</body></html>")


@needs_browser
def test_http_202_retried_in_browser_and_archived_with_method(site, tmp_path):
    site.dynamic["/qap"] = ua_gate
    f = fetch.Fetcher(BROWSER, {"127.0.0.1"}, sleep=lambda s: None)
    s = fetch.run(reg(site), BROWSER, tmp_path / "t.db", tmp_path / "a", fetcher=f)
    f.close()
    assert s.fetched == 1 and s.details[0]["method"] == "browser"
    snap = archive.latest_snapshot(archive.connect(tmp_path / "t.db"), "T1")
    assert snap["retrieval_method"] == "browser"
    assert b"MSHDA" in (tmp_path / "a" / snap["archive_path"]).read_bytes()


@needs_browser
def test_browser_never_used_for_robots_blocked_pages(site, tmp_path):
    site.routes["/robots.txt"] = (200, "text/plain", b"User-agent: *\nDisallow: /qap\n")
    site.dynamic["/qap"] = ua_gate
    f = fetch.Fetcher(BROWSER, {"127.0.0.1"}, sleep=lambda s: None)
    with pytest.raises(fetch.FetchError, match="robots"):
        f.get(site.base + "/qap")
    f.close()
    assert "/qap" not in site.hits


@needs_browser
def test_javascript_homepage_crawled_with_browser(site, tmp_path):
    js_links = ("<script>for (const [h,t] of [['/lihtc','Low Income Housing Tax Credits'],"
                "['/qap','Qualified Allocation Plan']]) {const a=document.createElement('a');a.href=h;"
                "a.textContent=t;document.body.appendChild(a);}</script>")
    site.routes["/"] = html(js_links, "Virgin Islands HFA")
    site.routes["/qap"] = html('<a href="/2026_QAP.pdf">2026 Qualified Allocation Plan</a>', "QAP")
    site.routes["/lihtc"] = html("LIHTC", "LIHTC")
    js = [jur(site)]
    factory = lambda hosts: fetch.Fetcher(BROWSER, hosts, sleep=lambda s: None)  # noqa: E731
    crawl.crawl_all(js, BROWSER, crawl.load_rules(), tmp_path / "t.db", fetcher_factory=factory, workers=1,
                    progress=lambda m: None)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["crawl_method"].startswith("browser")
    assert site.base + "/2026_QAP.pdf" in r["qap_document_urls"]


# --- agency moved (IA, MT, NH, ND, SC) ----------------------------------------------------------
def test_homepage_redirect_to_new_site_is_followed_and_reported(site, tmp_path):
    new = f"http://localhost:{site.srv.server_port}"
    site.routes["/"] = (301, "text/html", (new + "/home").encode())
    site.routes["/home"] = html('<a href="/developers/qap">Qualified Allocation Plan</a>', "New site")
    site.routes["/developers/qap"] = html('<a href="/qap-2026.pdf">2026 QAP</a>', "QAP")
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["agency_moved_to"] == new + "/home"
    assert r["qap_page_url"] == new + "/developers/qap"


def test_redirect_on_inner_page_still_blocked(site, tmp_path):
    site.routes["/qap"] = (302, "text/html", f"http://localhost:{site.srv.server_port}/x".encode())
    assert go(site, tmp_path, reg(site)).failed == 1


# --- QAP not found (CA, WA, AK, DC, WV) ---------------------------------------------------------
def test_state_specific_qap_name(site, tmp_path):
    site.routes["/"] = html('<a href="/programs/regs">TCAC Regulations</a>', "California Tax Credit Allocation Committee")
    js = [jur(site, qap_aliases=r"tcac\s+regulations;\bregulations\b")]
    run_crawl(site, tmp_path, js)
    assert inventory(tmp_path, js)["ZZ"]["qap_page_url"] == site.base + "/programs/regs"
    js2 = [jur(site, jid="Z2")]  # without the alias, not a QAP
    run_crawl(site, tmp_path, js2)
    assert inventory(tmp_path, js2)["Z2"]["qap_page_url"] == ""


def test_sitemap_reaches_deep_pages_menus_hide(site, tmp_path):
    site.routes["/"] = html("".join(f'<a href="/housing/p{i}">Housing program {i}</a>' for i in range(40)))
    for i in range(40):
        site.routes[f"/housing/p{i}"] = html("".join(f'<a href="/housing/p{i}/{k}">Housing info</a>' for k in range(5)))
    site.routes["/sitemap.xml"] = (200, "application/xml",
        b'<?xml version="1.0"?><urlset><url><loc>%s/partners/multifamily/tax-credits/qap</loc></url></urlset>'
        % site.base.encode())
    site.routes["/partners/multifamily/tax-credits/qap"] = html(
        '<h1>Qualified Allocation Plan</h1><a href="/q.pdf">2026 QAP</a>', "QAP")
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    assert inventory(tmp_path, js)["ZZ"]["qap_page_url"] == site.base + "/partners/multifamily/tax-credits/qap"


def test_generic_housing_links_do_not_crowd_out_tax_credit_links(site, tmp_path):
    rules = crawl.load_rules()
    assert crawl._follow_score("Multifamily Tax Credits", "/developers/tax-credits", rules) > \
        crawl._follow_score("Housing Programs for Housing Partners", "/housing/programs", rules)


def test_image_links_are_not_errors(site, tmp_path):
    site.routes["/"] = html('<a href="/developers/thing">Developer resources</a><a href="/developers/logo.png">Developer logo</a>')
    site.routes["/developers/thing"] = (200, "image/png", b"\x89PNG")
    js = [jur(site)]
    run_crawl(site, tmp_path, js)
    assert inventory(tmp_path, js)["ZZ"]["crawl_errors"] == 0
    assert "/developers/logo.png" not in site.hits


# --- change report noise (P3, P4, P8 "changed" every run) ---------------------------------------
def test_page_furniture_change_is_not_reported_as_change(site, tmp_path):
    site.routes["/qap"] = html("<script>t=1</script><p>Same rules</p>")
    go(site, tmp_path, reg(site))
    site.routes["/qap"] = html("<script>t=2</script><p>Same rules</p>")
    f = fetch.Fetcher(SETTINGS, {"127.0.0.1"}, sleep=lambda s: None)
    conn = archive.connect(tmp_path / "t.db")
    archive.start_run(conn, "r2")
    fetch.run(reg(site), SETTINGS, tmp_path / "t.db", tmp_path / "archive", fetcher=f, run_id="r2")
    ctx = change_report.build_context(archive.connect(tmp_path / "t.db"), tmp_path / "archive", "r2", 90)
    assert ctx["counts"]["changed"] == 0 and ctx["counts"]["unchanged"] == 1 and ctx["furniture_only"] == ["T1"]


def test_crawl_status_records_start_error(site, tmp_path):
    js = [jur(site, agency_url=site.base + "/gone")]
    run_crawl(site, tmp_path, js)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["first_crawl_error"] == "HTTP 404" and r["verification_status"] == "crawl failed: see first_crawl_error"


def test_moved_agencies_updated_in_seed_list():
    by = {j["jurisdiction_id"]: j for j in crawl.load_jurisdictions()}
    assert by["NH"]["agency_url"] == "https://www.nhhousing.org/"
    assert by["SC"]["agency_url"] == "https://schousing.sc.gov/"
    assert "regulations" in by["CA"]["qap_aliases"]
    assert all(c in build.FIELDS for c in ("agency_moved_to", "crawl_method"))


# --- wrong picks seen in the 2026-11-08 run (real link texts / URLs) ---------------------------------
def cand(jid, category, url, text, kind="document", years="", draft=0, offsite=0, score=2):
    return {"jurisdiction_id": jid, "category": category, "url": url, "link_text": text, "kind": kind,
            "file_format": "pdf" if kind == "document" else "html", "found_on_url": "https://agency/qap",
            "found_on_sha256": "x", "score": score, "years": years, "draft_marker": draft, "offsite": offsite,
            "depth": 1, "retrieved_at": "t", "run_id": "r"}


def rows_for(cands):
    js = [{"jurisdiction_id": "ZZ", "state": "ZZ", "jurisdiction_type": "state", "in_50_state_scope": "yes",
           "allocating_agency": "A", "agency_url": "https://agency/", "suballocator_of": "", "bond_issuer_note": "",
           "notes": ""}]
    st = {"ZZ": {"pages_fetched": 30, "errors": 0, "first_error": None, "finished_at": "t", "run_id": "r"}}
    return build.build_rows(js, [], st, {"ZZ": cands}, [])[0]


def test_newsletter_and_video_links_never_chosen():
    r = rows_for([cand("ZZ", "qap", "https://conta.cc/3Ikb6ib", "Qualified Allocation Plan", "page", offsite=1, score=9),
                  cand("ZZ", "qap", "https://youtu.be/M0MndkLx8zs", "QAP overview", "page", offsite=1, score=9),
                  cand("ZZ", "qap", "https://agency/hubfs/2021+QAP+Workshop+Recording", "2021 QAP Workshop Recording", "page", score=9),
                  cand("ZZ", "qap", "https://agency/qap", "Qualified Allocation Plan", "page", score=2)])
    assert r["qap_page_url"] == "https://agency/qap"


def test_redline_appendix_and_notices_ranked_below_the_plan():
    r = rows_for([
        cand("ZZ", "qap", "https://agency/Redlined-2027-2028-QAP-Changes-from-2026-QAP.pdf",
             "Redlined 2027-2028 QAP Changes from 2026 QAP", years="2026,2027,2028"),
        cand("ZZ", "qap", "https://agency/2026-2027-QAP-Appendices.zip", "2026-2027 QAP Appendices", years="2026,2027"),
        cand("ZZ", "qap", "https://cdn/MF_2026-Public-Notice-for-2027-LIHTC-QAP.pdf", "Public Notice for 2027 LIHTC QAP",
             years="2026,2027", offsite=1),
        cand("ZZ", "qap", "https://agency/2027-2028-QAP.pdf", "2027-2028 Qualified Allocation Plan", years="2027,2028"),
    ])
    assert r["qap_document_urls"].startswith("https://agency/2027-2028-QAP.pdf [2027–2028]")
    assert "[related document]" in r["qap_document_urls"]
    assert r["plan_years"] == "2027–2028"


def test_plan_years_use_the_range_not_every_year_mentioned():
    assert crawl.plan_years("Redlined 2027-2028 QAP Changes from 2026 QAP") == [2027, 2028]
    assert crawl.plan_years("Signed VHFA 2024-25 Vermont QAP amended 2026") == [2024, 2025]
    assert crawl.plan_years("2026 QAP final 11.14.25") == [2026]


def test_draft_never_hides_current_plan():
    r = rows_for([cand("ZZ", "qap", "https://agency/2027QAP-SecondDraft.pdf", "2027 QAP Second Draft", years="2027", draft=1),
                  cand("ZZ", "qap", "https://agency/2026-QAP.pdf", "2026 Qualified Allocation Plan", years="2026")])
    assert r["qap_draft_or_final"].startswith("draft") and r["plan_years"] == "2027"
    assert r["qap_current_nondraft_url"] == "https://agency/2026-QAP.pdf"
    assert r["qap_current_nondraft_years"] == "2026"


def test_only_related_documents_found_is_flagged():
    r = rows_for([cand("ZZ", "qap", "https://agency/2025-qap-notice-of-public-hearing.pdf",
                       "2025 QAP notice of public hearing", years="2025")])
    assert r["qap_draft_or_final"].startswith("only related documents") and r["qap_current_nondraft_url"] == ""


# --- second real run (2026-11-09): AK, WV, ND, GA ---------------------------------------------------
def test_extra_start_urls_crawled_first(site, tmp_path):
    site.routes["/"] = html("".join(f'<a href="/housing/p{i}">Housing program {i}</a>' for i in range(60)))
    site.routes["/pros/homelessness/development-grants/goal"] = html(
        '<a href="/download_file/view/9334/546">Alaska GOAL Qualified Allocation Plan 2026</a>', "GOAL")
    js = [jur(site, extra_start_urls=site.base + "/pros/homelessness/development-grants/goal")]
    rules = crawl.load_rules()
    rules["crawl"] = {**rules["crawl"], "max_pages_per_jurisdiction": 3}
    run_crawl(site, tmp_path, js, rules)
    r = inventory(tmp_path, js)["ZZ"]
    assert r["qap_document_urls"].startswith(site.base + "/download_file/view/9334/546")
    assert r["plan_years"] == "2026"


def test_cms_download_links_are_documents_not_pages():
    assert crawl.file_format("https://dca.georgia.gov/document/qualified-allocation-plans-qaps/2022qap/download") == "file"
    assert crawl.file_format("https://www.ahfc.us/download_file/view/9334/546") == "file"
    assert crawl.file_format("https://www.chfainfo.com/getattachment/0978/2027-2028-QAP.pdf") == "pdf"
    assert crawl.file_format("https://example.gov/developers/download-center") is None


def test_allocation_plan_alias_and_old_document_host():
    by = {j["jurisdiction_id"]: j for j in crawl.load_jurisdictions()}
    assert "ndhfa.org" in crawl.hosts_for(by["ND"]) and "www.ndhfa.org" in crawl.hosts_for(by["ND"])
    rules = crawl.jurisdiction_rules(by["WV"], crawl.load_rules())
    cats = {c["category"] for c in crawl.classify("2025 and 2026 Allocation Plan", "https://www.wvhdf.com/x.pdf", "", rules)}
    assert "qap" in cats
    plain = {c["category"] for c in crawl.classify("2025 and 2026 Allocation Plan", "https://x/x.pdf", "", crawl.load_rules())}
    assert "qap" not in plain  # alias is per state, not global (HOME/HTF also have "allocation plans")
    assert by["GA"]["agency_url"] == "https://dca.georgia.gov/"


# --- third real run (2026-11-15) --------------------------------------------------------------------
def pdf_bytes():
    import pymupdf
    d = pymupdf.open()
    d.new_page().insert_text((72, 72), "Qualified Allocation Plan 2026")
    return d.tobytes()


@needs_browser
def test_browser_handles_pdf_that_downloads(site, tmp_path):
    """michigan.gov: 403 for scripts, and Chrome saves the PDF as a download instead of showing it."""
    body = pdf_bytes()

    def gate(headers):
        if "Chrome" not in (headers.get("User-Agent") or ""):
            return (403, "text/html", b"<html>Access denied</html>")
        return (200, "application/octet-stream", body)
    site.dynamic["/-/media/qap.pdf"] = gate
    f = fetch.Fetcher(BROWSER, {"127.0.0.1"}, sleep=lambda s: None)
    try:
        resp, attempts = f.get(site.base + "/-/media/qap.pdf")
    finally:
        f.close()
    assert resp.method == "browser" and resp.content_type == "application/pdf" and resp.body == body


@needs_browser
def test_browser_download_of_unknown_type_refused(site, tmp_path):
    def gate(headers):
        if "Chrome" not in (headers.get("User-Agent") or ""):
            return (403, "text/html", b"denied")
        return (200, "application/octet-stream", b"MZ\x90\x00 not a document")
    site.dynamic["/thing.bin"] = gate
    f = fetch.Fetcher(BROWSER, {"127.0.0.1"}, sleep=lambda s: None)
    try:
        with pytest.raises(fetch.FetchError, match="unrecognised type"):
            f.get(site.base + "/thing.bin")
    finally:
        f.close()


def test_census_html_error_is_explained():
    from src.reference import msa
    with pytest.raises(ValueError, match="Census did not send data. It said: error: unknown variable"):
        msa.parse(b"<html><body><p>error: unknown variable 'B01003_001E'</p></body></html>")
    with pytest.raises(ValueError, match="It said: Sorry, the system is currently undergoing maintenance"):
        msa.parse(b"Sorry, the system is currently undergoing maintenance.")


def test_pathway_and_year_read_from_file_name(tmp_path):
    from src.awards import parse_awards as pa
    from tests.test_awards import xlsx
    conn = archive.connect(tmp_path / "t.db")
    for sid, url in (("OH_A", "https://ohiohome.org/ppd/documents/2026-9-LIHTC-Reservations.xlsx"),
                     ("OH_B", "https://ohiohome.org/ppd/documents/SFY-2027-4PctHTC-Results.xlsx"),
                     ("OH_C", "https://ohiohome.org/ppd/documents/2014-LIHTC-Results.xlsx")):
        src = {"source_id": sid, "jurisdiction": "OHFA", "state": "OH", "doc_type": "award_list", "title": "OH award list",
               "url": url, "status": "unknown", "critical": 0, "notes": ""}
        archive.upsert_source(conn, src)
        archive.store_snapshot(conn, tmp_path / "a", source=src, final_url=url, requested_url=url, http_status=200,
                               content_type=pa.XLSX, data=xlsx({"Reservations": [["Project Name", "Sponsor", "Annual Credit"],
                                                                                 [sid, "X", 1000]]}))
    s = pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    rows = {r["project_name"]: dict(r) for r in conn.execute("SELECT * FROM award_row")}
    assert (rows["OH_A"]["credit_type"], rows["OH_A"]["credit_type_basis"], rows["OH_A"]["award_year"]) == ("9%", "file name", 2026)
    assert (rows["OH_B"]["credit_type"], rows["OH_B"]["award_year"]) == ("4%", 2027)
    assert rows["OH_C"]["credit_type"] == "unknown" and rows["OH_C"]["award_year"] == 2014   # "2014-LIHTC" is not 4%
    assert s["flag_reasons"]["credit type (9% or 4%) not stated"] == 1
