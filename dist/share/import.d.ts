import type { TargetAdapter, InjectionResult } from "../adapters/base.js";
import type { NormalizedContext } from "../schema/context.js";
import type { CbctxPackage } from "../schema/cbctx.js";
export interface ImportPackageOptions {
    skipDoctor?: boolean;
    redactAdditional?: boolean;
    /**
     * The cwd the receiver wants the new session attached to. Defaults to
     * `process.cwd()` because target adapters (Claude Code) bucket sessions
     * by cwd, and the sender's path won't exist on the receiver's machine.
     */
    receiverCwd?: string;
    /**
     * Keep the sender's original cwd in source.cwd. Off by default —
     * useful for archival/debugging when no inject is happening.
     */
    keepSourceCwd?: boolean;
    /**
     * Skip the contentHash check. Off by default — kept for fallback when
     * importing a legacy package that pre-dates the field.
     */
    skipHashVerify?: boolean;
}
export interface ImportSummary {
    source: CbctxPackage["source"];
    repo?: CbctxPackage["repo"];
    redaction: CbctxPackage["redaction"];
    doctor?: CbctxPackage["doctor"];
    messageCount: number;
    preflightStatus?: "ok" | "warn" | "fail";
    preflightScore?: number;
    /** "ok" — hash present and matched; "skipped" — caller opted out;
     *  "missing" — package has no hash (legacy v0.2 package). */
    hashStatus?: "ok" | "skipped" | "missing";
}
export declare function readPackage(filePath: string): Promise<CbctxPackage>;
/** Convert a CbctxPackage back into a NormalizedContext for the inject step. */
export declare function packageToContext(pkg: CbctxPackage): NormalizedContext;
/**
 * Read package, optionally re-redact, run preflight doctor, then inject.
 * Returns both the InjectionResult and a friendly summary the caller
 * (CLI) can print before/after.
 */
export declare function importPackage(filePath: string, target: TargetAdapter, opts?: ImportPackageOptions): Promise<{
    result: InjectionResult;
    summary: ImportSummary;
}>;
export declare function formatImportSummary(s: ImportSummary): string;
