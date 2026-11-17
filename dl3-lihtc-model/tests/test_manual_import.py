import csv

import pytest

from src.fetch import archive, fetch, manual_import
from src.fetch.manual_import import ImportError_
from tests.test_fetch import SETTINGS, Site, make_pdf

SET = {"fetch": {**fetch.load_settings()["fetch"], "max_bytes": 200000}}
REG_HEADER = ("source_id,jurisdiction,state,doc_type,title,url,status,critical,notes,plan_year,adoption_date,"
              "effective_dates,amendment_date,superseded_by,retrieval\n")


@pytest.fixture
def env(tmp_path):
    reg = tmp_path / "reg.csv"
    reg.write_text(REG_HEADER + "P6,MSHDA,MI,qap_page,MSHDA QAP page,https://www.michigan.gov/mshda/qap,unknown,true,,,,,,,\n")
    jur = tmp_path / "jur.csv"
    jur.write_text("jurisdiction_id,state,jurisdiction_type,in_50_state_scope,allocating_agency,agency_url,path_prefix,"
                   "extra_hosts,suballocator_of,bond_issuer_note,qap_aliases,extra_start_urls,notes\n"
                   "NV,NV,state,yes,Nevada Housing Division,https://housing.nv.gov/,,,,,,,\n")
    return {"inventory_dir": tmp_path / "inv", "db_path": tmp_path / "t.db", "archive_root": tmp_path / "a", "register_path": reg, "settings": SET,
            "jurisdictions_path": jur, "tmp": tmp_path}


def kw(env):
    return {k: v for k, v in env.items() if k != "tmp"}


def qap_file(env, name="2026-QAP.pdf", text="The developer fee shall not exceed 15% of total development cost."):
    f = env["tmp"] / name
    f.write_bytes(make_pdf(text))
    return f


NEW = dict(url="https://housing.nv.gov/programs/2026-QAP.pdf", jurisdiction="nv", doc_type="qap_doc",
           title="Nevada 2026 QAP", by="Test Person")


def test_new_manual_source_archived_with_full_record(env):
    f = qap_file(env)
    r = manual_import.import_file(f, **NEW, **kw(env))
    assert r["result"] == "first version" and r["new_register_row"] and r["candidate_pages"] >= 1
    assert r["source_id"].startswith("NV_QAP_DOC_")
    conn = archive.connect(env["db_path"])
    snap = archive.latest_snapshot(conn, r["source_id"])
    assert snap["retrieval_method"] == "manual" and snap["retrieved_by"] == "Test Person"
    assert snap["import_note"] == "file: 2026-QAP.pdf" and snap["doc_status"] == "unknown"
    assert snap["url"] == NEW["url"] and snap["sha256"] == archive.sha256_bytes(f.read_bytes())
    assert snap["archive_path"].startswith("NV/qap_doc/") and (env["archive_root"] / snap["archive_path"]).exists()
    row = [x for x in csv.DictReader(open(env["register_path"])) if x["source_id"] == r["source_id"]][0]
    assert row["retrieval"] == "manual" and row["critical"] == "true" and row["status"] == "unknown"
    assert "manual source added" in row["notes"] and row["jurisdiction"] == "Nevada Housing Division"
    assert "Test Person" not in env["register_path"].read_text()  # names stay out of the committed register
    assert archive.freshness(conn, r["source_id"], True, 90)["stale"] is False


def test_manual_sources_are_not_fetched_automatically(env):
    r = manual_import.import_file(qap_file(env), **NEW, **kw(env))
    site = Site()
    try:
        f = fetch.Fetcher(SETTINGS, {"housing.nv.gov", "www.michigan.gov"}, sleep=lambda s: None)
        s = fetch.run(fetch.load_register(env["register_path"]), SETTINGS, env["db_path"], env["archive_root"],
                      fetcher=f, only={r["source_id"]})
    finally:
        site.srv.shutdown()
    assert s.manual == 1 and s.fetched == 0 and s.failed == 0
    conn = archive.connect(env["db_path"])
    assert conn.execute("SELECT COUNT(*) FROM fetch_failure").fetchone()[0] == 0


