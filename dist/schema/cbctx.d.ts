/**
 * Canonical context package — `.cbctx` v1.
 *
 * The portable artifact that travels between machines. A `can-bridge share`
 * produces one of these; a `can-bridge import` consumes one. Inside the
 * package: the normalized conversation, optional repo reference, what
 * was redacted, and a doctor verdict captured at share time.
 *
 * Pure types + a single `isCbctxPackage()` guard. No I/O.
 */
import type { NormalizedMessage } from "./context.js";
/** Stable schema id. Bump when we make a breaking change. */
export declare const CBCTX_SCHEMA_V1: "can-bridge.context.v1";
export type CbctxSchemaV1 = typeof CBCTX_SCHEMA_V1;
export interface CbctxPackage {
    schema: CbctxSchemaV1;
    /** Where the conversation came from. Mirrors NormalizedContext.source. */
    source: {
        tool: string;
        sessionId?: string;
        cwd?: string;
        capturedAt?: string;
        model?: string;
    };
    /** Repo reference so the receiver can `git checkout` the right state. */
    repo?: CbctxRepoRef;
    /** Optional summary of the conversation, when present. */
    summary?: string;
    /** Normalized conversation, ready to inject into any TargetAdapter. */
    messages: NormalizedMessage[];
    /** What --redact stripped, surfaced so the receiver can audit. */
    redaction: CbctxRedactionInfo;
    /**
     * Doctor verdict captured at share time. Receiver can re-run doctor
     * on import; embedding the producer's view helps diagnose drift.
     */
    doctor?: CbctxDoctorSnapshot;
    /** ISO 8601 — when the package was produced. */
    createdAt: string;
    /** can-bridge version that produced this package. */
    harnessVersion: string;
    /**
     * sha256 over canonical(source + summary + messages). Optional because
     * v0.2 packages produced before the field was added do not have it.
     * When present, importers verify it before injection.
     */
    contentHash?: string;
}
export interface CbctxRepoRef {
    remote?: string;
    branch?: string;
    commit?: string;
    /** True iff `patch` is non-empty. */
    dirtyPatchIncluded: boolean;
    /** Output of `git diff` when `--include-patch` was set; otherwise omitted. */
    patch?: string;
}
export interface CbctxRedactionInfo {
    /** Whether --redact was applied during share. */
    enabled: boolean;
    /** Per-kind counts ([{kind:"openai-key",count:2}, ...]). */
    findings: Array<{
        kind: string;
        count: number;
    }>;
}
export interface CbctxDoctorSnapshot {
    status: "ok" | "warn" | "fail";
    score: number;
    findings: Array<{
        level: "error" | "warn" | "info";
        code: string;
        message: string;
    }>;
}
/**
 * Compute the canonical sha256 content hash over a package's
 * source + summary + messages. Used by the importer to detect tampering
 * or accidental corruption in transit. Implemented without external
 * deps so importers running offline still work.
 */
export declare function computeCbctxContentHash(pkg: Pick<CbctxPackage, "source" | "summary" | "messages">): string;
/**
 * Structural guard for an unknown JSON blob. Returns true only if the
 * minimum-required v1 fields are present and have the expected shape.
 * Does NOT validate every nested message — adapters do that downstream.
 */
export declare function isCbctxPackage(v: unknown): v is CbctxPackage;
