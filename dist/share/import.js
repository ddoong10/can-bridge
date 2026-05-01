import { promises as fs } from "node:fs";
import path from "node:path";
import { isCbctxPackage } from "../schema/cbctx.js";
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
export function packageToContext(pkg) {
    return {
        schemaVersion: "0.1",
        source: pkg.source,
        summary: pkg.summary,
        messages: pkg.messages,
        metadata: {
            cbctxRepo: pkg.repo,
            cbctxRedaction: pkg.redaction,
            cbctxDoctor: pkg.doctor,
            cbctxCreatedAt: pkg.createdAt,
            cbctxHarnessVersion: pkg.harnessVersion,
        },
    };
}
/**
 * Read package, optionally re-redact, run preflight doctor, then inject.
 * Returns both the InjectionResult and a friendly summary the caller
 * (CLI) can print before/after.
 */
export async function importPackage(filePath, target, opts = {}) {
    const pkg = await readPackage(filePath);
    let ctx = packageToContext(pkg);
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
        messageCount: pkg.messages.length,
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
    if (s.preflightStatus) {
        lines.push(`  Doctor (preflight on import): ${s.preflightStatus} ${s.preflightScore}/100`);
    }
    return lines.join("\n") + "\n";
}
//# sourceMappingURL=import.js.map