def test_second_version_detects_change_and_same_file_is_duplicate(env):
    f = qap_file(env)
    r1 = manual_import.import_file(f, **NEW, **kw(env))
    again = manual_import.import_file(f, source_id=r1["source_id"], by="Test Person", **kw(env))
    assert again["result"] == "same as last version" and not again["new_register_row"]
    changed = manual_import.import_file(qap_file(env, text="The developer fee shall not exceed 12% of cost."),
                                        source_id=r1["source_id"], by="Other Person", **kw(env))
    assert changed["result"] == "changed" and changed["change"]["text_diff"]["added_lines"] >= 1
    assert len(list(csv.DictReader(open(env["register_path"])))) == 2  # no duplicate register rows


def test_existing_failed_source_import_clears_queue(env):
    conn = archive.connect(env["db_path"])
    archive.upsert_source(conn, {"source_id": "P6", "jurisdiction": "MSHDA", "state": "MI", "doc_type": "qap_page",
                                 "title": "MSHDA QAP page", "url": "https://www.michigan.gov/mshda/qap",
                                 "status": "unknown", "critical": 1, "notes": ""})
    archive.record_failure(conn, "P6", "https://www.michigan.gov/mshda/qap", 1, "disallowed by robots.txt")
    assert [s["source_id"] for s in manual_import.queue(env["db_path"])["sources"]] == ["P6"]
    page = env["tmp"] / "saved.html"
    page.write_text("<!DOCTYPE html><html><body><h1>Qualified Allocation Plan</h1><p>Application deadline: "
                    "February 1, 2027</p></body></html>")
    r = manual_import.import_file(page, source_id="P6", by="Test Person", manual_only=True, **kw(env))
    assert r["content_type"] == "text/html" and r["queue_cleared"] == 1
    assert manual_import.queue(env["db_path"])["sources"] == []
    row = [x for x in csv.DictReader(open(env["register_path"])) if x["source_id"] == "P6"][0]
    assert row["retrieval"] == "manual"


def test_queue_lists_unreadable_agency_sites(env):
    conn = archive.connect(env["db_path"])
    conn.execute("INSERT INTO crawl_status (run_id, jurisdiction_id, pages_fetched, errors, first_error, finished_at, "
                 "start_error) VALUES ('r','NV',0,1,'x','2026-11-09','disallowed by robots.txt')")
    conn.execute("INSERT INTO crawl_status (run_id, jurisdiction_id, pages_fetched, errors, first_error, finished_at) "
                 "VALUES ('r','MI',40,0,NULL,'2026-11-09')")
    conn.commit()
    q = manual_import.queue(env["db_path"])
    assert [s["jurisdiction_id"] for s in q["agency_sites"]] == ["NV"]


@pytest.mark.parametrize("change,needle", [
    ({"by": ""}, "--by is required"),
    ({"url": "https://novoco.com/nv-qap.pdf"}, "own website"),
    ({"jurisdiction": "XX"}, "not in config/jurisdictions.csv"),
    ({"status": "approved"}, "draft, final or unknown"),
    ({"retrieved_on": "11/10/2026"}, "must look like"),
    ({"retrieved_on": "2999-01-01"}, "future"),
    ({"title": None}, "--title"),
])
def test_refusals_change_nothing(env, change, needle):
    before = env["register_path"].read_text()
    with pytest.raises(ImportError_, match=needle):
        manual_import.import_file(qap_file(env), **{**NEW, **change}, **kw(env))
    assert env["register_path"].read_text() == before and not env["archive_root"].exists()


def test_third_party_host_allowed_only_when_flagged_and_noted(env):
    r = manual_import.import_file(qap_file(env), **{**NEW, "url": "https://files.example.org/nv-qap.pdf"},
                                  third_party_host=True, **kw(env))
    row = [x for x in csv.DictReader(open(env["register_path"])) if x["source_id"] == r["source_id"]][0]
    assert "not the agency's own site (files.example.org)" in row["notes"]


def test_bad_files_refused(env):
    t = env["tmp"]
    cases = {
        "fake.pdf": (b"just some text pretending", "not recognised"),
        "tool.exe": (b"MZ\x90\x00binary", "not recognised"),
        "empty.pdf": (b"", "empty"),
        "check.html": (b"<html><body>Checking your browser before accessing</body></html>", "checking your browser"),
        "archive.zip": (b"PK\x03\x04zipdata", "extension"),
        "big.pdf": (b"%PDF-" + b"0" * 300000, "larger than"),
    }
    for name, (data, needle) in cases.items():
        (t / name).write_bytes(data)
        with pytest.raises(ImportError_, match=needle):
            manual_import.import_file(t / name, **NEW, **kw(env))
    with pytest.raises(ImportError_, match="file not found"):
        manual_import.import_file(t / "nope.pdf", **NEW, **kw(env))
    assert not env["archive_root"].exists()


