"""Run tests and/or pipeline commands, save everything they print plus key outputs, and push the log to GitHub.

Logs go to dl3-lihtc-model/run_logs/<run id>/ on the GitHub branch (default: the branch you are on), so the
whole team (and Claude) can read exactly what happened on your computer. Your working folder is not touched:
the log is committed from a temporary checkout, and a local copy is kept in outputs/run_logs/.

    python log_run.py                                   # run the test suite, push the log
    python log_run.py --pipeline                        # tests, then run_all.py --awards, coverage and export
    python log_run.py --pipeline --extract MI OH IN     # ... also LLM extraction, coverage for these states
    python log_run.py --cmd "python run_all.py --inventory GA"   # any command(s); repeat --cmd for more
    python log_run.py --no-push                         # keep the log local only

Safety: the repository is public. Before anything is written, values of environment variables and .env entries
whose names contain KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL are replaced with [REDACTED], as are common
API-key formats; your home folder path is replaced with ~. Only text files are logged; the database, archive
and .env are never included.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_SUBDIR = ROOT.name                     # "dl3-lihtc-model"
LOG_DIR_IN_REPO = "run_logs"
SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL", re.I)
SECRET_PATTERNS = [
    re.compile(r"AIza[0-9A-Za-z_\-]{30,}"),                 # Google / Gemini API keys
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),               # Anthropic
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                      # other "sk-" keys
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),               # GitHub tokens
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{20,}"),
]
MAX_FILE_BYTES = 5 * 1024 * 1024
# Outputs worth keeping, if this run created or changed them.
OUTPUT_GLOBS = [
    "outputs/runs/*/run_manifest.json", "outputs/runs/*/change_report.json",
    "outputs/coverage/*.csv", "outputs/awards/*.csv", "data/web/*.csv", "data/web/manifest.json",
    "data/inventory/state_inventory.csv", "data/reference/*.csv", "outputs/extract/*.csv",
]


# --- redaction ---------------------------------------------------------------------------------------------
def secret_values(env: dict | None = None, env_files: list[Path] | None = None) -> list[str]:
    vals = set()
    for k, v in (env if env is not None else os.environ).items():
        if SECRET_NAME.search(k) and v and len(v) >= 6:
            vals.add(v)
    for f in env_files if env_files is not None else [ROOT / ".env", ROOT.parent / ".env"]:
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            k, _, v = line.strip().removeprefix("export ").partition("=")
            v = v.strip().strip("\"'")
            if SECRET_NAME.search(k) and len(v) >= 6:
                vals.add(v)
    return sorted(vals, key=len, reverse=True)


class Redactor:
    def __init__(self, secrets: list[str], home: str | None = None):
        self.secrets = secrets
        self.home = home if home is not None else str(Path.home())

    def __call__(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, "[REDACTED]")
        for rx in SECRET_PATTERNS:
            text = rx.sub(lambda m: (m.group(1) if m.groups() else "") + "[REDACTED]", text)
        if self.home and len(self.home) > 1:
            text = text.replace(self.home, "~")
        return text


# --- running ----------------------------------------------------------------------------------------------
def run_command(cmd: str, cwd: Path, timeout: int | None) -> dict:
    """Run one command, capture stdout+stderr interleaved, echo it live."""
    start = time.time()
    lines = []
    try:
        proc = subprocess.Popen(cmd, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace", bufsize=1, start_new_session=True)

        def pump():  # read output on a thread so the time limit can still fire
            for line in proc.stdout:
                sys.stdout.write(line)
                lines.append(line)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # the shell and everything it started
            except (OSError, AttributeError):
                proc.kill()
            proc.wait()
            code = -9
        reader.join(timeout=5)
        if code == -9:
            lines.append(f"\n[log_run] stopped after {timeout} s\n")
    except OSError as e:
        lines.append(f"[log_run] could not start: {e}\n")
        code = 127
    return {"command": cmd, "exit_code": code, "seconds": round(time.time() - start, 1), "output": "".join(lines)}


def environment_report(redact: Redactor) -> dict:
    def out(*args):
        try:
            return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            return ""
    pkgs = {}
    for name in ("requests", "beautifulsoup4", "pymupdf", "openpyxl", "xlrd", "playwright", "google-genai",
                 "anthropic", "truststore", "pytest"):
        try:
            from importlib.metadata import version
            pkgs[name] = version(name)
        except Exception:
            pkgs[name] = "not installed"
    tess = shutil.which("tesseract")
    env_names = sorted(k for k in os.environ if k.startswith(("GEMINI", "ANTHROPIC", "LLM_", "DL3_")))
    return {
        "python": sys.version.split()[0], "os": f"{platform.system()} {platform.release()} {platform.machine()}",
        "git_commit": out("git", "rev-parse", "--short", "HEAD"), "git_branch": out("git", "rev-parse", "--abbrev-ref", "HEAD"),
        "uncommitted_files": [redact(x) for x in out("git", "status", "--short").splitlines()[:50]],
        "packages": pkgs, "tesseract": "yes" if tess else "no",
        "env_vars_set (names only)": env_names,
    }


def collect_outputs(since: float, root: Path = ROOT) -> list[Path]:
    found = []
    for pattern in OUTPUT_GLOBS:
        for p in root.glob(pattern):
            if p.is_file() and p.stat().st_mtime >= since and p.stat().st_size <= MAX_FILE_BYTES:
                found.append(p)
    return sorted(set(found))


def write_log(run_id: str, results: list[dict], env: dict, outputs: list[Path], redact: Redactor, dest: Path,
              root: Path = ROOT) -> Path:
    d = dest / run_id
    (d / "outputs").mkdir(parents=True, exist_ok=True)
    ok = all(r["exit_code"] == 0 for r in results)
    lines = [f"# Run {run_id}", "", f"Result: {'all commands succeeded' if ok else 'SOME COMMANDS FAILED'}", "",
             "| # | command | exit code | seconds |", "|---|---|---|---|"]
    for i, r in enumerate(results, 1):
        lines.append(f"| {i} | `{redact(r['command'])}` | {r['exit_code']} | {r['seconds']} |")
        tail = [ln for ln in r["output"].strip().splitlines() if ln.strip()][-3:]
        if tail:
            lines.append(f"|   | last lines: {redact(' / '.join(tail))[:300].replace('|', '/')} | | |")
        (d / f"{i:02d}_output.txt").write_text(redact(f"$ {r['command']}\n\n{r['output']}"), encoding="utf-8")
    lines += ["", "## Outputs saved", ""] + ([f"- outputs/{p.relative_to(root).as_posix()}" for p in outputs] or ["- none"])
    lines += ["", "## Environment", "", "```json", redact(json.dumps(env, indent=2)), "```", ""]
    (d / "SUMMARY.md").write_text("\n".join(lines), encoding="utf-8")
    for p in outputs:
        target = d / "outputs" / p.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.write_text(redact(p.read_text(encoding="utf-8")), encoding="utf-8")
        except UnicodeDecodeError:
            continue  # not text: never logged
    (d / "result.json").write_text(json.dumps({"run_id": run_id, "ok": ok, "commands": [
        {k: (redact(v) if isinstance(v, str) else v) for k, v in r.items() if k != "output"} for r in results]},
        indent=2), encoding="utf-8")
    return d


# --- pushing ------------------------------------------------------------------------------------------------
def git(*args, cwd: Path, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)


def default_branch(cwd: Path = ROOT) -> str:
    up = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", cwd=cwd, check=False).stdout.strip()
    if up and "/" in up:
        return up.split("/", 1)[1]
    return git("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd).stdout.strip()


def push_log(log_dir: Path, branch: str, remote: str = "origin", cwd: Path = ROOT, attempts: int = 4) -> str:
    """Commit log_dir into run_logs/ on `branch` from a temporary worktree and push it. Returns the commit."""
    top = Path(git("rev-parse", "--show-toplevel", cwd=cwd).stdout.strip())
    sub = Path(os.path.relpath(cwd, top)) / LOG_DIR_IN_REPO / log_dir.name
    tmp = Path(tempfile.mkdtemp(prefix="dl3-runlog-"))
    wt = tmp / "wt"
    have_remote = git("fetch", remote, branch, cwd=top, check=False).returncode == 0
    base = f"{remote}/{branch}" if have_remote else "HEAD"
    git("worktree", "add", "--detach", str(wt), base, cwd=top)
    try:
        dest = wt / sub
        shutil.copytree(log_dir, dest)
        git("add", "-f", str(sub), cwd=wt)
        ok = json.loads((log_dir / "result.json").read_text())["ok"]
        git("commit", "-m", f"Run log {log_dir.name}: {'ok' if ok else 'FAILED'}", "--no-verify", cwd=wt)
        delay = 2
        for i in range(attempts):
            p = git("push", remote, f"HEAD:refs/heads/{branch}", cwd=wt, check=False)
            if p.returncode == 0:
                return git("rev-parse", "--short", "HEAD", cwd=wt).stdout.strip()
            if i == attempts - 1:
                raise RuntimeError(f"push failed: {p.stderr.strip()[-300:]}")
            # someone pushed in between: put the log commit on top of theirs and try again
            git("fetch", remote, branch, cwd=wt, check=False)
            r = git("rebase", f"{remote}/{branch}", cwd=wt, check=False)
            if r.returncode != 0:
                git("rebase", "--abort", cwd=wt, check=False)
                raise RuntimeError(f"could not rebase the log onto {remote}/{branch}: {r.stderr.strip()[-300:]}")
            time.sleep(delay)
            delay *= 2
    finally:
        git("worktree", "remove", "--force", str(wt), cwd=top, check=False)
        shutil.rmtree(tmp, ignore_errors=True)
    raise RuntimeError("push failed")


# --- main ----------------------------------------------------------------------------------------------------
def build_commands(a, py: str) -> list[str]:
    cmds = []
    if a.tests or not (a.cmd or a.pipeline):
        cmds.append(f"{py} -m pytest -q tests")
    if a.pipeline:
        run = f"{py} run_all.py --awards" + (" --extract" if a.extract is not None else "")
        cmds.append(run)
        cmds.append(f"{py} -m src.awards.costs")
        if a.extract:
            cmds.append(f"{py} -m src.report.coverage " + " ".join(shlex.quote(x.upper()) for x in a.extract))
        cmds.append(f"{py} -m src.report.export_web")
    cmds += a.cmd or []
    return cmds


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", action="append", help="a command to run and log (repeatable)")
    ap.add_argument("--tests", action="store_true", help="run the test suite (default when nothing else is given)")
    ap.add_argument("--pipeline", action="store_true",
                    help="run_all.py --awards, cost summary and website export (add --extract to include the LLM)")
    ap.add_argument("--extract", nargs="*", metavar="ID",
                    help="with --pipeline: also run LLM extraction; IDs given here get a coverage report")
    ap.add_argument("--branch", help="GitHub branch for the log (default: the branch you are on)")
    ap.add_argument("--no-push", action="store_true", help="keep the log on this computer only")
    ap.add_argument("--timeout", type=int, help="seconds before a command is stopped")
    a = ap.parse_args(argv)

    redact = Redactor(secret_values())
    host = hashlib.sha256(platform.node().encode()).hexdigest()[:6]
    run_id = f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{platform.system().lower()}-{host}"
    started = time.time() - 1
    py = shlex.quote(sys.executable)
    results = []
    for cmd in build_commands(a, py):
        print(f"\n[log_run] $ {redact(cmd)}", flush=True)
        results.append(run_command(cmd, ROOT, a.timeout))
    outputs = collect_outputs(started)
    log = write_log(run_id, results, environment_report(redact), outputs, redact, ROOT / "outputs" / "run_logs")
    ok = all(r["exit_code"] == 0 for r in results)
    print(f"\n[log_run] {'all commands succeeded' if ok else 'SOME COMMANDS FAILED'}; log at {log}")
    if not a.no_push:
        branch = a.branch or default_branch()
        try:
            commit = push_log(log, branch)
            print(f"[log_run] pushed to GitHub: branch {branch}, {REPO_SUBDIR}/{LOG_DIR_IN_REPO}/{run_id} (commit {commit})")
            print(f"[log_run] to get it locally later: git pull --no-rebase --no-edit origin {branch}")
        except (RuntimeError, subprocess.CalledProcessError) as e:
            msg = e.stderr if isinstance(e, subprocess.CalledProcessError) else str(e)
            print(f"[log_run] NOT pushed ({redact(str(msg)).strip()[-300:]}). The local log is still at {log}")
            return 2
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
