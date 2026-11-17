import json
import os
import subprocess
import time

import pytest

import log_run


def sh(*args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def test_redaction_of_keys_paths_and_patterns(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text('GEMINI_API_KEY="AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake123"\nGEMINI_MODEL=gemini-x\nexport MY_TOKEN=abcdef123\n')
    secrets = log_run.secret_values(env={"ANTHROPIC_API_KEY": "sk-ant-zzzzzzzzzzzz", "PATH": "/usr/bin",
                                         "SHORT_KEY": "abc"}, env_files=[envf, tmp_path / "missing"])
    assert "gemini-x" not in secrets and "abc" not in secrets and "abcdef123" in secrets
    r = log_run.Redactor(secrets, home="/Users/student")
    text = ("key AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake123 and sk-ant-zzzzzzzzzzzz token abcdef123 in "
            "/Users/student/Code/x model gemini-x; other AIzaOTHERotherOTHERotherOTHERother9999 ghp_aaaaaaaaaaaaaaaaaaaaaaaa "
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123")
    out = r(text)
    for leak in ("AIza", "sk-ant-zz", "abcdef123", "/Users/student", "ghp_", "abcdefghijklmnopqrstuvwxyz123"):
        assert leak not in out
    assert "~/Code/x" in out and "gemini-x" in out and "Bearer [REDACTED]" in out


def test_run_command_captures_output_and_exit_codes(tmp_path):
    ok = log_run.run_command("echo hello && echo oops 1>&2", tmp_path, None)
    assert ok["exit_code"] == 0 and "hello" in ok["output"] and "oops" in ok["output"]
    bad = log_run.run_command("exit 3", tmp_path, None)
    assert bad["exit_code"] == 3
    slow = log_run.run_command("sleep 5", tmp_path, 1)
    assert slow["exit_code"] == -9 and "stopped after 1 s" in slow["output"]


def test_collect_only_outputs_changed_in_this_run(tmp_path):
    old = tmp_path / "outputs" / "awards" / "old.csv"
    old.parent.mkdir(parents=True)
    old.write_text("a\n")
    os.utime(old, (time.time() - 3600, time.time() - 3600))
    since = time.time() - 1
    new = tmp_path / "outputs" / "coverage" / "coverage.csv"
    new.parent.mkdir(parents=True)
    new.write_text("b\n")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "dl3.db").write_text("never")
    (tmp_path / ".env").write_text("never")
    assert log_run.collect_outputs(since, tmp_path) == [new]


def test_write_log_is_redacted_and_summarized(tmp_path):
    out = tmp_path / "outputs" / "coverage" / "coverage.csv"
    out.parent.mkdir(parents=True)
    out.write_text("jurisdiction_id,item\nMI,secretvalue123\n")
    r = log_run.Redactor(["secretvalue123"], home="/home/me")
    results = [{"command": "python -m pytest", "exit_code": 0, "seconds": 1.0, "output": "10 passed /home/me/x\n"},
               {"command": "python run_all.py", "exit_code": 1, "seconds": 2.0, "output": "Traceback\nboom secretvalue123\n"}]
    d = log_run.write_log("RUN1", results, {"python": "3.12"}, [out], r, tmp_path / "logs", root=tmp_path)
    summary = (d / "SUMMARY.md").read_text()
    assert "SOME COMMANDS FAILED" in summary and "| 2 | `python run_all.py` | 1 |" in summary
    assert "outputs/outputs/coverage/coverage.csv" in summary
    assert "secretvalue123" not in "".join(p.read_text() for p in d.rglob("*") if p.is_file())
    assert "~/x" in (d / "01_output.txt").read_text()
    assert json.loads((d / "result.json").read_text())["ok"] is False


def test_push_log_to_remote_without_touching_working_tree(tmp_path):
    remote = tmp_path / "remote.git"
    sh("git", "init", "-q", "--bare", str(remote), cwd=tmp_path)
    work = tmp_path / "work"
    sh("git", "clone", "-q", str(remote), str(work), cwd=tmp_path)
    for k, v in (("user.email", "t@example.org"), ("user.name", "T")):
        sh("git", "config", k, v, cwd=work)
    proj = work / "dl3-lihtc-model"
    proj.mkdir()
    (proj / "README.md").write_text("x\n")
    sh("git", "add", ".", cwd=work)
    sh("git", "commit", "-q", "-m", "init", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", cwd=work)
    (proj / "uncommitted.txt").write_text("my work in progress")      # must not be committed or lost
    log = tmp_path / "logs" / "RUN42"
    log.mkdir(parents=True)
    (log / "SUMMARY.md").write_text("ok")
    (log / "result.json").write_text(json.dumps({"ok": True}))
    # someone else pushes first: the log must land on top of their commit
    other = tmp_path / "other"
    sh("git", "clone", "-q", "-b", "main", str(remote), str(other), cwd=tmp_path)
    for k, v in (("user.email", "o@example.org"), ("user.name", "O")):
        sh("git", "config", k, v, cwd=other)
    (other / "theirs.txt").write_text("t")
    sh("git", "add", ".", cwd=other)
    sh("git", "commit", "-q", "-m", "theirs", cwd=other)
    sh("git", "push", "-q", "origin", "main", cwd=other)

    commit = log_run.push_log(log, "main", cwd=proj)
    files = sh("git", "ls-tree", "-r", "--name-only", "main", cwd=remote).splitlines()
    assert "dl3-lihtc-model/run_logs/RUN42/SUMMARY.md" in files and "theirs.txt" in files
    assert "dl3-lihtc-model/uncommitted.txt" not in files
    assert (proj / "uncommitted.txt").read_text() == "my work in progress"
    assert sh("git", "worktree", "list", cwd=work).count("\n") == 0     # temporary checkout removed
    assert commit and sh("git", "log", "-1", "--format=%s", "main", cwd=remote) == "Run log RUN42: ok"


def test_default_commands():
    a = log_run.main.__globals__["argparse"].Namespace(tests=False, cmd=None, pipeline=False, extract=None)
    assert log_run.build_commands(a, "py") == ["py -m pytest -q tests"]
    a.pipeline, a.extract = True, ["mi", "oh"]
    cmds = log_run.build_commands(a, "py")
    assert cmds[0] == "py run_all.py --awards --extract" and "py -m src.report.coverage MI OH" in cmds
    assert "py -m pytest -q tests" not in cmds and cmds[-1] == "py -m src.report.export_web"
