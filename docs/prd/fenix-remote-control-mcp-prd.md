# PRD — Fenix MCP: external writes (FOC-943) and remote control from the Grok app

Status: **accepted** by Mateusz 2026-10-20 (all §9 defaults). Linear: epic FOC-957; A = FOC-943, B = FOC-958, C = FOC-959, D = FOC-960, E = FOC-961.
Order agreed 2026-10-20: finish 1.0 (FOC-789 → FOC-790) → this PRD's phases A–B → C–E (Grok).

## 1. Problem / goal

1. **Unattended Supervisor writes are nondeterministic** (FOC-943): Linear/GitHub writes are shell commands
   (`linear-ops.mjs`, `gh-screened.mjs`); a pipe or `&&` makes the allow rule miss and the auto-mode classifier
   prompts a pane nobody watches. The permission mode itself is inherited from a persisted dialog answer.
2. **Fenix can only be steered from the dashboard** on `127.0.0.1:4600` (SSH tunnel to the VM). Mateusz wants to
   steer the Supervisor from the **Grok app** — on the PC and on the phone — against **fenix-vm**, without paying
   for a VM that runs 24/7.

Goal: one Fenix MCP surface. Locally (stdio) it is the Supervisor's deterministic write channel; remotely
(HTTPS, token) it is the control channel the Grok app talks to. The VM runs **on demand with autostop**.

## 2. User journey (Mateusz, phone)

1. Opens Grok → "co robi Fenix?" → Grok calls `fenix_status` → "Fenix śpi (VM zatrzymana)". 
2. "obudź Fenixa" → `fenix_wake` → VM starts (~60–90 s), stack comes back by itself → Grok polls `fenix_status`.
3. "jaka kolejka?" → `fenix_queue` (work board: tickets, stage, cost). "zrób FOC-920" → `fenix_message`
   ("take FOC-920") → the Supervisor plans and starts a child.
4. Later: "czy coś czeka na mnie?" → `fenix_inbox` → a pending `plan.gate1` → Mateusz answers in Grok →
   `fenix_gate_answer`. A Supervisor question → `fenix_ask_answer`; a permission dialog → `fenix_dialog_answer`.
5. He stops talking. When the Supervisor is idle, no child is live and no remote call came for N minutes,
   the VM stops itself. Next "co robi Fenix?" → "śpi".

## 3. Scope

**In**
- A. FOC-943 as written: `fenix-linear` / `fenix-github` stdio MCP for Supervisor writes, exact-name allow rules,
  declared permission mode, interim bare-command prompt rule.
- B. `fenix-control` tools over the existing API routes (no new business logic): status, sessions, conversation
  read, inbox, queue, costs summary, message, wake (session), ask/dialog/gate answers.
- C. Remote transport: MCP Streamable HTTP endpoint with a bearer token, scopes, audit log, output redaction.
- D. On-demand VM: an always-on scale-to-zero **gateway** (stable HTTPS URL, auth, wake) + autostop on the VM.
- E. Grok app connected to the gateway; a QUICKSTART section "Steer Fenix from Grok".

**Out (v1)**
- Push notifications from Fenix to the phone (Grok answers when asked) — candidate for v2.
- Push / merge / delete-branch / secrets / key rotation through the remote channel (`neverCovers` stays: push,
  force, discard, delete-branch, secrets). Human push stays in the dashboard with its confirm (FOC-788).
- Raw terminal / slash commands remotely (same refusal as the dashboard chat).
- Multi-user access; the gateway serves one owner.

## 4. UX (persona: Mateusz on the phone, short Polish voice commands)

- Tool names and descriptions are written so Grok picks them from a plain sentence ("co czeka na mnie" → inbox).
- Every answer is short and decision-ready: state, what waits, one next step. Long transcripts are summarised by
  the tool (last N turns), never dumped.
- Every write tool echoes what it did ("wysłane do Supervisora: …", "bramka plan.gate1 FOC-920: zapisana").
- A sleeping Fenix is a normal state, not an error: `fenix_status` says so and offers `fenix_wake`.

## 5. Architecture

