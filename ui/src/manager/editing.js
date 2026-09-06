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

// The unsaved-work guard is active when either writer has staged/unsaved
// work: configuration staging (working copy ≠ server state) or a prompt
// draft. beforeunload + SPA-nav interception + switch confirms all key off
// this single predicate.
export function editingGuardActive(configDirtyCount, promptDirty) {
  return (configDirtyCount > 0) === true || promptDirty === true;
}

// Decision shared by every in-screen switch that would drop an unsaved
// prompt draft (role, squad, inspector tab): ask via the given confirm
// function only when a draft exists; true means the switch is blocked.
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
