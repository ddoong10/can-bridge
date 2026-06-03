import { execFileSync } from "node:child_process";
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
export function captureGitState(cwd) {
    const git = (args) => {
        try {
            return execFileSync("git", ["-c", "core.fsmonitor=", ...args], {
                cwd,
                encoding: "utf8",
                timeout: 3000,
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
            }).trim();
        }
        catch {
            return null;
        }
    };
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true")
        return null;
    // `--show-current` is empty on a detached HEAD, so we never record the
    // literal "HEAD" as a branch name.
    const branch = git(["branch", "--show-current"]);
    const commit = git(["rev-parse", "--short", "HEAD"]);
    const status = git(["status", "--porcelain"]);
    const state = {};
    if (branch)
        state.branch = branch;
    if (commit)
        state.commit = commit;
    if (status !== null)
        state.dirty = status.length > 0;
    return state.branch || state.commit || state.dirty !== undefined
        ? state
        : null;
}
/** Human-readable one-line description, e.g. `main @ a1b2c3d (dirty)`. */
export function formatGitState(g) {
    const parts = [];
    if (g.branch)
        parts.push(g.branch);
    if (g.commit)
        parts.push(`@ ${g.commit}`);
    let s = parts.join(" ") || "(unknown)";
    if (g.dirty)
        s += " (dirty)";
    return s;
}
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
export function gitMismatchWarning(source, current) {
    if (!source)
        return null;
    if (!current) {
        return (`Could not verify the current workspace git state (source was ` +
            `${formatGitState(source)}). Re-read files before editing — historical ` +
            `tool outputs may not match disk.`);
    }
    const commitDiffers = !!source.commit && !!current.commit && source.commit !== current.commit;
    const dirtyDiffers = source.dirty !== undefined &&
        current.dirty !== undefined &&
        source.dirty !== current.dirty;
    if (!commitDiffers && !dirtyDiffers)
        return null;
    return (`Workspace moved since capture: source was ${formatGitState(source)}, ` +
        `current is ${formatGitState(current)}. Re-read files before editing — ` +
        `historical tool outputs may not match disk.`);
}
//# sourceMappingURL=git.js.map