```
Grok app (PC / phone)
   │ HTTPS + Bearer (remote-control token)
   ▼
fenix-gateway  (Cloud Run, scale-to-zero, europe-central2)      ← always reachable, ~$0
   │  /mcp: auth, scope check, audit, rate limit
   │  VM stopped → status/wake answered here (Compute API start)
   │  VM running → proxy over Direct VPC egress to the VM's internal IP
   ▼
fenix-vm  (e2-standard-2, on demand)  — fenix-api :4600 /mcp  (Streamable HTTP, same tool handlers)
   │  tools call the existing /api/supervisor/*, /api/gates/answer, /api/work/*, /api/cockpit routes
   ▼  autostop: idle Supervisor ∧ 0 live children ∧ no remote call for N min → shutdown
supervisor container (tmux Claude Code) ── stdio MCP fenix-linear / fenix-github (phase A)
```

- **One tool module, two transports.** `scripts/mcp/fenix-control-tools.mjs` holds the tool table; stdio via the
  existing `jsonrpc.mjs` (`createMcpHandler`, `serveStdio`), HTTP via a small Streamable-HTTP adapter mounted in
  the API server. No MCP SDK dependency unless the adapter turns out non-trivial (decide in phase C).
- **Routes reused, not reimplemented.** Tools call the same routes as the dashboard, so the FOC-848 ownership
  gate, the FOC-450 egress screen, session scoping (`selection-required` 409) and gate validation apply unchanged.
  The remote caller is a new actor `remote:grok` in the audit and gate records (not `ai`, not the dashboard).
- **Auth.** A separate remote-control token (not the host token, not a provider key), stored as a Compose secret,
  rotated with `fenix keys`; three scopes: `read`, `answer` (ask/dialog/gate), `control` (message, wake session).
  Gateway and VM both verify it (the VM's `/mcp` also refuses anything not from the gateway's subnet).
- **Output redaction.** Every tool result passes `scripts/mcp/scrub.mjs` / the egress screen before it leaves —
  transcripts can contain anything.
- **Audit.** One JSONL line per remote call (time, tool, scope, args hash, result status) on the data volume;
  visible in the dashboard later.
- **Autostop.** A small loop in the API container (or a systemd timer on the VM) reads the host `/state`, the
  live-children registry and the gateway's last-call timestamp; after N idle minutes it stops the VM via the
  metadata-server identity (`compute.instances.stop` on itself). It never stops with a live child
  (memory: check live children before stopping Fenix, FOC-680 incident).
- **Wake.** `fenix_wake` on the gateway: `instances.start`, then report progress; the stack auto-starts
  (`restart: unless-stopped`, session resume FOC-776).

## 6. Tools (v1)

| Tool | Scope | Backed by |
|---|---|---|
| `fenix_status` | read | gateway: VM state; VM: `/api/cockpit` (Supervisor state, live children, needs-you count) |
| `fenix_wake` | control | gateway: Compute API start (+ `POST /api/supervisor/wake` once up) |
| `fenix_sessions` | read | `GET /api/supervisor/sessions` |
| `fenix_conversation` | read | `GET /api/supervisor/conversation?after=&limit=` (summarised, last N) |
| `fenix_inbox` | read | cockpit Needs-you items (gates, asks, dialogs, holds, problems) |
| `fenix_queue` | read | `GET /api/work/tickets` |
| `fenix_costs` | read | cost snapshot summary (today / 7 days / per ticket top 5) |
| `fenix_message` | control | `POST /api/supervisor/message` (same refusals as dashboard chat) |
| `fenix_ask_answer` | answer | `POST /api/supervisor/ask` |
| `fenix_dialog_answer` | answer | `POST /api/supervisor/dialog` |
| `fenix_gate_answer` | answer | `POST /api/gates/answer` |

Phase A tools (Supervisor-local, stdio only, never exposed remotely): `fenix-linear.transition|comment|
comment-replace|attach-link`, `fenix-github.pr-create|pr-edit|pr-comment`.

## 7. Cost

- fenix-vm e2-standard-2 always on ≈ $50–55/month; on demand at ~3 h/day ≈ $7–8/month + 50 GB pd-balanced disk
  ≈ $5/month (paid either way).
