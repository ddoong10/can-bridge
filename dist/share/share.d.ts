import type { NormalizedContext } from "../schema/context.js";
import type { CbctxPackage, CbctxRedactionInfo } from "../schema/cbctx.js";
export interface BuildPackageOptions {
    redact?: boolean;
    includeRepoRef?: boolean;
    includePatch?: boolean;
    /** Working directory to inspect for git metadata. Defaults to source.cwd. */
    repoCwd?: string;
}
export interface BuildPackageResult {
    pkg: CbctxPackage;
    redaction: CbctxRedactionInfo;
}
/**
 * Pure(ish) builder: takes an extracted NormalizedContext and produces a
 * CbctxPackage. The only I/O it does is shelling out to `git` when
 * includeRepoRef/includePatch are set; that is opt-in.
 */
export declare function buildPackage(ctx: NormalizedContext, opts?: BuildPackageOptions): Promise<BuildPackageResult>;
/**
 * Write a CbctxPackage to disk. Returns the absolute path written.
 * If outPath is "-" the JSON is written to stdout and the empty string is
 * returned.
 */
export declare function writePackage(pkg: CbctxPackage, outPath: string): Promise<string>;
/** Default file name based on session id and date. */
export declare function defaultPackageName(sessionId: string | undefined): string;
