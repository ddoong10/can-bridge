import { promises as fs } from "node:fs";
import path from "node:path";
import { isCbctxPackage, computeCbctxContentHash, computeNativeContentHash, } from "../schema/cbctx.js";
import { applyContextBudget, } from "../transform/budget.js";
import { redactContext } from "../transform/redactor.js";
import { diagnoseSessionFromContext } from "../doctor/session-doctor.js";
export async function readPackage(filePath) {
    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Invalid .cbctx (not valid JSON): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isCbctxPackage(parsed)) {
        throw new Error(`Invalid .cbctx — schema check failed (expected can-bridge.context.v1)`);
    }
    return parsed;
}
/** Convert a CbctxPackage back into a NormalizedContext for the inject step. */
export function packageToContext(pkg, opts = {}) {
    // Restore the native artifact (when present and intact) so a same-tool
    // inject replays the original session verbatim. Untrusted data: only used
    // when its tool matches the source AND its hash verifies; otherwise we
    // silently fall back to the normalized `messages`.
    const raw = opts.useNative === false ? null : restoreNativeRaw(pkg);
    return {
        schemaVersion: "0.1",
        source: pkg.source,
        summary: pkg.summary,
        messages: pkg.messages,
        ...(raw ? { raw } : {}),
        metadata: {
            cbctxRepo: pkg.repo,
            cbctxRedaction: pkg.redaction,
            cbctxDoctor: pkg.doctor,
            cbctxCreatedAt: pkg.createdAt,
            cbctxHarnessVersion: pkg.harnessVersion,
        },
    };
}
function restoreNativeRaw(pkg) {
    const artifacts = pkg.native;
    if (!artifacts || artifacts.length === 0)
        return null;
    const a = artifacts.find((x) => x.tool === pkg.source.tool);
    if (!a || typeof a.content !== "string")
        return null;
    // Treat native as untrusted: ignore it if the embedded hash doesn't verify.
    if (computeNativeContentHash(a.content) !== a.contentHash)
        return null;
    const lines = a.content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0)
        return null;
    return { tool: a.tool, lines };
}
/**
 * Read package, optionally re-redact, run preflight doctor, then inject.
 * Returns both the InjectionResult and a friendly summary the caller
 * (CLI) can print before/after.
 */
