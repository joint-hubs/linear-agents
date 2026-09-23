// scripts/fixtures/egress-eval-synthetic.mjs — labelled synthetic evaluation set (FOC-450)
//
// FAKE-CONSTRUCTION BANNER — READ BEFORE EDITING
//
// Every secret-shaped string in this file is ASSEMBLED AT RUNTIME from split
// string literals (see P() below). None of them is a real credential: all are
// generated random-shape strings that decrypt to nothing, authenticate to
// nothing, and are published formats only. They exist so the egress screen's
// labelled evaluation (scripts/egress-eval.mjs) can exercise its shape
// detectors offline and so a clean clone gets the same numbers.
// NEVER paste a real secret into this file — not even "to make a test more
// realistic". Splitting literals is also load-bearing: a contiguous
// secret-shaped literal here would trip the repo-wide secretlint scan
// (security-scan.mjs) and turn it permanently red, the same reason
// security-scan.test.mjs builds its fakes at runtime.
//
// Labels are the ground truth and are INDEPENDENT of the detector: a text is
// labelled secret/clean and with its family by the CONTRACT (the five shape
// families in scripts/egress-screen.mjs), not by what scanEgress happens to
// say. family is set only on label "secret".

const P = (...parts) => parts.join("");

// Split-literal fake bodies. The names below are descriptive, not credentials.
const HEX64 = P("0123456789abcdef", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef");
const B62_32 = P("Nq7Zx4mKp2Wv9RtYb3Cc6Ld8Jf1HgS4T");
const B62_44 = P("aB3dEf7hIj9kLm2nPq5rSt8uVw1xYz4AaBbCcDdEeFf");
const B64URL_43 = P("a1B2c3D4-", "e5F6g7H8_", "i9J0k1L2-", "m3N4o5P6_");
const GH_PAT_BODY = P("A1bC2dE3fG4hI5jK6lL7mN", "_o9P0qQ1rR2sS3tT4uU5vV6wW7xX8yY9zZaAbBbCcDdEeFf0123456789");
const AWS_ID = P("AKIA", "J7XKQSYQZ4TG", "NB2A");
const AWS_SECRET = P("wJqXrXUtnFEMI", "/K7MDLbPx", "/RfiCYxXAMPLEKE");
const JWT_HDR = P("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
const JWT_PAYLOAD = P("eyJzdWIiOiIxMjM0NTY3ODkwIn0");
const JWT_SIG = P("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c");

function pemLines(begin, end, bodyLines) {
  return [
    P("-----BEGIN ", begin, "-----"),
    ...bodyLines,
    P("-----END ", end, "-----"),
  ].join("\n");
}

export const SYNTHETIC_SET = [
  // ── key-prefix (10) ─────────────────────────────────────────────────────
  { id: "syn-001", label: "secret", family: "key-prefix", text: P("openrouter key: sk-or-", "v1-", HEX64) },
  { id: "syn-002", label: "secret", family: "key-prefix", text: P("the key is sk-", B62_44) },
  { id: "syn-003", label: "secret", family: "key-prefix", text: P("PAT: ghp_", "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX") },
  { id: "syn-004", label: "secret", family: "key-prefix", text: P("fine-grained: github_pat_", GH_PAT_BODY) },
  { id: "syn-005", label: "secret", family: "key-prefix", text: P("slack bot token xoxb-", "123456789-abcdefghij-klmnopqrst") },
  { id: "syn-006", label: "secret", family: "key-prefix", text: P("access key id ", AWS_ID, " needs its secret") },
  { id: "syn-007", label: "secret", family: "key-prefix", text: P("npm publish token npm_", "A1bC2dE3fG4hI5jK6lL7mN8oP9qR0sS1tT2") },
  { id: "syn-008", label: "secret", family: "key-prefix", text: P("maps key AIza", "SyC1234567890abcdefghijklmnopqrstuv") },
  { id: "syn-009", label: "secret", family: "key-prefix", text: P("gitlab PAT glpat-", "a1B2c3D4e5F6g7H8i9J0") },
  { id: "syn-010", label: "secret", family: "key-prefix", text: P("stripe: sk_live_", "a1B2c3D4e5F6g7H8i9J0k1L2") },

  // ── pem (5) ─────────────────────────────────────────────────────────────
  { id: "syn-011", label: "secret", family: "pem", text: pemLines("RSA PRIVATE KEY", "RSA PRIVATE KEY", [
    "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/yGwfMRvHwF4XKrJ7tLnRi1GaaQhhh",
    "dQ0Z1vNxO8z2lKUm7SjpU9wYbHCsQfTmAoEeJkXcPvN3gRdLI6Bu==",
  ]) },
  { id: "syn-012", label: "secret", family: "pem", text: pemLines("OPENSSH PRIVATE KEY", "OPENSSH PRIVATE KEY", [
    "b3BlbnNzaC1rZXktdjEAAAAABG9vaXAAAAAAAGQAAAAMY3NocC1lZDI1NTE5",
    "AAAAIL4zVvqzTfbGTGn0gCpBmHnQLmHEtYJAUDhrpNsGWTTg",
  ]) },
  { id: "syn-013", label: "secret", family: "pem", text: pemLines("EC PRIVATE KEY", "EC PRIVATE KEY", [
    "MHQCAQEEIJAmkbHLzG0cWvV0Z9FqXk7bCc1DsJwTtO0mRa3MVo",
  ]) },
  { id: "syn-014", label: "secret", family: "pem", text: P("paste: -----BEGIN ", "PRIVATE KEY", "-----\nMIIconfig0123abc456def\n(no END line — truncated paste)") },
  { id: "syn-015", label: "secret", family: "pem", text: "```bash\ncat server.pem\n" + pemLines("PRIVATE KEY", "PRIVATE KEY", [
    "MIIG5wIBAAKCAYEwqFh0ZvK9pLxQ2mJn7RcT8dWsYuEeNbAgVHkLmPqS",
  ]) + "\n```" },

  // ── env-assignment (9) ──────────────────────────────────────────────────
  { id: "syn-016", label: "secret", family: "env-assignment", text: P("OPENROUTER", "_API_KEY", "=", "Zx9qWm3NbR7Kc2Vf8LhT5sDgYpUu4wAa") },
  { id: "syn-017", label: "secret", family: "env-assignment", text: P("export GITHUB", "_TOKEN", "=ghp_", "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX") },
  { id: "syn-018", label: "secret", family: "env-assignment", text: P("DB", "_PASSWORD", ': "hunter2-not-a-real-password"') },
  { id: "syn-019", label: "secret", family: "env-assignment", text: P("AWS", "_SECRET", "_ACCESS", "_KEY", " = ", AWS_SECRET) },
  { id: "syn-020", label: "secret", family: "env-assignment", text: P("LINEAR", "_API", "_KEY", "_PISI", "=0000-ffff-pisi-pisi") },
  { id: "syn-021", label: "secret", family: "env-assignment", text: P("api", "_key", ": 71bB9cCd0eEf1fGg2hHh3iIi4jJj5kKk") },
  { id: "syn-022", label: "secret", family: "env-assignment", text: P("APP_ENV=prod\nS3_BUCKET=app-assets\nS3", "_SECRET", "_KEY", "=qW3eR5tYu7iO9p") },
  { id: "syn-023", label: "secret", family: "env-assignment", text: P("set MY", "_TOKEN", "=abc123def456 and restart the service") },
  { id: "syn-024", label: "secret", family: "env-assignment", text: P("- COOKIE", "_SECRET", ' = "vN8pQ2rS4tU6vW8x"') },

  // ── jwt (5) ─────────────────────────────────────────────────────────────
  { id: "syn-025", label: "secret", family: "jwt", text: P("session token: ", JWT_HDR, ".", JWT_PAYLOAD, ".", JWT_SIG) },
  { id: "syn-026", label: "secret", family: "jwt", text: P("Authorization: Bearer ", JWT_HDR, ".", JWT_PAYLOAD, ".", JWT_SIG) },
  { id: "syn-027", label: "secret", family: "jwt", text: P("curl -H \"X-Auth: ", JWT_HDR, ".", JWT_PAYLOAD, ".", "c2lnbmF0dXJlLXdpdGgtLWFuZF9kYXNoZXM", "\"") },
  { id: "syn-028", label: "secret", family: "jwt", text: P(JWT_HDR, ".", P("eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ"), ".", P("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c", "AAaaBBccDDeeFFgg", "HHiiJJkkLLmmNNoo")) },
  { id: "syn-029", label: "secret", family: "jwt", text: P(JWT_HDR, ".", JWT_PAYLOAD, ".", "c2lnbmF0dXJlMQ", ".", "c2VnbWVudDJuZQ", ".", "c2VnbWVudDNuZQ") },

  // ── high-entropy (8) ────────────────────────────────────────────────────
  { id: "syn-030", label: "secret", family: "high-entropy", text: P("token without prefix: ", B62_32) },
  { id: "syn-031", label: "secret", family: "high-entropy", text: P("bearer ", B62_32, B62_32.slice(0, 24)) },
  { id: "syn-032", label: "secret", family: "high-entropy", text: P("webhook secret ", B64URL_43) },
  { id: "syn-033", label: "secret", family: "high-entropy", text: P("Authorization: Bearer ", "Xy7Zw3Qv9Rm5Kc1Ld4Jf8Hg2Np6Ts0Bq") },
  { id: "syn-034", label: "secret", family: "high-entropy", text: P("shared secret ", "Xy7Zw3Qv", "9Rm5Kc1Ld", "4Jf8Hg2") },
  { id: "syn-035", label: "secret", family: "high-entropy", text: P("key blob ", B62_44, B62_44.replace("aB3", "wX9"), B62_44.slice(0, 20)) },
  { id: "syn-036", label: "secret", family: "env-assignment", text: P("secret: 9f8Xz2Kv", "_7Qm4Ld1", "pR6Yt3Wn", "8Jc5Hb0") },
  { id: "syn-037", label: "secret", family: "high-entropy", text: P("short token ", "aB3dEf7hIj9", "kLm2nPq5rSt") },

  // ── clean (29) ──────────────────────────────────────────────────────────
  { id: "syn-038", label: "clean", text: "The API token rotation job runs nightly; see the runbook for the key rotation policy." },
  { id: "syn-039", label: "clean", text: "commit c41d0dcf1e2d3c4b5a6978877665544333221100 fixed the leak." },
  { id: "syn-040", label: "clean", text: "hotfix ab12cd3 deployed; monitoring for an hour." },
  { id: "syn-041", label: "clean", text: "run_id 550e8400-e29b-41d4-a716-446655440000 recorded in the manifest." },
  { id: "syn-042", label: "clean", text: "preview: data:image/png;base64," + P("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf", "FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ") },
  { id: "syn-043", label: "clean", text: P("-----BEGIN ", "CERTIFICATE", "-----\nMIIDdzCCAl+gAwIBAgIEAgIAuTANBgkqhkiG9w0BAQsFADBgMQswCQYD\nVQQGEwJVUzELMAkGA1UECAwCQ0Ex\n") + P("-----END ", "CERTIFICATE", "-----") },
  { id: "syn-044", label: "clean", text: P("-----BEGIN ", "PUBLIC KEY", "-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU0Lfxbx7J\n") + P("-----END ", "PUBLIC KEY", "-----") },
  { id: "syn-045", label: "clean", text: "LINEAR_WORKSPACE=jointhubs (env default; pisi uses LINEAR_WORKSPACE=pisi)" },
  { id: "syn-046", label: "clean", text: "API_ENDPOINT=https://api.linear.app/graphql (POST only)" },
  { id: "syn-047", label: "clean", text: "LOG_LEVEL=debug, LOG_FORMAT=json, LOG_COLOR=0" },
  { id: "syn-048", label: "clean", text: "DATABASE_URL=postgres://localhost:5432/app_dev (no credentials in the dev URL)" },
  { id: "syn-049", label: "clean", text: "DRY_RUN=true, STRICT=false, RETRIES=3" },
  { id: "syn-050", label: "clean", text: P("OPENROUTER", "_API_KEY", "=") },
  { id: "syn-051", label: "clean", text: P("GITHUB", "_TOKEN", "=${GH", "TOKEN} (indirection — resolved by the shell, not a literal)") },
  { id: "syn-052", label: "clean", text: "assertEgressCleanOutboundText handles multi-line blocks before posting." },
  { id: "syn-053", label: "clean", text: "release v1.2.3-beta.1 build 2026.09.23 tagged from main." },
  { id: "syn-054", label: "clean", text: "see egress-eval-synthetic-2026-09-23T10-19-26.json for the run details" },
  { id: "syn-055", label: "clean", text: "| Field | Value |\n|---|---|\n| **Issue** | FOC-450 |\n| **Squad** | dev |" },
  { id: "syn-056", label: "clean", text: "environment:\n  NODE_ENV: production\n  PORT: 3000" },
  { id: "syn-057", label: "clean", text: "AWS access key ids start with AKIA and are 20 chars total; Slack bot tokens start with xoxb-." },
  { id: "syn-058", label: "clean", text: "A GitHub PAT looks like ghp_ followed by 36 alphanumeric characters." },
  { id: "syn-059", label: "clean", text: "the decoded parts are a1B2c3D4.e5F6g7H8.i9J0k1L2 (three short segments, no eyJ header)" },
  { id: "syn-060", label: "clean", text: "payload aGVsbG8gd29ybGQ= decodes to a greeting" },
  { id: "syn-061", label: "clean", text: "- KEY=\n- LABEL=egress\n- DRY_RUN=1" },
  { id: "syn-062", label: "clean", text: "Rotate the secret quarterly. The password policy requires 16 chars minimum." },
  { id: "syn-063", label: "clean", text: "https://github.com/mateu/linear-agents/pull/12 is the tracking PR." },
  { id: "syn-064", label: "clean", text: "## handoff\n- committed the screen module and tests\n- suite 85/85 files\n- next: review round" },
  { id: "syn-065", label: "clean", text: "keys look like sk-… (redacted) in the logs — ignore those" },
  { id: "syn-066", label: "clean", text: "docker compose up -d postgres redis; POSTGRES_PORT=5432 on the host" },
];
