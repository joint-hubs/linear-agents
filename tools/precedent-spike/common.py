"""Shared paths and helpers for the precedent-index F0 spike (read-only, offline).

Data lives in `.spike-precedent/` (git-ignored by the repo's `.spike-*/` rule). Nothing here writes
to telemetry, Linear or any repo. Telemetry numbers come from the analysis project's parquet cache
(canonical views, built by `fenix.data`); set FENIX_ANALYSIS_DIR to relocate it.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / ".spike-precedent"
DATA.mkdir(exist_ok=True)
GITHUB_ROOT = Path(os.environ.get("GITHUB_ROOT", str(REPO.parent)))
STATE = REPO / ".state"
ANALYSIS = Path(os.environ.get("FENIX_ANALYSIS_DIR", r"C:\Users\mateu\Desktop\experiments\telemetry analysis"))

TICKET_RE = re.compile(r"^(FOC|JOI)-\d+$")
TICKET_IN_TEXT = re.compile(r"\b(FOC|JOI)-(\d+)\b", re.IGNORECASE)
SCOPE_TEAMS = ("FOC", "JOI")
# Automated intake alerts ("[ThoughtMap] Entity activity spike: ..."), not engineering problems.
NOISE_PROJECTS = {"ThoughtMap Intake"}
NOISE_TITLE = re.compile(r"^\s*\[ThoughtMap\]", re.IGNORECASE)

# Scope policy (D5 + R33). Default is narrower than "every FOC/JOI ticket" in the privacy-preserving
# direction; each rule is reported in the corpus summary and can be overridden here.
#  * personal-life projects are excluded: their transcripts sit under `Second Brain\Personal Finances`;
#  * the chain layer (transcripts) is limited to runs whose cwd is an allowlisted repo or one of its
#    `la-wt-*` worktrees, minus a path denylist (personal finance, tax, compensation, hobby projects).
EXCLUDE_PROJECTS = {"PERSONAL", "personal"}
ALLOW_REPOS = ("linear-agents", "joint-flows", "office", "post-fraud-model", "post-fraud-alert-model", "Fraud-Prediction",
               "jointhubs-dashboard", "landing", "sce", "jointhubs-os", "wskm-skrypty-energetyka")
DENY_SLUG = re.compile(r"Second-Brain|Personal-Finances|IP-BOX|equity-split|moto-computer|trading-assist|stocks-ui|"
                       r"hr-comp|hr_ai|finance-tracker|revenue-agent", re.IGNORECASE)


def slug_allowed(slug: str | None) -> bool:
    """Transcript directory slug (e.g. `Documents-GitHub-la-wt-joint-flows-foc-199-dev`) -> chain layer allowed?"""
    if not slug or DENY_SLUG.search(slug):
        return False
    return any(re.search(rf"(^|-)({re.escape(r)})(-|$)", slug, re.IGNORECASE) for r in ALLOW_REPOS)


def use_analysis_package():
    """Make `fenix.*` (the analysis project's package) importable."""
    p = str(ANALYSIS)
    if p not in sys.path:
        sys.path.insert(0, p)


def read_jsonl(path: Path) -> list[dict]:
    with open(path, encoding="utf8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def write_jsonl(path: Path, rows) -> int:
    n = 0
    with open(path, "w", encoding="utf8", newline="\n") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
            n += 1
    return n


def utf8_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
