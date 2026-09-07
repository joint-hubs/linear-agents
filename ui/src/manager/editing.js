// Manager-side pure helpers for the editing increment (FOC-225 slice 1
// part 2). The staging/preview/apply mechanics live in the shared
// squadConfig/workingCopy module — this file only holds manager-specific
// derivations so the plain-Node suite can pin them.

import { COORDINATOR_KEY } from './identity.js';

// Repository path of the prompt document behind an inspector Instructions
// tab. The coordinator's instruction is the squad CLAUDE.md; a specialist
// role's instruction is its agent file. MarkdownEditor fetches and saves the
// RAW file (frontmatter survives) — never feed it getPromptRole() output.
export function promptPathFor(squadKey, roleKey) {
  if (!squadKey || !roleKey) return null;
  return roleKey === COORDINATOR_KEY
    ? `agents/${squadKey}/CLAUDE.md`
    : `agents/${squadKey}/agents/${roleKey}.md`;
}

// Configured vs staged model for one position. Both normalized to '' so a
// null configured model and an emptied input compare equal.
export function stagedModelSummary(configuredModel, stagedModel) {
  const from = configuredModel || '';
  const to = stagedModel || '';
  return { changed: from !== to, from, to };
}

// The unsaved-work guard is active when any writer has staged/unsaved work:
// configuration staging (working copy ≠ server state), a prompt draft, or a
// staged manager rating (slice 3, additive third parameter). beforeunload +
// SPA-nav interception + switch confirms all key off this single predicate.
export function editingGuardActive(configDirtyCount, promptDirty, ratingDirty = false) {
  return (configDirtyCount > 0) === true || promptDirty === true || ratingDirty === true;
}

// Combined "is anything staged?" input for the switch guards: a prompt draft
// or a staged manager rating both mean a confirm before losing work.
export function anyUnsaved(promptDirty, ratingDirty) {
  return promptDirty === true || ratingDirty === true;
}

// Decision shared by every in-screen switch that would drop unsaved staged
// work (role, squad, inspector tab): ask via the given confirm function only
// when something is staged; true means the switch is blocked.
export function switchBlocked(promptDirty, confirmFn) {
  if (promptDirty !== true) return false;
  return confirmFn() !== true;
}

// Stable fingerprint of a working-copy snapshot with canonical key order —
// two structurally equal snapshots must compare equal regardless of key
// order. The preview gate compares the fingerprint captured when the dry run
// was requested against the current one, so a preview that no longer
// describes the staged state can neither render an Apply button nor resolve
// into one.
export function workingFingerprint(value) {
  return JSON.stringify(sortKeys(value ?? null));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

// Header connectivity state (fenix-manager.md §3.4): a failed config read
// must show the header "offline" — dot + text, never color alone — and a
// successful read restores the normal state. 'connecting' covers the first
// load and in-flight retries: claiming "online" before any read succeeded
// would be a lie.
export function connectivityState({ loading, readAt, error }) {
  if (error) return 'offline';
  if (loading || !readAt) return 'connecting';
  return 'online';
}

// Inspector tab bar, arrow-key navigation target (APG tabs pattern over the
// existing roving tabindex): Left/Right step, Home/End jump, no wrap-around.
// Returns -1 when the key is not a navigation key or the index is out of
// range — the caller then leaves focus where it is.
export function nextTabIndex(key, index, count) {
  if (count <= 0 || !Number.isInteger(index) || index < 0 || index >= count) return -1;
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, index + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
