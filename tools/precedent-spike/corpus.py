#!/usr/bin/env python
"""F0 / T0.1 - build the precedent corpus snapshot (read-only, offline).

Inputs
  .spike-precedent/linear.jsonl   node tools/precedent-spike/fetch-linear.mjs
  telemetry parquet cache         canonical views via the analysis project (fenix.data / fenix.tasks)
  .state/supervisor/*             children.json (turns, rounds), gates/, verdicts/
  git history of local repos      commits whose SUBJECT names a FOC/JOI ticket (files, functions)
  transcript files                original path, or the 2026-09-10 retention archive
Outputs (all under .spike-precedent/, git-ignored)
  corpus.jsonl          one case per ticket (text included - never commit)
  git_commits.jsonl     tagged commits (subject, files, functions)
  corpus-summary.json   aggregate counts
  corpus-report.md      counts only, no ticket text

Usage: python tools/precedent-spike/corpus.py [--skip-funcs]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from common import (DATA, DENY_SLUG, EXCLUDE_PROJECTS, GITHUB_ROOT, NOISE_PROJECTS, NOISE_TITLE, STATE, TICKET_IN_TEXT,
                    TICKET_RE, read_jsonl, slug_allowed, use_analysis_package, utf8_stdout, write_jsonl)

ACTIVE_GAP_S = 600           # gaps between consecutive messages above this are idle, not work
CODE_EXT = {".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".ps1", ".sql", ".css", ".html", ".R"}
MAX_FILES_PER_COMMIT = 250
ARCHIVE = STATE / "transcript-archive-20260910"
YES = re.compile(r"^\s*(tak|yes|ok|okay|zatwierdz|approve|approved|akcept|go)\b", re.I)
NO = re.compile(r"^\s*(nie|no|reject|odrzu)\b", re.I)


def clean(v):
    """JSON-safe: NaN/NaT -> None, numpy -> python, Timestamp -> ISO string."""
    if v is None:
        return None
    if isinstance(v, (pd.Timestamp,)):
        return None if pd.isna(v) else v.isoformat()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [clean(x) for x in v]
    if v is pd.NaT:
        return None
    return v


# --------------------------------------------------------------------------- Linear
def load_linear() -> dict[str, dict]:
    out = {}
    for r in read_jsonl(DATA / "linear.jsonl"):
        r["noise"] = (r.get("project") in NOISE_PROJECTS) or bool(NOISE_TITLE.match(r.get("title") or ""))
        # reopen = a move to a non-completed state AFTER the first completed state
        hist = sorted(r.get("history") or [], key=lambda h: h["at"])
        seen_done, reopened = False, False
        for h in hist:
            if h.get("toType") == "completed":
                seen_done = True
            elif seen_done and h.get("toType") in ("started", "unstarted", "backlog"):
                reopened = True
        r["reopened"] = reopened
        out[r["id"]] = r
    return out


# --------------------------------------------------------------------------- telemetry
def telemetry_table():
    use_analysis_package()
    from fenix import data, tasks as T  # type: ignore

    fr = data.load(refresh=False, verbose=False)
    usage, tools, runs, links = fr["usage"], fr["tool_calls"], fr["runs"], fr["run_task_links"]
    usage_t = T.assign_tasks(usage, links)
    tools_t = T.assign_tasks(tools, links)
    tt = T.build_task_table(usage_t, tools_t, runs)
    alloc = T.allocate_supervisor_overhead(usage, runs, links)
    tt = T.add_loaded_cost(tt, alloc)

    u = usage_t[usage_t["task_id"].notna()].sort_values(["task_id", "observed_at"])
    kids = u[u["squad"].isin(["plan", "dev", "review", "test"])]
    tt["llm_turns"] = kids.groupby("task_id").size().reindex(tt.index).fillna(0).astype(int)
    tt["llm_turns_all"] = tt["msgs"]
    for sq in ("plan", "dev", "review", "test"):
        tt[f"turns_{sq}"] = kids[kids.squad == sq].groupby("task_id").size().reindex(tt.index).fillna(0).astype(int)
        tt[f"runs_{sq}"] = kids[kids.squad == sq].groupby("task_id")["run_id"].nunique().reindex(tt.index).fillna(0).astype(int)
    gap = u.groupby("task_id")["observed_at"].diff().dt.total_seconds()
    tt["active_min"] = (gap.where(gap <= ACTIVE_GAP_S, 0).groupby(u["task_id"]).sum() / 60).reindex(tt.index).fillna(0.0)

    # transcripts per task (through run<->task links); the archive keeps files pruned on 2026-09-10
    ts = fr["transcript_sources"][["source_path", "run_id"]].drop_duplicates()
    rl = links[["run_id", "task_id"]].drop_duplicates()
    real = rl[rl["task_id"].str.match(TICKET_RE.pattern)]
    arch = {}
    if ARCHIVE.exists():
        for p in ARCHIVE.rglob("*.jsonl"):
            arch.setdefault(p.name, p)
    m = real.merge(ts, on="run_id", how="left").dropna(subset=["source_path"]).drop_duplicates(["task_id", "source_path"])
    m["on_disk"] = m["source_path"].map(lambda p: Path(p).exists())
    m["in_archive"] = (~m["on_disk"]) & m["source_path"].map(lambda p: Path(p).name in arch)
    m["path"] = [sp if od else (str(arch[Path(sp).name]) if ia else None)
                 for sp, od, ia in zip(m["source_path"], m["on_disk"], m["in_archive"])]
    m["size"] = [Path(x).stat().st_size if isinstance(x, str) else 0 for x in m["path"]]
    m = m.merge(runs[["run_id", "squad", "started_at"]], on="run_id", how="left")
    m["repo_slug"] = m["source_path"].str.extract(r"projects[\\/]C--Users-mateu-(.+?)[\\/]")[0]
    m["chain_ok"] = m["repo_slug"].map(slug_allowed)
    m["chain_ok_available"] = m["chain_ok"] & (m["on_disk"] | m["in_archive"])
    tr = m.groupby("task_id").agg(n_transcripts=("source_path", "size"), n_on_disk=("on_disk", "sum"),
                                 n_in_archive=("in_archive", "sum"), n_chain_ok=("chain_ok", "sum"),
                                 n_chain_ok_available=("chain_ok_available", "sum"),
                                 repo_slugs=("repo_slug", lambda s: dict(Counter(s.dropna()))))
    tt = tt.join(tr)
    return tt, m, fr


# --------------------------------------------------------------------------- .state/supervisor
def supervisor_state() -> dict[str, dict]:
    base = STATE / "supervisor"
    per: dict[str, dict] = defaultdict(lambda: dict(sessions=set(), child_turns=0, gate_turns=0, review_loop_turns=0,
                                                    children=[], verdicts=[], gates=[], state_rounds=0))
    for sdir in sorted(base.iterdir()) if base.exists() else []:
        if not sdir.is_dir():
            continue
        cj = sdir / "children.json"
        if cj.exists():
            try:
                j = json.loads(cj.read_text(encoding="utf8"))
            except Exception:
                j = {}
            for cid, c in (j.get("children") or {}).items():
                t = c.get("taskId")
                if not t:
                    continue
                turns = c.get("turns") or []
                p = per[t]
                p["sessions"].add(sdir.name)
                p["child_turns"] += len(turns)
                p["gate_turns"] += sum(1 for x in turns if x.get("gateId"))
                p["review_loop_turns"] += sum(1 for x in turns if x.get("reviewLoop"))
                p["children"].append(dict(session=sdir.name, child=cid, squad=c.get("squad"), status=c.get("status"),
                                          turns=len(turns), model=c.get("model"), cost_usd=c.get("costUsd"),
                                          exit=c.get("exitCode"), branch=c.get("branch")))
            for tid, r in (j.get("rounds") or {}).items():
                per[tid]["state_rounds"] = max(per[tid]["state_rounds"], int(r.get("rounds") or 0))
        gd = sdir / "gates"
        if gd.exists():
            for f in sorted(gd.glob("*.json")):
                try:
                    g = json.loads(f.read_text(encoding="utf8"))
                except Exception:
                    continue
                t = g.get("taskId")
                if not t:
                    continue
                txt = ((g.get("answer") or {}).get("text") or "").strip()
                kind = g.get("kind")
                approved = None
                if kind in ("cleanup-approval", "push-approval") and txt:
                    approved = False if NO.match(txt) else (True if YES.match(txt) else None)
                per[t]["sessions"].add(sdir.name)
                per[t]["gates"].append(dict(session=sdir.name, kind=kind, squad=g.get("squad"), approved=approved,
                                            answered=bool(txt), answer_head=txt[:30], created=g.get("createdAt"),
                                            answered_at=(g.get("answer") or {}).get("answeredAt")))
        vd = sdir / "verdicts"
        if vd.exists():
            for f in sorted(vd.glob("*.json")):
                try:
                    v = json.loads(f.read_text(encoding="utf8"))
                except Exception:
                    continue
                t = v.get("taskId")
                if not t:
                    continue
                sev = Counter((x.get("severity") or "?") for x in (v.get("findings") or []))
                per[t]["sessions"].add(sdir.name)
                per[t]["verdicts"].append(dict(session=sdir.name, squad=v.get("squad"), round=v.get("round"),
                                               verdict=v.get("verdict"), n_findings=len(v.get("findings") or []),
                                               severities=dict(sev), ac_mapped=len(v.get("acMapping") or []),
                                               declared_acs=v.get("declaredAcs"),
                                               changed_files=(v.get("fingerprint") or {}).get("changedFiles"),
                                               at=v.get("recordedAt")))
    for p in per.values():
        p["sessions"] = sorted(p["sessions"])
    return per


# --------------------------------------------------------------------------- git
def _git(repo: Path, *args, timeout=120) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout)
    return r.stdout


def tagged_commits(repos: list[Path]) -> list[dict]:
    out = []
    fmt = "%H%x1f%aI%x1f%P%x1f%s%x1f%b%x1e"
    for repo in repos:
        raw = _git(repo, "log", "--all", f"--format={fmt}")
        for rec in raw.split("\x1e"):
            rec = rec.strip("\n")
            if not rec:
                continue
            parts = rec.split("\x1f")
            if len(parts) < 5:
                continue
            sha, at, parents, subj, body = parts[0], parts[1], parts[2], parts[3], parts[4]
            tickets = sorted({f"{a.upper()}-{n}" for a, n in TICKET_IN_TEXT.findall(subj)})
            if not tickets:
                continue
            out.append(dict(repo=repo.name, sha=sha, at=at, merge=len(parents.split()) > 1, subject=subj,
                            body=body[:1500], tickets=tickets))
    return out


def commit_files_funcs(repo: Path, sha: str, want_funcs: bool) -> dict:
    raw = _git(repo, "show", "-U0", "-M", "--format=", "--no-color", sha, timeout=180)
    files, funcs, adds, dels = [], set(), 0, 0
    cur = None
    for line in raw.splitlines():
        if line.startswith("diff --git "):
            cur = None
        elif line.startswith("+++ "):
            path = line[4:].strip()
            cur = None if path == "/dev/null" else path[2:] if path.startswith("b/") else path
            if cur:
                files.append(cur)
        elif line.startswith("--- "):
            path = line[4:].strip()
            if path != "/dev/null" and (not files or files[-1] != path[2:]):
                pass
        elif line.startswith("@@") and want_funcs and cur and Path(cur).suffix in CODE_EXT:
            m = re.match(r"^@@ [^@]*@@\s*(.*)$", line)
            if m and m.group(1).strip():
                funcs.add(f"{cur}::{m.group(1).strip()[:120]}")
        elif line.startswith("+") and not line.startswith("+++"):
            adds += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    # deleted files only appear on the '---' side; recover them from the name-status view
    if not files:
        ns = _git(repo, "show", "--name-only", "--format=", "--no-color", sha)
        files = [x for x in ns.splitlines() if x.strip()]
    return dict(files=sorted(set(files)), funcs=sorted(funcs), additions=adds, deletions=dels)


def git_index(want_funcs: bool) -> tuple[list[dict], list[str]]:
    repos = sorted(d for d in GITHUB_ROOT.iterdir() if (d / ".git").exists())
    commits = tagged_commits(repos)
    t0 = time.time()
    n = 0
    for c in commits:
        if c["merge"]:
            c.update(files=[], funcs=[], additions=0, deletions=0)
            continue
        info = commit_files_funcs(GITHUB_ROOT / c["repo"], c["sha"], want_funcs)
        if len(info["files"]) > MAX_FILES_PER_COMMIT:
            info["files"] = info["files"][:MAX_FILES_PER_COMMIT]
            info["truncated"] = True
        c.update(info)
        n += 1
        if n % 200 == 0:
            print(f"  git: {n} commits ({time.time() - t0:.0f}s)", file=sys.stderr)
    return commits, [r.name for r in repos]


# --------------------------------------------------------------------------- assemble
def tnum(t: str) -> tuple[str, int]:
    a, b = t.split("-")
    return a, int(b)


def main():
    utf8_stdout()
    want_funcs = "--skip-funcs" not in sys.argv
    t0 = time.time()
    lin = load_linear()
    print(f"linear: {len(lin)} issues", file=sys.stderr)
    tt, tr_map, _fr = telemetry_table()
    tel = tt[tt.index.to_series().str.match(TICKET_RE.pattern)]
    print(f"telemetry: {len(tel)} FOC/JOI tickets ({time.time() - t0:.0f}s)", file=sys.stderr)
    sup = supervisor_state()
    print(f"supervisor state: {len(sup)} tasks", file=sys.stderr)
    if "--reuse-git" in sys.argv and (DATA / "git_commits.jsonl").exists():
        commits = read_jsonl(DATA / "git_commits.jsonl")
        repos_scanned = sorted({c["repo"] for c in commits})
    else:
        commits, repos_scanned = git_index(want_funcs)
        write_jsonl(DATA / "git_commits.jsonl", commits)
    print(f"git: {len(commits)} tagged commits ({time.time() - t0:.0f}s)", file=sys.stderr)

    by_ticket: dict[str, list[dict]] = defaultdict(list)
    for c in commits:
        for t in c["tickets"]:
            by_ticket[t].append(c)

    ids = sorted({t for t in lin if TICKET_RE.match(t)} | set(tel.index), key=tnum)
    cases = []
    for tid in ids:
        L = lin.get(tid)
        T_ = tel.loc[tid] if tid in tel.index else None
        S = sup.get(tid)
        G = by_ticket.get(tid, [])
        case = dict(id=tid, team=tid.split("-")[0], in_linear=L is not None)
        if L:
            case.update(project=L.get("project"), title=L["title"], description=L["description"], state=L["state"],
                        state_type=L["stateType"], labels=L["labels"], parent=L["parent"], relations=L["relations"],
                        priority=L["priority"], estimate=L["estimate"], created=L["createdAt"],
                        started=L["startedAt"], completed=L["completedAt"], canceled=L["canceledAt"],
                        comments=L["comments"], noise=L["noise"], reopened=L["reopened"])
        else:
            case.update(project=None, title=None, description="", state=None, state_type=None, labels=[], parent=None,
                        relations=[], comments=[], noise=False, reopened=False)
        if T_ is not None:
            case["tel"] = clean(dict(
                first_ts=T_["first_ts"], last_ts=T_["last_ts"], era=T_["era"], settled=bool(T_["settled"]),
                cost_direct=T_["cost_usd"], cost_loaded=T_["cost_loaded"], llm_turns=T_["llm_turns"],
                llm_turns_all=T_["llm_turns_all"], active_min=T_["active_min"], n_runs=T_["n_runs"],
                squads=T_["squads"], tool_calls=T_.get("tool_calls"), tool_errors=T_.get("tool_errors"),
                turns_by_squad={s: T_[f"turns_{s}"] for s in ("plan", "dev", "review", "test")},
                runs_by_squad={s: T_[f"runs_{s}"] for s in ("plan", "dev", "review", "test")},
                done={s: bool(T_[f"done_{s}"]) for s in ("plan", "dev", "review", "test")},
                unpriced_msgs=T_["unpriced_msgs"],
                transcripts=dict(n=T_.get("n_transcripts"), on_disk=T_.get("n_on_disk"),
                                 in_archive=T_.get("n_in_archive"), chain_ok=T_.get("n_chain_ok"),
                                 chain_ok_available=T_.get("n_chain_ok_available"),
                                 repo_slugs=T_.get("repo_slugs"))))
        else:
            case["tel"] = None
        if S:
            case["sup"] = clean(dict(sessions=S["sessions"], child_turns=S["child_turns"], gate_turns=S["gate_turns"],
                                     review_loop_turns=S["review_loop_turns"], state_rounds=S["state_rounds"],
                                     children=S["children"], verdicts=S["verdicts"], gates=S["gates"]))
        else:
            case["sup"] = None
        if G:
            files = sorted({f for c in G for f in c.get("files", [])})
            funcs = sorted({f for c in G for f in c.get("funcs", [])})
            repos = Counter(c["repo"] for c in G if not c["merge"]) or Counter(c["repo"] for c in G)
            case["git"] = dict(n_commits=sum(1 for c in G if not c["merge"]), n_merges=sum(1 for c in G if c["merge"]),
                               repos=dict(repos), files=files, funcs=funcs, shas=[c["sha"][:12] for c in G],
                               first_at=min(c["at"] for c in G), last_at=max(c["at"] for c in G),
                               additions=sum(c.get("additions", 0) for c in G),
                               deletions=sum(c.get("deletions", 0) for c in G))
        else:
            case["git"] = None

        # quality gates (D1 / D8)
        v0 = bool(L and L["stateType"] == "completed")
        verdicts = (case["sup"] or {}).get("verdicts") or []
        gates = (case["sup"] or {}).get("gates") or []
        test_verdict = any(v["squad"] == "test" and v["verdict"] == "pass" for v in verdicts)
        test_run = bool(case["tel"] and case["tel"]["done"]["test"])
        review_pass = any(v["squad"] == "review" and v["verdict"] == "pass" for v in verdicts)
        human = any(g["approved"] is True for g in gates)
        human_neg = any(g["approved"] is False for g in gates)
        test_pass = test_verdict or test_run
        reasons = []
        if not v0:
            reasons.append("not_done_in_linear")
        if v0 and not test_pass:
            reasons.append("no_test_pass_evidence")
        if v0 and test_pass and not human:
            reasons.append("no_human_approval_record")
        if case["reopened"]:
            reasons.append("reopened")
        # scope (D5 + R33): FOC/JOI team, still in Linear, not automated intake, not a personal-life project
        reason = None
        if not L:
            reason = "moved_out_or_deleted"
        elif L["noise"]:
            reason = "auto_intake_noise"
        elif L.get("project") in EXCLUDE_PROJECTS:
            reason = "personal_project"
        else:
            slugs = ((case["tel"] or {}).get("transcripts") or {}).get("repo_slugs") or {}
            tot = sum(slugs.values())
            deny = sum(n for sl, n in slugs.items() if DENY_SLUG.search(sl))
            if tot and deny / tot >= 0.5:
                reason = "denylisted_workdir"   # runs happened in personal-finance / tax / hobby working directories
        case["scope"] = dict(in_scope=reason is None, excluded_reason=reason)
        rr_ver = [v["round"] for v in verdicts if v["squad"] == "review" and v.get("round")]
        if rr_ver:
            rounds, rsrc = max(rr_ver), "verdict"
        elif S and S["state_rounds"]:
            rounds, rsrc = S["state_rounds"], "state"
        elif case["tel"] and case["tel"]["runs_by_squad"]["review"]:
            rounds, rsrc = case["tel"]["runs_by_squad"]["review"], "review_runs"
        else:
            rounds, rsrc = None, None
        tl = case["tel"] or {}
        case["effort"] = dict(llm_turns=tl.get("llm_turns"), child_turns=(S or {}).get("child_turns"),
                              review_rounds=rounds, review_rounds_src=rsrc, cost_loaded=tl.get("cost_loaded"),
                              cost_direct=tl.get("cost_direct"), active_min=tl.get("active_min"))
        case["quality"] = dict(v0=v0, test_verdict_pass=test_verdict, test_run_done=test_run, review_verdict_pass=review_pass,
                               human_approved=human, human_rejected=human_neg, test_pass=test_pass,
                               v1=v0 and test_pass, v2=v0 and test_pass and human and not case["reopened"],
                               v2_relaxed=v0 and human and (test_pass or review_pass) and not case["reopened"],
                               reasons=reasons)
        cases.append(case)

    n = write_jsonl(DATA / "corpus.jsonl", cases)
    print(f"wrote {n} cases -> {DATA / 'corpus.jsonl'} ({time.time() - t0:.0f}s)", file=sys.stderr)
    write_summary(cases, commits, repos_scanned, tr_map)
    scope_ok = {c["id"]: c for c in cases if c["scope"]["in_scope"]}
    tm = tr_map[tr_map["task_id"].isin(scope_ok) & tr_map["chain_ok_available"]].copy()
    tm["v0"] = tm["task_id"].map(lambda t: scope_ok[t]["quality"]["v0"])
    tm["v2"] = tm["task_id"].map(lambda t: scope_ok[t]["quality"]["v2"])
    tm["era"] = tm["task_id"].map(lambda t: (scope_ok[t]["tel"] or {}).get("era"))
    write_jsonl(DATA / "transcripts.jsonl", tm[["task_id", "run_id", "squad", "started_at", "path", "size", "repo_slug", "v0", "v2", "era"]]
                .to_dict("records"))
    print(f"transcripts (in scope, allowlisted, available): {len(tm)} files, {tm['size'].sum() / 1e6:.0f} MB", file=sys.stderr)


def write_summary(cases, commits, repos_scanned, tr_map):
    df = pd.DataFrame([{
        "id": c["id"], "team": c["team"], "in_linear": c["in_linear"], "noise": c["noise"], "project": c.get("project"),
        "in_scope": c["scope"]["in_scope"], "excl": c["scope"]["excluded_reason"],
        "state_type": c["state_type"], "tel": c["tel"] is not None, "sup": c["sup"] is not None, "git": c["git"] is not None,
        "era": (c["tel"] or {}).get("era"), "v0": c["quality"]["v0"], "v1": c["quality"]["v1"], "v2": c["quality"]["v2"],
        "v2r": c["quality"]["v2_relaxed"], "test_verdict": c["quality"]["test_verdict_pass"],
        "test_run": c["quality"]["test_run_done"], "human": c["quality"]["human_approved"],
        "reopened": c["reopened"], "desc_len": len(c.get("description") or ""),
        "n_comments": len(c.get("comments") or []),
    } for c in cases])
    s = {}
    s["cases"] = len(df)
    s["by_team"] = df.groupby("team").size().to_dict()
    s["not_in_linear_snapshot"] = int((~df.in_linear).sum())
    s["noise_auto_intake"] = int(df.noise.sum())
    live = df[df.in_scope]
    s["excluded_by_reason"] = df[~df.in_scope].groupby("excl").size().to_dict()
    s["in_scope"] = len(live)
    sc = df[df.in_scope]
    s["scope"] = dict(cases=len(sc), with_telemetry=int(sc.tel.sum()), with_git=int(sc.git.sum()),
                      v0=int(sc.v0.sum()), v1=int(sc.v1.sum()), v2=int(sc.v2.sum()), v2_relaxed=int(sc.v2r.sum()),
                      v2_by_era=sc[sc.v2].groupby("era", dropna=False).size().to_dict(),
                      v0_with_telemetry=int((sc.v0 & sc.tel).sum()), v0_with_git=int((sc.v0 & sc.git).sum()),
                      v0_desc_over_200=int((sc.v0 & (sc.desc_len > 200)).sum()))
    s["with_telemetry"] = int(df.tel.sum())
    s["with_supervisor_state"] = int(df.sup.sum())
    s["with_git_commits"] = int(df.git.sum())
    s["completed_in_linear"] = int(live.v0.sum())
    s["v0"] = int(df.v0.sum())
    s["v1"] = int(df.v1.sum())
    s["v2"] = int(df.v2.sum())
    s["v2_relaxed"] = int(df.v2r.sum())
    s["v2_by_era"] = df[df.v2].groupby("era", dropna=False).size().to_dict()
    s["v1_by_era"] = df[df.v1].groupby("era", dropna=False).size().to_dict()
    s["v0_with_telemetry"] = int((df.v0 & df.tel).sum())
    s["v0_with_git"] = int((df.v0 & df.git).sum())
    s["v0_with_desc"] = int((df.v0 & (df.desc_len > 200)).sum())
    s["test_verdict_pass_tasks"] = int(df.test_verdict.sum())
    s["test_run_done_tasks"] = int(df.test_run.sum())
    s["human_approved_tasks"] = int(df.human.sum())
    s["reopened"] = int(df.reopened.sum())
    s["project_in_scope_non_noise"] = live.groupby(live.project.fillna("(none)")).size().sort_values(ascending=False).to_dict()
    s["git_repos_scanned"] = len(repos_scanned)
    gc = pd.DataFrame(commits)
    s["tagged_commits"] = len(gc)
    s["tagged_commits_by_repo"] = gc.groupby("repo").size().sort_values(ascending=False).to_dict() if len(gc) else {}
    # transcripts of ticket-linked runs
    if len(tr_map):
        m = tr_map
        s["ticket_transcripts"] = dict(files=len(m), on_disk=int(m.on_disk.sum()), in_archive=int(m.in_archive.sum()),
                                       missing=int((~m.on_disk & ~m.in_archive).sum()),
                                       repo_slug_top=m.repo_slug.fillna("(none)").value_counts().head(12).to_dict())
    (DATA / "corpus-summary.json").write_text(json.dumps(clean(s), indent=1, ensure_ascii=False), encoding="utf8")
    lines = ["# Corpus report (counts only)", ""]
    for k, v in s.items():
        lines.append(f"- **{k}**: {json.dumps(clean(v), ensure_ascii=False)}")
    (DATA / "corpus-report.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps(clean(s), indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
