import type { GitState } from "../schema/context.js";
/**
 * Best-effort snapshot of a directory's git state. Returns null when `cwd`
 * isn't a git work tree or git is unavailable — callers must treat git state
 * as optional. Each call is bounded by a short timeout and never throws.
 *
 * Hardening: callers must only pass a TRUSTED `cwd` (we use `process.cwd()`,
 * never a transcript-provided path). As defence in depth we still neutralise
 * the one config-triggered code path — `core.fsmonitor` can run an arbitrary
 * program on `git status` — and disable optional lock writes.
 */
export declare function captureGitState(cwd: string): GitState | null;
/** Human-readable one-line description, e.g. `main @ a1b2c3d (dirty)`. */
export declare function formatGitState(g: GitState): string;
/**
 * Compare a captured source snapshot against the target's current git state.
 * Returns a short warning when they meaningfully differ, else null.
 *
 * - Commit is the primary signal (a branch-only difference at the same commit
 *   means the tree is identical, so it does not warn — this also avoids false
 *   positives from a detached-HEAD capture resumed on a named branch).
 * - A changed dirty flag warns too: uncommitted work present on one side but
 *   not the other means disk no longer matches the transcript's assumptions.
 * - If we had a source snapshot but cannot read the target's state at all,
 *   that is reported as "could not verify" rather than silently treated as a
 *   safe match.
 */
export declare function gitMismatchWarning(source: GitState | undefined, current: GitState | null): string | null;
