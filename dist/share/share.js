import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CBCTX_SCHEMA_V1 } from "../schema/cbctx.js";
import { redactContext } from "../transform/redactor.js";
import { diagnoseSessionFromContext } from "../doctor/session-doctor.js";
const execFileAsync = promisify(execFile);
const HARNESS_VERSION = "0.2.0";
/**
 * Pure(ish) builder: takes an extracted NormalizedContext and produces a
 * CbctxPackage. The only I/O it does is shelling out to `git` when
 * includeRepoRef/includePatch are set; that is opt-in.
 */
export async function buildPackage(ctx, opts = {}) {
    let working = ctx;
    let redaction = { enabled: false, findings: [] };
    if (opts.redact) {
        const before = countSecretCandidates(ctx);
        working = redactContext(ctx);
        const after = countSecretCandidates(working);
        redaction = {
            enabled: true,
            findings: diffFindings(before, after),
        };
    }
    let repo;
    if (opts.includeRepoRef || opts.includePatch) {
        const cwd = opts.repoCwd ?? working.source.cwd;
        if (cwd) {
            repo = await collectRepoRef(cwd, opts.includePatch === true);
        }
    }
    const doctor = await snapshotDoctor(working);
    const pkg = {
        schema: CBCTX_SCHEMA_V1,
        source: {
            tool: working.source.tool,
            sessionId: working.source.sessionId,
            cwd: working.source.cwd,
            capturedAt: working.source.capturedAt,
            model: working.source.model,
        },
        ...(repo ? { repo } : {}),
        ...(working.summary ? { summary: working.summary } : {}),
        messages: working.messages,
        redaction,
        ...(doctor ? { doctor } : {}),
        createdAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
    };
    return { pkg, redaction };
}
/**
 * Write a CbctxPackage to disk. Returns the absolute path written.
 * If outPath is "-" the JSON is written to stdout and the empty string is
 * returned.
 */
export async function writePackage(pkg, outPath) {
    const json = JSON.stringify(pkg, null, 2);
    if (outPath === "-" || outPath === "/dev/stdout") {
        process.stdout.write(json + "\n");
        return "";
    }
    const abs = path.resolve(outPath);
    await fs.writeFile(abs, json + "\n", "utf8");
    return abs;
}
/** Default file name based on session id and date. */
export function defaultPackageName(sessionId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = sessionId ? sessionId.slice(0, 8) : "session";
    return `can-bridge-${id}-${stamp}.cbctx`;
}
// ─── helpers ─────────────────────────────────────────────────────────
async function collectRepoRef(cwd, includePatch) {
    const repo = { dirtyPatchIncluded: false };
    const tryGit = async (args) => {
        try {
            const { stdout } = await execFileAsync("git", args, { cwd });
            return stdout.trim();
        }
        catch {
            return null;
        }
    };
    const inside = await tryGit(["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true")
        return undefined;
    const remote = await tryGit(["remote", "get-url", "origin"]);
    if (remote)
        repo.remote = remote;
    const branch = await tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch)
        repo.branch = branch;
    const commit = await tryGit(["rev-parse", "HEAD"]);
    if (commit)
        repo.commit = commit;
    if (includePatch) {
        const patch = await tryGit(["diff", "--no-color"]);
        if (patch && patch.length > 0) {
            repo.patch = patch;
            repo.dirtyPatchIncluded = true;
        }
    }
    return repo;
}
async function snapshotDoctor(ctx) {
    try {
        const r = await diagnoseSessionFromContext(ctx);
        return {
            status: r.status,
            score: r.score,
            findings: r.findings.map((f) => ({
                level: f.level,
                code: f.code,
                message: f.message,
            })),
        };
    }
    catch {
        // doctor is best-effort; do not block share if it can't run.
        return undefined;
    }
}
/**
 * Heuristic count of plausible secret tokens BEFORE redaction, so we can
 * report a per-kind diff after redaction. We re-use the same patterns as
 * the redactor by counting [REDACTED:<kind>] markers in the redacted text.
 */
function countSecretCandidates(ctx) {
    const counts = new Map();
    const all = serialize(ctx);
    for (const m of all.matchAll(/\[REDACTED:([^\]]+)\]/g)) {
        const kind = m[1];
        if (!kind)
            continue;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
}
function diffFindings(before, after) {
    // Findings are the markers present AFTER redaction (= what was masked).
    const out = [];
    const seen = new Set();
    for (const [kind, count] of after) {
        const delta = count - (before.get(kind) ?? 0);
        if (delta > 0)
            out.push({ kind, count: delta });
        seen.add(kind);
    }
    out.sort((a, b) => a.kind.localeCompare(b.kind));
    return out;
}
function serialize(ctx) {
    const parts = [];
    if (ctx.summary)
        parts.push(ctx.summary);
    for (const m of ctx.messages) {
        for (const b of m.content) {
            if (b.type === "text" || b.type === "thinking")
                parts.push(b.text);
            else if (b.type === "tool_result")
                parts.push(b.output);
            else if (b.type === "tool_use")
                parts.push(JSON.stringify(b.input));
        }
    }
    return parts.join("\n");
}
//# sourceMappingURL=share.js.map