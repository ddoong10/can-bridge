import type { NormalizedContext } from "../schema/context.js";
type FormatId = "claude-code" | "codex" | "unknown";
type FindingLevel = "error" | "warn" | "info";
export interface DoctorOptions {
    from?: string;
}
export interface DoctorFinding {
    level: FindingLevel;
    code: string;
    message: string;
    line?: number;
}
export interface DoctorResult {
    filePath: string;
    expectedFormat?: FormatId;
    detectedFormat: FormatId;
    status: "ok" | "warn" | "fail";
    score: number;
    lineCount: number;
    parsedLineCount: number;
    findings: DoctorFinding[];
}
export declare function diagnoseSession(locator: string, options?: DoctorOptions): Promise<DoctorResult>;
/**
 * Lightweight, in-memory variant of {@link diagnoseSession} for callers
 * that already have a `NormalizedContext` (e.g. share/import). Validates
 * structural invariants of messages/blocks instead of raw JSONL.
 */
export declare function diagnoseSessionFromContext(ctx: NormalizedContext): Promise<DoctorResult>;
export declare function formatDoctorResult(result: DoctorResult): string;
export {};
