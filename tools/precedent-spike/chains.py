#!/usr/bin/env python
"""F0 / T0.7 - reasoning as chains: deterministic segmentation of agent transcripts into
step (thought -> action -> observation) > episode > chain, plus error-signature recurrence.

Local and read-only. Only counts, kinds and NORMALISED error signatures are written to
.spike-precedent/chains/ (git-ignored); no thought text is stored. Use `--sample N` for a quick run.

Segmentation rules (from the brainstorm, section 11)
  step      one assistant message (its thinking / text / tool_use blocks) + the tool results that answer it
  family    explore | edit | test | mutate | run | delegate | plan | talk (no tool) | other
  episode   a run of steps with one dominant family (hysteresis: a new family must persist >= 2 steps); hard
            boundaries at a human message, an idle gap > 10 min
  kind      orient (explore before the first edit) | investigate (explore later) | implement (edit) |
            reproduce (test/run before the first edit) | verify (test/run after an edit) | recover (starts right after
            an error) | coordinate (mutate/delegate/plan) | reason (no tool calls) | other
  outcome   resolved (recover episode followed by a clean test/run within 8 steps) | stuck (same error signature
            >= 3 times) | open
Usage: python chains.py [--sample 50] [--max-mb 40]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

from common import DATA, read_jsonl, utf8_stdout

OUT = DATA / "chains"
OUT.mkdir(exist_ok=True)
GAP_S = 600
SEARCH_TOOLS = {"grep", "glob", "read_file", "code_intel", "web_search", "web_fetch", "knowledge_base"}
CANON = {"Read": "read_file", "Grep": "grep", "Glob": "glob", "Bash": "bash", "Edit": "edit_file", "MultiEdit": "edit_file",
         "NotebookEdit": "edit_file", "Write": "write_file", "Task": "agent_spawn", "Agent": "agent_spawn",
         "TodoWrite": "task_management", "WebFetch": "web_fetch", "WebSearch": "web_search", "AskUserQuestion": "user_interaction",
         "ExitPlanMode": "plan", "EnterPlanMode": "plan"}
BASH_SEARCH = re.compile(r"^(?:grep|rg|find|ls|cat|head|tail|wc|tree|git\s+(?:log|show|diff|status|grep|blame|branch)|node\s+\S*(?:linear-query|code-intel|supervisor-status)|sed\s+-n|awk)\b")
BASH_TEST = re.compile(r"^(?:node\s+(?:--\S+\s+)*\S*\.test\.mjs|node\s+\S*test-all|node\s+--test|npm\s+(?:test|run\s+(?:test|lint|build))|pytest|python\S*\s+-m\s+(?:pytest|unittest)|node\s+\S*lint)")
BASH_MUTATE = re.compile(r"^(?:git\s+(?:add|commit|push|merge|checkout|reset|rebase|worktree)|rm|mv|cp|mkdir|npm\s+(?:install|ci)|node\s+\S*(?:supervisor-(?:spawn|gate|merge|cleanup|followup|verdict|triage)|linear-ops|publish-linear-comment))\b")
BASH_RUN = re.compile(r"^(?:node|python\S*|npm|npx|curl|ssh|docker|dotnet|cargo|make|bash|sh|powershell|pwsh|Rscript|pip\S*|claude|gh|pytest)")
ERR_LINE = re.compile(r"(?i)(error|exception|traceback|fatal|failed|fail\b|not ok|enoent|eacces|eperm|cannot find|not defined|no such file|command not found|permission denied|syntaxerror|typeerror|referenceerror)")
NORM = [(re.compile(r"[A-Za-z]:[\\/][^\s\"'<>|]+"), "<path>"), (re.compile(r"(?<![\w.])/[\w.\-@]+(?:/[\w.\-@]+)+"), "<path>"),
        (re.compile(r"\b[0-9a-f]{7,64}\b"), "<hex>"), (re.compile(r"\b\d+(?:\.\d+)*\b"), "<n>"),
        (re.compile(r"\"[^\"]{1,80}\"|'[^']{1,80}'"), "<str>"), (re.compile(r"\s+"), " ")]


def norm_sig(line: str) -> str:
    s = line.strip().lower()
    for rx, rep in NORM:
        s = rx.sub(rep, s)
    return s[:160]


def family(canon: str, arg: str) -> str:
    if canon in ("edit_file", "write_file"):
        return "edit"
    if canon in ("agent_spawn", "agent_control"):
        return "delegate"
    if canon in ("task_management", "issue_tracker", "user_interaction", "plan"):
        return "plan"
    if canon in SEARCH_TOOLS:
        return "explore"
    if canon == "bash":
        c = re.sub(r"^cd\s+\S+\s*&&\s*", "", arg.lstrip())
        if BASH_TEST.match(c):
            return "test"
        if BASH_MUTATE.match(c):
            return "mutate"
        if BASH_SEARCH.match(c):
            return "explore"
        if BASH_RUN.match(c):
            return "run"
    return "other"


def ts_of(rec) -> float | None:
    t = rec.get("timestamp")
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def block_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def target_of(canon: str, inp: dict) -> str:
    if not isinstance(inp, dict):
        return ""
    if canon in ("read_file", "edit_file", "write_file"):
        return str(inp.get("file_path") or inp.get("path") or "")
    if canon == "grep":
        return f"{inp.get('pattern', '')}@{inp.get('path', '')}"
    if canon == "glob":
        return str(inp.get("pattern", ""))
    if canon == "bash":
        return re.sub(r"\s+", " ", str(inp.get("command", "")))[:200]
    return str(inp.get("subagent_type") or inp.get("description") or "")[:100]


def parse(path: Path, max_bytes: int):
    """Yield steps and human boundaries in file order (non-sidechain only)."""
    steps, cur, cur_id = [], None, None
    pending = {}  # tool_use_id -> (step index, call index)
    human = []    # timestamps of human messages
    size = path.stat().st_size
    is_sub = path.name.startswith("agent-")   # subagent files mark every record as sidechain; it IS their content
    truncated = size > max_bytes
    n_read = 0
    with open(path, "rb") as fh:
        for raw in fh:
            n_read += len(raw)
            if n_read > max_bytes:
                break
            try:
                r = json.loads(raw)
            except Exception:
                continue
            if r.get("isSidechain") and not is_sub:
                continue
            typ, msg = r.get("type"), r.get("message")
            if typ == "assistant" and isinstance(msg, dict):
                mid = msg.get("id")
                if cur is None or mid != cur_id:
                    cur = dict(ts=ts_of(r), model=msg.get("model"), think_chars=0, has_think=False, text_chars=0, calls=[], results=[])
                    steps.append(cur)
                    cur_id = mid
                cur["ts_end"] = ts_of(r) or cur["ts"]
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "thinking":
                        t = b.get("thinking") or ""
                        cur["think_chars"] += len(t)
                        cur["has_think"] = cur["has_think"] or bool(t.strip())
                    elif b.get("type") == "text":
                        cur["text_chars"] += len(b.get("text") or "")
                    elif b.get("type") == "tool_use":
                        canon = CANON.get(b.get("name"), "code_intel" if str(b.get("name", "")).startswith("mcp__codegraph") else
                                          "issue_tracker" if str(b.get("name", "")).startswith("mcp__linear") else
                                          "knowledge_base" if str(b.get("name", "")).startswith("mcp__atlas") else str(b.get("name")))
                        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                        tgt = target_of(canon, inp)
                        cur["calls"].append(dict(tool=canon, target=tgt, family=family(canon, tgt if canon == "bash" else "")))
                        pending[b.get("id")] = (len(steps) - 1, len(cur["calls"]) - 1)
            elif typ == "user" and isinstance(msg, dict):
                cur, cur_id = None, None
                content = msg.get("content")
                has_result = False
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            has_result = True
                            si = pending.pop(b.get("tool_use_id"), None)
                            if si is None:
                                continue
                            text = block_text(b.get("content"))
                            is_err = bool(b.get("is_error"))
                            call = steps[si[0]]["calls"][si[1]]
                            if call["tool"] == "bash" and re.match(r"(?i)\s*exit code [1-9]", text):
                                is_err = True
                            sig = None
                            if is_err:
                                lines = [ln for ln in text.splitlines() if ln.strip()]
                                pick = next((ln for ln in lines if ERR_LINE.search(ln) and not re.match(r"(?i)exit code", ln.strip())), None)
                                sig = norm_sig(pick or (lines[1] if len(lines) > 1 else lines[0] if lines else "error"))
                            steps[si[0]]["results"].append(dict(call=si[1], err=is_err, bytes=len(text), sig=sig))
                if not has_result and not r.get("isMeta"):
                    t = block_text(content).lstrip()
                    if t and not t.startswith("<system-reminder>") and not t.startswith("<command-") and not t.startswith("Caveat:"):
                        human.append(ts_of(r))
    return steps, human, truncated


def label_steps(steps):
    for s in steps:
        fams = Counter(c["family"] for c in s["calls"] if c["family"] != "other") or Counter(c["family"] for c in s["calls"])
        s["family"] = fams.most_common(1)[0][0] if fams else "talk"
        s["err"] = any(r["err"] for r in s["results"])
        s["sigs"] = sorted({r["sig"] for r in s["results"] if r["err"] and r["sig"]})


def segment(steps, human_ts):
    """Return episodes as dicts with start/end step indices."""
    n = len(steps)
    if not n:
        return []
    fam = [s["family"] for s in steps]
    sm = []
    for i in range(n):
        window = [f for f in fam[max(0, i - 1): i + 2] if f not in ("talk", "other")]
        sm.append(Counter(window).most_common(1)[0][0] if window else fam[i])
    # hard boundaries
    hard = set()
    ht = sorted(h for h in human_ts if h)
    for i in range(1, n):
        a, b = steps[i - 1].get("ts_end") or steps[i - 1]["ts"], steps[i]["ts"]
        if a and b and b - a > GAP_S:
            hard.add(i)
        if a and b and any(a < h <= b for h in ht):
            hard.add(i)
    cuts = [0]
    cur = sm[0]
    i = 1
    while i < n:
        if i in hard:
            cuts.append(i)
            cur = sm[i]
        elif sm[i] != cur and (i + 1 >= n or sm[i + 1] == sm[i] or (i + 1) in hard):
            cuts.append(i)
            cur = sm[i]
        i += 1
    eps = []
    first_edit_seen = False
    for k, a in enumerate(cuts):
        b = cuts[k + 1] if k + 1 < len(cuts) else n
        seg = steps[a:b]
        fams = Counter(s["family"] for s in seg if s["family"] not in ("talk", "other")) or Counter(s["family"] for s in seg)
        dom = fams.most_common(1)[0][0]
        after_err = a > 0 and steps[a - 1]["err"]
        if dom == "edit":
            first_edit_seen = True
        if after_err:
            kind = "recover"
        elif dom == "explore":
            kind = "orient" if not first_edit_seen else "investigate"
        elif dom == "edit":
            kind = "implement"
        elif dom in ("test", "run"):
            kind = "verify" if first_edit_seen else "reproduce"
        elif dom in ("mutate", "delegate", "plan"):
            kind = "coordinate"
        elif dom == "talk":
            kind = "reason"
        else:
            kind = "other"
        sigs = Counter(sg for s in seg for sg in s["sigs"])
        eps.append(dict(a=a, b=b, kind=kind, dom=dom, n=b - a, errs=sum(s["err"] for s in seg), sigs=dict(sigs),
                        fam_seq="".join({"explore": "E", "edit": "X", "test": "T", "run": "R", "mutate": "M", "delegate": "D",
                                         "plan": "P", "talk": "-", "other": "o"}[s["family"]] for s in seg)[:40],
                        think=sum(s["think_chars"] for s in seg), dur=((seg[-1].get("ts_end") or seg[-1]["ts"] or 0) - (seg[0]["ts"] or 0))))
    # outcomes
    for ep in eps:
        ep["outcome"] = "open"
        if ep["sigs"] and max(ep["sigs"].values()) >= 3:
            ep["outcome"] = "stuck"
        elif ep["kind"] == "recover":
            for s in steps[ep["a"]: min(len(steps), ep["b"] + 8)]:   # the episode plus 8 steps after it
                if s["family"] in ("test", "run") and not s["err"]:
                    ep["outcome"] = "resolved"
                    break
    return eps


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--max-mb", type=float, default=40)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rows = read_jsonl(DATA / "transcripts.jsonl")
    # drop duplicate physical files (one file can be linked to several tickets)
    seen, uniq = set(), []
    for r in sorted(rows, key=lambda r: r["started_at"] or ""):
        if r["path"] in seen:
            continue
        seen.add(r["path"])
        uniq.append(r)
    if args.sample:
        rng = np.random.default_rng(args.seed)
        by = defaultdict(list)
        for r in uniq:
            by[(r["squad"], r["era"])].append(r)
        keys = sorted(by, key=str)
        pick = []
        while len(pick) < args.sample and keys:
            for k in list(keys):
                if by[k]:
                    pick.append(by[k].pop(int(rng.integers(len(by[k])))))
                else:
                    keys.remove(k)
                if len(pick) >= args.sample:
                    break
        uniq = sorted(pick, key=lambda r: r["started_at"] or "")
    print(f"transcripts to parse: {len(uniq)}", file=sys.stderr)

    t0 = time.time()
    per, all_eps, checks = [], [], Counter()
    err_by_file = []
    for k, r in enumerate(uniq):
        try:
            steps, human, trunc = parse(Path(r["path"]), int(args.max_mb * 1e6))
        except Exception as e:
            checks["parse_error"] += 1
            continue
        if not steps:
            checks["no_steps"] += 1
            continue
        label_steps(steps)
        eps = segment(steps, human)
        for ep in eps:
            if ep["n"] <= 0:
                checks["empty_episode"] += 1
            if ep["dur"] < 0:
                checks["negative_duration"] += 1
        # ordering sanity: episodes tile the steps exactly
        if sum(ep["n"] for ep in eps) != len(steps):
            checks["tiling_mismatch"] += 1
        # resolves pattern: error -> edit -> clean test/run of the same command
        resolves = 0
        for i, s in enumerate(steps):
            if s["err"] and s["family"] in ("test", "run"):
                cmd = next((c["target"] for c in s["calls"] if c["family"] in ("test", "run")), None)
                edited = False
                for t in steps[i + 1: i + 13]:
                    edited = edited or t["family"] == "edit"
                    if edited and t["family"] in ("test", "run") and not t["err"] and any(c["target"] == cmd for c in t["calls"]):
                        resolves += 1
                        break
        # loop collapse: identical consecutive calls
        calls = [(c["tool"], c["target"]) for s in steps for c in s["calls"]]
        repeats = sum(1 for a, b in zip(calls, calls[1:]) if a == b)
        per.append(dict(path=r["path"], sub=Path(r["path"]).name.startswith("agent-"), task=r["task_id"], squad=r["squad"], era=r["era"], started=r["started_at"], steps=len(steps),
                        think_steps=sum(s["has_think"] for s in steps), call_steps=sum(bool(s["calls"]) for s in steps),
                        err_steps=sum(s["err"] for s in steps), episodes=len(eps), human=len(human), resolves=resolves,
                        repeats=repeats, calls=len(calls), truncated=trunc, models=sorted({s["model"] for s in steps if s["model"]})))
        for ep in eps:
            all_eps.append(dict(task=r["task_id"], squad=r["squad"], file=k, **{x: ep[x] for x in ("kind", "dom", "n", "errs", "outcome", "fam_seq", "think", "dur")},
                                sigs=list(ep["sigs"])))
        for s in steps:
            for sg in s["sigs"]:
                err_by_file.append((k, r["started_at"], sg, s["family"]))
        if (k + 1) % 100 == 0:
            print(f"  {k + 1}/{len(uniq)} ({time.time() - t0:.0f}s)", file=sys.stderr)

    # ---------------- summary
    summ = dict(files=len(per), seconds=round(time.time() - t0), checks=dict(checks))
    summ["steps"] = int(sum(p["steps"] for p in per))
    summ["steps_with_thinking_share"] = float(sum(p["think_steps"] for p in per) / max(summ["steps"], 1))
    summ["steps_with_calls_share"] = float(sum(p["call_steps"] for p in per) / max(summ["steps"], 1))
    summ["steps_with_error_share"] = float(sum(p["err_steps"] for p in per) / max(summ["steps"], 1))
    summ["episodes"] = len(all_eps)
    summ["steps_per_file_median"] = float(statistics.median(p["steps"] for p in per))
    summ["episodes_per_file_median"] = float(statistics.median(p["episodes"] for p in per))
    summ["steps_per_episode_median"] = float(statistics.median(e["n"] for e in all_eps))
    summ["episode_kinds"] = dict(Counter(e["kind"] for e in all_eps))
    rec = [e for e in all_eps if e["kind"] == "recover"]
    summ["recover_episodes"] = len(rec)
    summ["recover_outcomes"] = dict(Counter(e["outcome"] for e in rec))
    summ["all_outcomes"] = dict(Counter(e["outcome"] for e in all_eps))
    summ["resolves_patterns"] = int(sum(p["resolves"] for p in per))
    summ["repeat_call_share"] = float(sum(p["repeats"] for p in per) / max(sum(p["calls"] for p in per), 1))
    summ["by_squad"] = {sq: dict(files=sum(1 for p in per if p["squad"] == sq), steps=sum(p["steps"] for p in per if p["squad"] == sq),
                                 think_share=float(sum(p["think_steps"] for p in per if p["squad"] == sq) / max(sum(p["steps"] for p in per if p["squad"] == sq), 1)))
                        for sq in sorted({p["squad"] for p in per if p["squad"]})}

    # error-signature recurrence across files (files are in start-time order)
    occ = defaultdict(list)  # sig -> list of file index
    for k, _, sg, fam_ in err_by_file:
        occ[sg].append(k)
    files_with_sig = {sg: sorted(set(v)) for sg, v in occ.items()}
    n_files = len(per)
    generic = {sg for sg, v in files_with_sig.items() if len(v) > 0.05 * n_files}
    total_err_events = recur = recur_specific = 0
    seen_first = {}
    resolved_earlier = defaultdict(bool)
    for e in all_eps:  # mark signatures that had a resolved recover episode in some file
        if e["kind"] == "recover" and e["outcome"] == "resolved":
            for sg in e["sigs"]:
                resolved_earlier[(sg, e["file"])] = True
    actionable = 0
    for sg, ks in files_with_sig.items():
        first = ks[0]
        for kk in ks[1:]:
            total_err_events += 1
            recur += 1
            if sg not in generic:
                recur_specific += 1
                if any(resolved_earlier.get((sg, f)) for f in ks if f < kk):
                    actionable += 1
        total_err_events += 1  # the first occurrence
    summ["error_signatures"] = dict(distinct=len(files_with_sig), generic_over_5pct_of_files=len(generic),
                                    file_level_occurrences=int(sum(len(v) for v in files_with_sig.values())),
                                    recurring_later_occurrences=recur, recurring_specific=recur_specific,
                                    later_specific_with_earlier_resolved_episode=actionable,
                                    recurrence_share=float(recur / max(sum(len(v) for v in files_with_sig.values()), 1)),
                                    actionable_share_of_specific=float(actionable / max(recur_specific, 1)))
    top = Counter({sg: len(v) for sg, v in files_with_sig.items()}).most_common(12)
    summ["top_error_signatures_by_files"] = [(sg[:100], n) for sg, n in top]

    (OUT / "summary.json").write_text(json.dumps(summ, indent=1, default=str), encoding="utf8")
    (OUT / "files.jsonl").write_text("\n".join(json.dumps(p, default=str) for p in per) + "\n", encoding="utf8")
    (OUT / "episodes.jsonl").write_text("\n".join(json.dumps(e, default=str) for e in all_eps) + "\n", encoding="utf8")
    print(json.dumps(summ, indent=1, default=str))


if __name__ == "__main__":
    main()