export async function importPackage(filePath, target, opts = {}) {
    const pkg = await readPackage(filePath);
    let hashStatus = "missing";
    if (typeof pkg.contentHash === "string" && pkg.contentHash.length > 0) {
        if (opts.skipHashVerify) {
            hashStatus = "skipped";
        }
        else {
            const expected = pkg.contentHash;
            const actual = computeCbctxContentHash({
                source: pkg.source,
                summary: pkg.summary,
                messages: pkg.messages,
            });
            if (expected !== actual) {
                throw new Error(`Package contentHash mismatch — file may be tampered or corrupted.\n` +
                    `  expected: ${expected}\n` +
                    `  actual:   ${actual}\n` +
                    `Override with --skip-hash-verify ONLY if you trust the source.`);
            }
            hashStatus = "ok";
        }
    }
    else if (opts.skipHashVerify) {
        hashStatus = "missing";
    }
    else {
        throw new Error(`Package contentHash missing — integrity cannot be verified.\n` +
            `Override with --skip-hash-verify ONLY if this is a trusted legacy package.`);
    }
    let ctx = packageToContext(pkg);
    const budgetOptions = resolveImportBudgetOptions(opts);
    const budgeted = applyContextBudget(ctx, budgetOptions);
    ctx = budgeted.context;
    // Re-bucket the conversation under the receiver's cwd so target
    // adapters (Claude Code in particular, which keys session files by
    // <encoded-cwd>) drop it into the right project folder. Stash the
    // sender's cwd in metadata so receivers can still see where it came
    // from.
    if (!opts.keepSourceCwd) {
        const receiverCwd = opts.receiverCwd ?? process.cwd();
        if (receiverCwd && ctx.source.cwd !== receiverCwd) {
            ctx = {
                ...ctx,
                source: { ...ctx.source, cwd: receiverCwd },
                metadata: {
                    ...(ctx.metadata ?? {}),
                    originalCwd: ctx.source.cwd,
                },
            };
        }
    }
    if (opts.redactAdditional) {
        ctx = redactContext(ctx);
    }
    const summary = {
        source: pkg.source,
        repo: pkg.repo,
        redaction: pkg.redaction,
        doctor: pkg.doctor,
        budget: pkg.budget,
        importBudget: shouldReportImportBudget(budgeted.stats)
            ? budgeted.stats
            : undefined,
        messageCount: pkg.messages.length,
        hashStatus,
    };
    if (!opts.skipDoctor) {
        try {
            const dr = await diagnoseSessionFromContext(ctx);
            summary.preflightStatus = dr.status;
            summary.preflightScore = dr.score;
            if (dr.status === "fail") {
                throw new Error(`Doctor preflight failed (${dr.score}/100). Run with --skip-doctor to override. Findings: ${dr.findings
                    .filter((f) => f.level === "error")
                    .map((f) => f.code)
                    .join(", ")}`);
            }
        }
        catch (err) {
            // diagnoseSessionFromContext throws on hard errors; rethrow.
            // Soft warn-status above just records and proceeds.
            if (err instanceof Error && err.message.startsWith("Doctor preflight failed"))
                throw err;
            // Otherwise: doctor crashed unrelated; proceed without preflight.
        }
    }
    const result = await target.inject(ctx);
    return { result, summary };
}
export function formatImportSummary(s) {
    const lines = [];
    lines.push(`Originally from ${s.source.tool}` +
        (s.source.model ? ` (${s.source.model})` : "") +
        `, ${s.messageCount} messages.`);
    if (s.source.sessionId)
        lines.push(`  Original session: ${s.source.sessionId}`);
    if (s.source.cwd)
        lines.push(`  Original cwd: ${s.source.cwd}`);
    if (s.repo?.remote) {
        lines.push(`  Repo: ${s.repo.remote}` +
            (s.repo.branch ? ` (branch ${s.repo.branch})` : "") +
            (s.repo.commit ? ` @ ${s.repo.commit.slice(0, 12)}` : "") +
            (s.repo.dirtyPatchIncluded ? " — patch included" : ""));
    }
    if (s.redaction.enabled) {
        const k = s.redaction.findings
            .map((f) => `${f.kind}:${f.count}`)
            .join(", ");
        lines.push(`  Redacted: ${k || "none observed"}`);
    }
    else {
        lines.push(`  Redacted: no (was not requested at share time)`);
    }
    if (s.doctor) {
        lines.push(`  Doctor (at share time): ${s.doctor.status} ${s.doctor.score}/100`);
    }
    if (s.budget) {
        lines.push(`  Package budget: ${s.budget.mode}` +
            (s.budget.sinceCompact ? " since-compact" : "") +
            (s.budget.truncatedToolOutputs > 0
                ? `, truncated ${s.budget.truncatedToolOutputs} tool outputs`
                : "") +
            (s.budget.nativeIncluded ? "" : ", no native artifact"));
    }
    if (s.importBudget) {
        lines.push(`  Import budget: ` +
            (s.importBudget.sinceCompact ? "since-compact, " : "") +
            (s.importBudget.truncatedToolOutputs > 0
                ? `truncated ${s.importBudget.truncatedToolOutputs} tool outputs, `
                : "") +
            (s.importBudget.nativeIncluded ? "native on" : "native off"));
    }
    if (s.preflightStatus) {
        lines.push(`  Doctor (preflight on import): ${s.preflightStatus} ${s.preflightScore}/100`);
    }
    if (s.hashStatus) {
        const note = s.hashStatus === "ok"
            ? "verified"
            : s.hashStatus === "skipped"
                ? "skipped (--skip-hash-verify)"
                : "missing (legacy package — cannot verify integrity)";
        lines.push(`  Content hash: ${note}`);
    }
    return lines.join("\n") + "\n";
}
function resolveImportBudgetOptions(opts) {
    const mode = opts.contextMode ?? "full";
    return {
        includeNative: opts.useNative ?? (mode === "slim" ? false : true),
        sinceCompact: opts.sinceCompact ?? mode === "slim",
        maxToolOutputChars: opts.maxToolOutputChars ?? (mode === "slim" ? 8000 : undefined),
    };
}
function shouldReportImportBudget(stats) {
    return (stats.sinceCompact ||
        stats.droppedMessages > 0 ||
        stats.droppedRawLines > 0 ||
        stats.truncatedToolOutputs > 0 ||
        !stats.nativeIncluded);
}
//# sourceMappingURL=import.js.map