#!/usr/bin/env node
/**
 * tools/precedent-spike/fetch-linear.mjs — F0 / T0.1: read-only snapshot of FOC and JOI issues.
 *
 * Writes .spike-precedent/linear.jsonl (git-ignored, one issue per line): identity, text,
 * state and timestamps, labels, parent, relations, state history and comments. Comments are
 * truncated (COMMENT_CHARS) — hand-offs are long and only their head carries the summary.
 *
 * Read-only: uses scripts/linear-client.mjs (the sanctioned client), issues queries only.
 * Usage: node tools/precedent-spike/fetch-linear.mjs [--teams FOC,JOI] [--out <path>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, graphql } from "../../scripts/linear-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const COMMENT_CHARS = 6000;
const PAGE = 20;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const teams = arg("--teams", "FOC,JOI").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const out = arg("--out", join(root, ".spike-precedent", "linear.jsonl"));

const QUERY = `query($after: String, $filter: IssueFilter, $first: Int) {
  issues(first: $first, after: $after, filter: $filter, includeArchived: true, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description priority estimate
      createdAt startedAt completedAt canceledAt archivedAt updatedAt
      state { name type }
      team { key }
      project { name }
      parent { identifier }
      labels(first: 20) { nodes { name } }
      relations(first: 25) { nodes { type relatedIssue { identifier } } }
      inverseRelations(first: 25) { nodes { type issue { identifier } } }
      comments(first: 50) { nodes { body createdAt user { name } botActor { name } } }
      history(first: 50) { nodes { createdAt fromState { name type } toState { name type } } }
    }
  }
}`;

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!/429|5\d\d|fetch failed|ECONN|ETIMEDOUT/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

function shape(n) {
  const c = (n.comments?.nodes ?? []).map((k) => ({
    at: k.createdAt,
    by: k.user?.name ?? (k.botActor?.name ? `bot:${k.botActor.name}` : null),
    body: (k.body ?? "").slice(0, COMMENT_CHARS),
    chars: (k.body ?? "").length,
  }));
  return {
    id: n.identifier,
    uuid: n.id,
    team: n.team?.key ?? null,
    title: n.title,
    description: n.description ?? "",
    state: n.state?.name ?? null,
    stateType: n.state?.type ?? null,
    project: n.project?.name ?? null,
    priority: n.priority ?? null,
    estimate: n.estimate ?? null,
    createdAt: n.createdAt,
    startedAt: n.startedAt,
    completedAt: n.completedAt,
    canceledAt: n.canceledAt,
    archivedAt: n.archivedAt,
    updatedAt: n.updatedAt,
    parent: n.parent?.identifier ?? null,
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
    relations: [
      ...(n.relations?.nodes ?? []).map((r) => ({ type: r.type, other: r.relatedIssue?.identifier ?? null, dir: "out" })),
      ...(n.inverseRelations?.nodes ?? []).map((r) => ({ type: r.type, other: r.issue?.identifier ?? null, dir: "in" })),
    ],
    history: (n.history?.nodes ?? [])
      .filter((h) => h.fromState || h.toState)
      .map((h) => ({ at: h.createdAt, from: h.fromState?.name ?? null, to: h.toState?.name ?? null, toType: h.toState?.type ?? null })),
    comments: c,
  };
}

async function main() {
  loadEnv();
  const rows = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const data = await withRetry(() =>
      graphql(QUERY, { after, first: PAGE, filter: { team: { key: { in: teams } } } }),
    );
    const conn = data.issues;
    for (const n of conn.nodes) rows.push(shape(n));
    pages++;
    process.stderr.write(`page ${pages}: ${rows.length} issues\n`);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const byTeam = {};
  for (const r of rows) byTeam[r.team] = (byTeam[r.team] ?? 0) + 1;
  process.stderr.write(`wrote ${rows.length} issues -> ${out}\n`);
  process.stdout.write(JSON.stringify({ issues: rows.length, byTeam, out }) + "\n");
}

main().catch((e) => {
  process.stderr.write(`fetch-linear failed: ${e?.message ?? e}\n`);
  process.exit(1);
});
