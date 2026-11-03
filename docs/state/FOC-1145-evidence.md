Task: FOC-1145-evidence
Session: -
Run: -
Branch: foc-1145-dev-e629a097bc34
PR: #191
Status: done

--- RED run (extended guard vs stale checklist, node scripts/docs-count-guard.test.mjs) ---
guard_exit=1
  DRIFT: docs line 22 says 177 test files but found 215 test files
  DRIFT: docs line 22 says 177 test files but found 215 test files
  
  Fix: update docs/supervisor-e2e-checklist.md to say 215 files (199 parallel + 16 serial per scripts/test-lanes.json)
--- GREEN run (after docs fix, node scripts/docs-count-guard.test.mjs) ---
guard_exit=0
  OK: docs counts match 215 test files (199 parallel + 16 serial per scripts/test-lanes.json)
--- measured counts ---
  test-lanes.json: 199 parallel + 16 serial = 215 lane entries
  actual scripts/*.test.mjs (filter: *.test.mjs, not starting _): 215
  sources agree: 215
## 2026-11-02 09:07 — closed: merged in #191