def test_unknown_source_id_explains_what_is_missing(env):
    with pytest.raises(ImportError_, match="not in the register"):
        manual_import.import_file(qap_file(env), source_id="NOPE", by="Test Person", **kw(env))


def test_retrieved_on_date_and_note_recorded(env):
    r = manual_import.import_file(qap_file(env), **NEW, retrieved_on="2026-11-01", note="saved from Chrome", **kw(env))
    snap = archive.latest_snapshot(archive.connect(env["db_path"]), r["source_id"])
    assert snap["retrieved_at"].startswith("2026-11-01") and "saved from Chrome" in snap["import_note"]
    assert snap["archive_path"].split("/")[-1].startswith("20261101_")


def test_cli_messages(env, capsys):
    args = ["--db", str(env["db_path"]), "--archive", str(env["archive_root"]), "--register", str(env["register_path"])]
    assert manual_import.main(["--list", *args]) == 0
    assert "Nothing is waiting" in capsys.readouterr().out
    assert manual_import.main([str(qap_file(env)), "--source-id", "NOPE", "--by", "T", *args]) == 1
    assert "Not imported" in capsys.readouterr().out


def inv_row(env, jid="NV"):
    return {r["jurisdiction_id"]: r for r in csv.DictReader(open(env["inventory_dir"] / "state_inventory.csv"))}[jid]


def test_import_updates_inventory_row(env):
    conn = archive.connect(env["db_path"])
    conn.execute("INSERT INTO crawl_status (run_id, jurisdiction_id, pages_fetched, errors, first_error, finished_at, "
                 "start_error) VALUES ('r','NV',0,1,'x','2026-11-09','disallowed by robots.txt')")
    conn.commit()
    r = manual_import.import_file(qap_file(env), **NEW, **kw(env))
    row = inv_row(env)
    assert row["qap_document_urls"] == NEW["url"] + " [2026] [manual import]"
    assert row["plan_years"] == "2026" and row["qap_current_nondraft_url"] == NEW["url"]
    assert row["qap_draft_or_final"].startswith("unknown")          # importing never makes it final
    assert row["verification_status"] == "manual import: needs review"
    assert "manual import" in row["evidence"] and r["source_id"] in row["evidence"]
    assert row["first_crawl_error"] == "disallowed by robots.txt"   # the crawl failure stays visible
    assert "Test Person" not in (env["inventory_dir"] / "state_inventory.csv").read_text()


def test_draft_manual_qap_does_not_become_current_and_other_doc_types(env):
    manual_import.import_file(qap_file(env, "d.pdf"), **{**NEW, "url": "https://housing.nv.gov/2027-draft-qap.pdf",
                              "title": "Nevada 2027 QAP draft"}, status="draft", **kw(env))
    manual_import.import_file(qap_file(env, "uw.pdf", "Underwriting"), **{**NEW, "doc_type": "underwriting",
                              "url": "https://housing.nv.gov/uw.pdf", "title": "NV underwriting"}, **kw(env))
    manual_import.import_file(qap_file(env, "aw.pdf", "Awards"), **{**NEW, "doc_type": "award_list",
                              "url": "https://housing.nv.gov/awards-2025.pdf", "title": "NV awards 2025"}, **kw(env))
    row = inv_row(env)
    assert "[draft] [manual import]" in row["qap_document_urls"] and row["qap_draft_or_final"].startswith("draft")
    assert row["qap_current_nondraft_url"] == "" and row["plan_years"] == "2027"
    assert row["underwriting_manual_url"] == "https://housing.nv.gov/uw.pdf"
    assert row["award_list_urls"] == "https://housing.nv.gov/awards-2025.pdf" and row["award_formats"] == "pdf"


def test_reviewer_override_still_wins_over_manual_import(env):
    from src.inventory import build
    manual_import.import_file(qap_file(env), **NEW, **kw(env))
    ov = env["tmp"] / "ov.csv"
    ov.write_text("jurisdiction_id,field,value,source_url,reviewer,reviewed_on,note\n"
                  "NV,qap_draft_or_final,final,u,Reviewer,2026-11-10,\n")
    build.build(db_path=env["db_path"], out_dir=env["inventory_dir"], jurisdictions_path=env["jurisdictions_path"],
                register_path=env["register_path"], overrides_path=ov)
    row = inv_row(env)
    assert row["qap_draft_or_final"] == "final" and row["verification_status"] == "partly verified"
