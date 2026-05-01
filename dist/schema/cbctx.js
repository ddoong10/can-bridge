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
import { createHash } from "node:crypto";
/** Stable schema id. Bump when we make a breaking change. */
export const CBCTX_SCHEMA_V1 = "can-bridge.context.v1";
/**
 * Compute the canonical sha256 content hash over a package's
 * source + summary + messages. Used by the importer to detect tampering
 * or accidental corruption in transit. Implemented without external
 * deps so importers running offline still work.
 */
export function computeCbctxContentHash(pkg) {
    const canonical = canonicalJSON({
        source: pkg.source,
        summary: pkg.summary,
        messages: pkg.messages,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}
/**
 * Recursive key-sort canonicalization. Mirrors JSON.stringify's "drop
 * undefined values" rule so a producer that hashes `{x: undefined}` gets
 * the same digest as a consumer that round-tripped the package through
 * disk (where undefined keys disappear).
 */
function canonicalJSON(value) {
    if (value === undefined)
        return "null";
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return ("[" +
            value
                .map((v) => (v === undefined ? "null" : canonicalJSON(v)))
                .join(",") +
            "]");
    }
    const obj = value;
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
    return ("{" +
        keys
            .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
            .join(",") +
        "}");
}
/**
 * Structural guard for an unknown JSON blob. Returns true only if the
 * minimum-required v1 fields are present and have the expected shape.
 * Does NOT validate every nested message — adapters do that downstream.
 */
export function isCbctxPackage(v) {
    if (!v || typeof v !== "object")
        return false;
    const o = v;
    if (o.schema !== CBCTX_SCHEMA_V1)
        return false;
    if (!o.source || typeof o.source !== "object")
        return false;
    const s = o.source;
    if (typeof s.tool !== "string" || s.tool.length === 0)
        return false;
    if (!Array.isArray(o.messages))
        return false;
    if (!o.redaction || typeof o.redaction !== "object")
        return false;
    const r = o.redaction;
    if (typeof r.enabled !== "boolean")
        return false;
    if (!Array.isArray(r.findings))
        return false;
    if (typeof o.createdAt !== "string")
        return false;
    if (typeof o.harnessVersion !== "string")
        return false;
    return true;
}
//# sourceMappingURL=cbctx.js.map