- Cloud Run gateway: scale to zero, requests far inside the free tier → ≈ $0. Direct VPC egress: no connector fee.
- No load balancer, no static IP, no tunnel service.
- Model cost unchanged (Supervisor on x-ai/grok-4.7, children per routing).

## 8. Phases and tasks

**A — FOC-943 (deterministic writes)**
- [ ] A1 interim rule in `agents/supervisor/CLAUDE.md`: allow-listed scripts run bare (no pipes / chains)
- [ ] A2 `scripts/mcp/server-fenix-linear.mjs` over `linear-ops.mjs` (transition, comment, comment-replace, attach-link)
- [ ] A3 `scripts/mcp/server-fenix-github.mjs` over `gh-screened.mjs` (pr-create, pr-edit, pr-comment)
- [ ] A4 `.mcp.json` entries + `mcp-enable.mjs` approval for squad config dirs; exact-name allow rules; config-drift pins
- [ ] A5 declared permission mode in the container launch; `fenix doctor` prints it; QUICKSTART "When nobody is attached"
- [ ] A6 tests: canary in a comment body blocked through the MCP tool; ownership-foreign refused; drift green

**B — `fenix-control` tool table (stdio first)**
- [ ] B1 `scripts/mcp/fenix-control-tools.mjs`: the 10 VM-side tools over the existing routes, scrubbed output
- [ ] B2 actor `remote:<client>` threaded into gate/ask/dialog audit records
- [ ] B3 stdio server for local use (also lets Claude Code / Codex steer Fenix today)
- [ ] B4 tests per tool against the route fixtures (cockpit-routes / work-routes test seams)

**C — remote transport on the VM**
- [ ] C1 Streamable HTTP `/mcp` on fenix-api; bearer token as Compose secret; scopes; rate limit
- [ ] C2 audit JSONL on the data volume; `fenix keys remote-token` (create / rotate / show fingerprint)
- [ ] C3 source restriction (gateway subnet only) when `FENIX_REMOTE=gateway`

**D — gateway + on-demand VM**
- [ ] D1 `gateway/` Cloud Run service: auth, `fenix_status` / `fenix_wake` when the VM is down, proxy when up
- [ ] D2 Direct VPC egress + firewall rule (gateway → VM :4600 only); service account with start/get on fenix-vm only
- [ ] D3 autostop loop on the VM (idle ∧ 0 live children ∧ no remote call for N min), self-stop identity
- [ ] D4 deploy script + ACCESS.md (URL, where the token lives, how to rotate)

**E — Grok**
- [ ] E1 verify how the Grok app attaches a remote MCP server (connector UI / URL + header); record in docs
- [ ] E2 connect from the PC, then the phone; run the §2 journey end to end; record times and every snag
- [ ] E3 QUICKSTART "Steer Fenix from Grok"

## 9. Decisions to confirm (defaults proposed)

1. **Gateway on Cloud Run with Direct VPC egress** (vs Cloudflare/Tailscale tunnel on the VM) — default **Cloud
   Run**: the only design where "wake" works while the VM is off, no third-party account.
2. **Autostop after N = 30 min** idle (idle Supervisor, 0 live children, no remote call). Default **30**.
3. **Scopes for the Grok token in v1:** `read` + `answer` + `control` (all three). Default **all three**; push /
   merge stay out regardless.
4. **No push notifications in v1** — Grok answers when asked. Default **out**, v2 candidate.
5. **Phase A first**, B/C/D/E after FOC-789/790 — as agreed. Phase A may land before the 1.0 tag only if it is
   needed to make the FOC-789 run prompt-free (it likely is: the run is unattended between steps).
6. **Linear:** FOC-943 keeps phase A; new tickets for B, C, D, E under a new epic "Fenix remote control"
   (or under M8 follow-ups). Default **new epic**.

## 10. Acceptance

- Phase A: FOC-943's four acceptance bullets.
- Phase E: from the phone, with fenix-vm stopped: status → wake → queue → message → a gate answered → the VM stops
  by itself ≤ N + 5 min after the last call with no child live; every call in the audit log; a canary planted
  in the transcript never appears in a tool result; a wrong/absent token gets 401 at the gateway and never
  reaches the VM.
- Monthly cost at Mateusz's usage ≤ $15 for VM + gateway (measured over the first two weeks).
